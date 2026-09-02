"""Exception hierarchy for the upstream API.

The split that matters operationally:

    RetryableUpstreamError  transient (5xx / timeouts) -> back off and try again
    AuthExpiredError        token died early            -> re-auth, retry once
    AuthRejectedError       bad secret_key/passcode     -> STOP, page a human.
                            Retrying can only get the client disabled.
    UpstreamClientError     400/403/404                 -> stop, our request is wrong
"""

from __future__ import annotations


class TelemetryError(Exception):
    """Base class for everything this engine raises deliberately."""


class UpstreamError(TelemetryError):
    """The upstream answered, but not usefully."""

    def __init__(self, message: str, *, status_code: int | None = None, body: str = "") -> None:
        super().__init__(message)
        self.status_code = status_code
        self.body = body


class RetryableUpstreamError(UpstreamError):
    """Transient failure; the caller should back off and retry."""


class UpstreamClientError(UpstreamError):
    """4xx that retrying cannot fix (bad date, forbidden, not found)."""


class AuthError(TelemetryError):
    """Base for authentication problems."""


class AuthExpiredError(AuthError):
    """Token missing/expired/revoked. Re-authenticating fixes it."""


class AuthRejectedError(AuthError):
    """Credentials themselves are bad, or the client was disabled/deleted."""
