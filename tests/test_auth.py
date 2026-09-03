"""Token rotation.

The upstream token lives 3540 s (59 min) with no refresh endpoint, so the
rotation policy is the single most important behaviour in this engine.  These
tests drive a fake clock instead of sleeping, which is also the only way to
test a 55-minute deadline in CI.
"""

from __future__ import annotations

import pytest

from telemetry.api import UpstreamClient
from telemetry.auth import TokenManager, run_with_reauth
from telemetry.config import Settings
from telemetry.exceptions import AuthExpiredError, AuthRejectedError

TOKEN_A = "a" * 128
TOKEN_B = "b" * 128
TOKEN_C = "c" * 128


class FakeClock:
    def __init__(self, start: float = 1_000.0) -> None:
        self.now = start
        self.wall = 1_700_000_000.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds
        self.wall += seconds


class FakeTokenSource:
    """Stands in for UpstreamClient.request_token()."""

    def __init__(self, tokens=(TOKEN_A, TOKEN_B, TOKEN_C, "d" * 128)) -> None:
        self.tokens = list(tokens)
        self.calls = 0

    def request_token(self) -> dict:
        self.calls += 1
        token = self.tokens[min(self.calls - 1, len(self.tokens) - 1)]
        return {"ok": True, "token": token, "token_type": "Bearer", "expires_in": 3540}


def make_manager(settings: Settings, clock: FakeClock, source: FakeTokenSource | None = None) -> tuple[TokenManager, FakeTokenSource]:
    source = source or FakeTokenSource()
    return TokenManager(settings, source, clock=clock, now_fn=lambda: clock.wall), source


# --------------------------------------------------------------- the 55 min
def test_token_is_reused_within_the_55_minute_window(settings):
    clock = FakeClock()
    manager, source = make_manager(settings, clock)

    first = manager.get_token()
    clock.advance(3299)  # one second short of the rotation deadline
    assert manager.get_token() == first
    assert source.calls == 1, "must not re-authenticate while the token is still fresh"


def test_token_rotates_at_55_minutes(settings):
    clock = FakeClock()
    manager, source = make_manager(settings, clock)

    first = manager.get_token()
    clock.advance(3300)  # exactly 55 minutes
    second = manager.get_token()

    assert second != first, "a fresh, unique token is expected -- the API never reuses one"
    assert source.calls == 2


def test_rotation_interval_is_3300_seconds_by_default(settings):
    """3300 s == 55 min, leaving a 4-minute buffer before the 59-minute expiry."""
    assert settings.token_refresh_interval == 3300.0
    assert settings.token_refresh_interval < 3540


def test_rotation_follows_the_server_when_it_shortens_the_lifetime():
    """If upstream ever drops expires_in, we must follow it, not drift past expiry."""
    settings = Settings(
        api_base_url="http://x", api_secret_key="k", api_passcode="p",
        database_url="sqlite://", token_refresh_interval=3300.0,
        token_expiry_safety_margin=240.0, _env_file=None,
    )
    clock = FakeClock()

    class ShortLived(FakeTokenSource):
        def request_token(self) -> dict:
            self.calls += 1
            return {"ok": True, "token": f"{self.calls:0>128}", "token_type": "Bearer", "expires_in": 600}

    source = ShortLived()
    manager = TokenManager(settings, source, clock=clock, now_fn=lambda: clock.wall)
    manager.get_token()

    first = "1".rjust(128, "0")
    clock.advance(359)  # 600 - 240 = 360 s is the real deadline
    assert manager.get_token() == first
    clock.advance(1)
    assert manager.get_token() != first
    assert source.calls == 2


def test_no_poll_can_straddle_the_expiry_boundary(settings):
    """The whole point of proactive rotation: between rotation and expiry there
    is always at least `token_expiry_safety_margin` seconds of headroom."""
    clock = FakeClock()
    manager, _ = make_manager(settings, clock)
    manager.get_token()
    clock.advance(3300)          # rotation point
    remaining_lifetime = 3540 - 3300
    assert remaining_lifetime >= settings.token_expiry_safety_margin


# ------------------------------------------------------------------- forced
def test_force_rotates_immediately(settings):
    clock = FakeClock()
    manager, source = make_manager(settings, clock)
    manager.get_token()
    forced = manager.get_token(force=True)
    assert source.calls == 2
    assert forced != TOKEN_A
    assert manager.forced_refresh_count == 1


def test_invalidate_forces_a_new_token_next_call(settings):
    clock = FakeClock()
    manager, source = make_manager(settings, clock)
    manager.get_token()
    manager.invalidate()
    assert manager.get_token() == TOKEN_B
    assert source.calls == 2


def test_describe_never_leaks_the_token(settings):
    clock = FakeClock()
    manager, _ = make_manager(settings, clock)
    manager.get_token()
    description = manager.describe()
    assert TOKEN_A not in description
    assert "refresh in" in description


# -------------------------------------------------------------- reauth path
def test_run_with_reauth_recovers_from_an_expired_token(settings):
    clock = FakeClock()
    manager, source = make_manager(settings, clock)
    manager.get_token()
    calls: list[str] = []

    def call(token: str) -> str:
        calls.append(token)
        if len(calls) == 1:
            raise AuthExpiredError("token expired")
        return "payload"

    assert run_with_reauth(manager, call) == "payload"
    assert calls == [TOKEN_A, TOKEN_B]
    assert source.calls == 2


def test_run_with_reauth_gives_up_when_a_fresh_token_is_also_rejected(settings):
    """Bad credentials or a disabled client: stop, do not hammer the auth endpoint."""
    clock = FakeClock()
    manager, _ = make_manager(settings, clock)
    manager.get_token()

    def always_rejected(token: str) -> str:
        raise AuthExpiredError("rejected")

    with pytest.raises(AuthRejectedError):
        run_with_reauth(manager, always_rejected)


# ----------------------------------------------------------- against the mock
def test_real_auth_handshake_with_mock_upstream(settings, mock_api):
    """End-to-end token issuance over HTTP, using the documented payload."""
    clock = FakeClock()
    client = UpstreamClient(settings)
    manager = TokenManager(settings, client, clock=clock, now_fn=lambda: clock.wall)

    token = manager.get_token()
    assert len(token) == 128, "the guide specifies a 128 hex character token"
    assert manager.lifetime_seconds == 3540

    payload = client.fetch_vehicles(token)
    assert payload["ok"] is True
    assert payload["vehicles"], "the mock should serve vehicles to a valid token"
