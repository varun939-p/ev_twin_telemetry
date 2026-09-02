"""Bearer token lifecycle.

The upstream contract (guide §2, §5)
------------------------------------
* POST /api/auth/api-token returns `{"token": "...", "expires_in": 3540}`.
* 3540 s == 59 minutes. There is **no refresh endpoint** -- re-authenticating
  with secret_key + passcode *is* the refresh, and every token is a fresh
  opaque value.
* A 401 with `"auth": "required"` means the token died.

So the safe design is a *proactive* rotation, not a reactive one:

    refresh_at = obtained_at + min(TOKEN_REFRESH_INTERVAL,        # 3300 s = 55 min
                                   expires_in - SAFETY_MARGIN)     # 3540 - 240 = 3300 s

Both knobs land on 55 minutes with the default config, which leaves a 4-minute
buffer for clock skew, a slow request, and one retry cycle.  Because rotation
happens *between* polls and never mid-request, no poll can straddle the expiry
boundary -- which is how data gets dropped in the naive "retry on 401" design.

The reactive path (401 -> force re-auth -> retry once) is kept as a backstop for
clock skew and for the admin "toggle" endpoint, which revokes outstanding tokens
immediately.
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass
from typing import Callable, Protocol

from .config import Settings
from .exceptions import AuthExpiredError, AuthRejectedError
from .schemas import AuthResponse

log = logging.getLogger(__name__)


class TokenSource(Protocol):
    def request_token(self) -> dict: ...


@dataclass(slots=True)
class TokenState:
    token: str
    obtained_at: float          # monotonic
    expires_in: float           # seconds, as reported by the server
    refresh_at: float           # monotonic deadline for proactive rotation
    issued_at: float            # wall clock, for logs

    def seconds_until_refresh(self, now: float) -> float:
        return max(0.0, self.refresh_at - now)

    @property
    def fingerprint(self) -> str:
        """Safe-to-log identity: never log a full token."""
        return f"{self.token[:6]}…{self.token[-4:]}(len={len(self.token)})"


class TokenManager:
    """Thread-safe token cache with proactive 55-minute rotation."""

    def __init__(
        self,
        settings: Settings,
        source: TokenSource,
        *,
        clock: Callable[[], float] = time.monotonic,
        now_fn: Callable[[], float] = time.time,
    ) -> None:
        self.settings = settings
        self.source = source
        self._clock = clock
        self._now = now_fn
        self._state: TokenState | None = None
        self._lock = threading.Lock()
        self.auth_count = 0
        self.forced_refresh_count = 0

    # ------------------------------------------------------------------ API
    def get_token(self, *, force: bool = False) -> str:
        """Return a token that is valid right now, re-authenticating if needed.

        The lock is held across the network call on purpose: without it, N
        threads that all notice expiry at once would each mint a token.  The
        upstream never reuses tokens and does not say old ones are revoked by a
        new issuance -- but minting 5 tokens per rotation is still wasteful and
        makes the audit log unreadable.
        """
        with self._lock:
            if force:
                self.forced_refresh_count += 1
                log.info("forcing token rotation")
            elif self._state is not None:
                remaining = self._state.seconds_until_refresh(self._clock())
                if remaining > 0:
                    return self._state.token
                log.info(
                    "proactive token rotation (age %.0fs of %.0fs allowed)",
                    self._clock() - self._state.obtained_at,
                    self._state.refresh_at - self._state.obtained_at,
                )
            return self._fetch_locked().token

    def invalidate(self) -> None:
        """Drop the cached token (e.g. after a 401)."""
        with self._lock:
            self._state = None

    def describe(self) -> str:
        """One-line status for the start-up banner and /healthz."""
        with self._lock:
            if self._state is None:
                return "no token cached"
            return (
                f"token {self._state.fingerprint} "
                f"refresh in {self._state.seconds_until_refresh(self._clock()):.0f}s "
                f"(lifetime {self._state.expires_in:.0f}s, auths={self.auth_count})"
            )

    @property
    def lifetime_seconds(self) -> float:
        with self._lock:
            return self._state.expires_in if self._state else 0.0

    @property
    def seconds_until_refresh(self) -> float:
        """Rotation countdown, for metrics and the health endpoint."""
        with self._lock:
            return self._state.seconds_until_refresh(self._clock()) if self._state else 0.0

    # -------------------------------------------------------------- private
    def _fetch_locked(self) -> TokenState:
        raw = self.source.request_token()
        try:
            parsed = AuthResponse.model_validate(raw)
        except Exception as exc:  # pydantic.ValidationError & friends
            raise AuthRejectedError(f"auth response failed validation: {exc}") from exc

        now = self._clock()
        # Rotate at whichever comes first: the configured 55-minute interval, or
        # the server's own lifetime minus a safety margin.  If the server ever
        # shortens expires_in, we follow it automatically instead of drifting
        # past the expiry.
        interval = min(
            self.settings.token_refresh_interval,
            max(60.0, parsed.expires_in - self.settings.token_expiry_safety_margin),
        )
        state = TokenState(
            token=parsed.token,
            obtained_at=now,
            expires_in=float(parsed.expires_in),
            refresh_at=now + interval,
            issued_at=self._now(),
        )
        self._state = state
        self.auth_count += 1
        log.info(
            "authenticated: token %s valid %.0fs, next rotation in %.0fs (auth #%d)",
            state.fingerprint,
            state.expires_in,
            interval,
            self.auth_count,
        )
        return state


def run_with_reauth(
    tokens: TokenManager,
    call: Callable[[str], object],
    *,
    label: str = "request",
) -> object:
    """Execute `call(token)`, re-authenticating exactly once on an expired token.

    Bounded on purpose: if a *fresh* token is also rejected, the credentials are
    wrong or the client was disabled, and looping would hammer the auth endpoint
    until it blocks us.  That case raises `AuthRejectedError` and the orchestrator
    backs off for a long, loud pause.
    """
    try:
        return call(tokens.get_token())
    except AuthExpiredError as exc:
        log.warning("%s: %s -- re-authenticating and retrying once", label, exc)
        tokens.invalidate()
        try:
            return call(tokens.get_token(force=True))
        except AuthExpiredError as second:
            raise AuthRejectedError(
                f"{label}: a freshly minted token was rejected too; "
                f"check API_SECRET_KEY / API_PASSCODE, or whether the client was disabled"
            ) from second
