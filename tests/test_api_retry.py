"""Retry / backoff / error-classification behaviour of the HTTP transport."""

from __future__ import annotations

import pytest
import requests

from telemetry.api import UpstreamClient, is_auth_required
from telemetry.exceptions import (
    AuthExpiredError,
    AuthRejectedError,
    RetryableUpstreamError,
    UpstreamClientError,
    UpstreamError,
)


class RecordingClient(UpstreamClient):
    """UpstreamClient with sleeping removed and delays captured."""

    def __init__(self, settings) -> None:
        super().__init__(settings)
        self.delays: list[float] = []
        self.sleeper = self.delays.append  # no real sleeping in tests


@pytest.fixture
def client(settings) -> RecordingClient:
    return RecordingClient(settings)


def token(settings, mock_api) -> str:
    return UpstreamClient(settings).request_token()["token"]


# ---------------------------------------------------------------- 5xx retry
def test_500_is_retried_with_exponential_backoff(client, mock_api, settings):
    mock_api.reset()
    mock_api.control("/__control/fail?count=2")  # two 500s, then a real payload
    tok = token(settings, mock_api)

    payload = client.fetch_vehicles(tok)

    assert payload["ok"] is True
    assert len(client.delays) == 2, "exactly two retries for two failures"
    assert mock_api.stats()["counts"]["data_500"] == 2
    # full jitter: delay n is bounded by base * 2**n
    assert client.delays[0] <= settings.backoff_base_seconds
    assert client.delays[1] <= settings.backoff_base_seconds * 2


def test_gives_up_after_max_retries_and_raises_retryable(client, settings, mock_api):
    mock_api.reset()
    mock_api.control(f"/__control/fail?count={settings.http_max_retries + 5}")
    tok = token(settings, mock_api)

    with pytest.raises(RetryableUpstreamError) as exc:
        client.fetch_vehicles(tok)

    assert len(client.delays) == settings.http_max_retries
    assert exc.value.status_code == 500
    assert mock_api.stats()["counts"]["data_500"] == settings.http_max_retries + 1


def test_backoff_is_capped(client, settings, mock_api):
    """With many retries the delay must never exceed BACKOFF_MAX_SECONDS."""
    mock_api.reset()
    mock_api.control("/__control/fail?count=3")
    settings.backoff_base_seconds = 1.0
    settings.backoff_max_seconds = 2.0
    tok = token(settings, mock_api)
    client.fetch_vehicles(tok)
    assert all(delay <= 2.0 for delay in client.delays), client.delays


# ------------------------------------------------------------ transport errors
def test_connection_errors_are_retried_then_raise_retryable(settings):
    client = RecordingClient(settings)
    attempts = {"n": 0}

    class Boom:
        def request(self, *args, **kwargs):
            attempts["n"] += 1
            raise requests.exceptions.ConnectionError("connection reset by peer")

    client.session = Boom()  # type: ignore[assignment]

    with pytest.raises(RetryableUpstreamError, match="ConnectionError"):
        client.fetch_vehicles("any-token")
    assert attempts["n"] == settings.http_max_retries + 1


def test_timeout_is_retried(settings):
    client = RecordingClient(settings)
    attempts = {"n": 0}

    class Slow:
        def request(self, *args, **kwargs):
            attempts["n"] += 1
            if attempts["n"] < 3:
                raise requests.exceptions.Timeout("read timed out")

            class Resp:
                status_code = 200

                def json(self):
                    return {"ok": True, "vehicles": {}}

                text = "{}"

            return Resp()

    client.session = Slow()  # type: ignore[assignment]
    assert client.fetch_vehicles("tok")["ok"] is True
    assert attempts["n"] == 3


# ------------------------------------------------------------------- 4xx
def test_400_is_not_retried(client, settings, mock_api):
    """A bad `date` is our bug; retrying cannot fix it."""
    mock_api.reset()
    settings.api_date = "21-08-2026"  # wrong format
    tok = token(settings, mock_api)

    with pytest.raises(UpstreamClientError) as exc:
        client.fetch_vehicles(tok)
    assert exc.value.status_code == 400
    assert client.delays == []


def test_non_json_body_raises_upstream_error(settings):
    client = RecordingClient(settings)

    class Html:
        def request(self, *args, **kwargs):
            class Resp:
                status_code = 200
                text = "<html>proxy error page</html>"

                def json(self):
                    raise ValueError("not json")

            return Resp()

    client.session = Html()  # type: ignore[assignment]
    with pytest.raises(UpstreamError, match="not JSON"):
        client.fetch_vehicles("tok")


def test_ok_false_is_an_error(settings):
    client = RecordingClient(settings)

    class Sad:
        def request(self, *args, **kwargs):
            class Resp:
                status_code = 200
                text = '{"ok": false, "error": "nope"}'

                def json(self):
                    return {"ok": False, "error": "nope"}

            return Resp()

    client.session = Sad()  # type: ignore[assignment]
    with pytest.raises(UpstreamError, match="ok=false"):
        client.fetch_vehicles("tok")


# ------------------------------------------------------------------ 401s
def test_expired_token_raises_auth_expired(client, settings, mock_api):
    mock_api.reset()
    with pytest.raises(AuthExpiredError):
        client.fetch_vehicles("0" * 128)  # never issued


def test_bad_credentials_raise_auth_rejected_not_expired(settings, mock_api):
    """Distinguishing these matters: one is retryable, the other can get the
    client disabled if we keep hammering it."""
    mock_api.reset()
    settings.api_passcode = "wrong-passcode"
    with pytest.raises(AuthRejectedError):
        UpstreamClient(settings).request_token()


def test_disabled_client_mid_run_raises_auth_rejected(client, settings, mock_api):
    mock_api.reset()
    mock_api.control("/__control/bad-creds?on=1")
    with pytest.raises(AuthRejectedError):
        client.request_token()
    mock_api.control("/__control/bad-creds?on=0")


def test_is_auth_required_matches_the_documented_shape():
    class Resp:
        status_code = 401

        def json(self):
            return {"ok": False, "auth": "required"}

    assert is_auth_required(Resp()) is True

    class Other:
        status_code = 401

        def json(self):
            return {"ok": False, "error": "nope"}

    # No marker -> False.  The data endpoint still classifies any 401 as an
    # expired token (see test_expired_token_raises_auth_expired); this helper
    # only reports whether the documented marker was present.
    assert is_auth_required(Other()) is False

    class Not401:
        status_code = 403

        def json(self):
            return {"auth": "required"}

    assert is_auth_required(Not401()) is False


def test_data_endpoint_401_without_marker_is_still_an_expiry(settings):
    """A 401 on /api/v1/vehicles means the token, never the credentials:
    the credentials were already accepted when the token was minted."""
    client = RecordingClient(settings)

    class Bare401:
        def request(self, *args, **kwargs):
            class Resp:
                status_code = 401
                text = '{"ok": false, "error": "nope"}'

                def json(self):
                    return {"ok": False, "error": "nope"}

            return Resp()

    client.session = Bare401()  # type: ignore[assignment]
    with pytest.raises(AuthExpiredError):
        client.fetch_vehicles("tok")


# --------------------------------------------------------------- query params
def test_date_and_vehicle_filters_are_sent(settings, mock_api):
    mock_api.reset()
    settings.api_date = "2026-08-21"
    settings.api_vehicle_filter = "AP39WG"
    client = UpstreamClient(settings)
    tok = token(settings, mock_api)
    payload = client.fetch_vehicles(tok)
    assert payload["ok"] is True
    assert all("AP39WG" in vid for vid in payload["vehicles"])


def test_credentials_never_appear_in_the_vehicles_query(settings, mock_api):
    client = UpstreamClient(settings)
    assert client._query_params() == {}


# ----------------------------------------------------- endpoint migration
def test_data_endpoint_is_the_v1_vehicles_route(settings):
    """The engine must address /api/v1/vehicles, never the retired route."""
    assert settings.vehicles_path == "/api/v1/vehicles"
    assert settings.vehicles_url().endswith("/api/v1/vehicles")
    assert "dashboard-parameters" not in settings.vehicles_url()


def test_vehicles_request_url_carries_the_filters_and_no_credentials(settings, mock_api):
    settings.api_date = "2026-08-28"
    settings.api_vehicle_filter = "AP39WG"
    url = UpstreamClient(settings).vehicles_request_url()
    assert url.endswith("/api/v1/vehicles?date=2026-08-28&vehicle=AP39WG")
    assert settings.api_secret_key not in url
    assert settings.api_passcode not in url


def test_legacy_dashboard_endpoint_is_gone(client, mock_api, settings):
    """/api/dashboard-parameters is retired: the mock answers 410, which the
    transport classifies as a non-retryable client error rather than silently
    falling back."""
    mock_api.reset()
    tok = token(settings, mock_api)
    legacy = f"{settings.api_base_url}/api/dashboard-parameters"

    with pytest.raises(UpstreamClientError) as exc:
        client._request(
            "GET", legacy, headers={"Authorization": f"Bearer {tok}"},
            label="legacy", endpoint="vehicles",
        )

    assert exc.value.status_code == 410
    assert not client.delays, "a 410 must never be retried"


def test_default_base_url_is_the_blue_energy_upstream():
    """Out of the box the engine targets the verified production host."""
    from telemetry.config import Settings

    defaults = Settings(_env_file=None)
    assert defaults.api_base_url == "https://track.blueenergymotors.com"
    assert defaults.vehicles_url() == "https://track.blueenergymotors.com/api/v1/vehicles"
