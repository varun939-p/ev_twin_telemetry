"""HTTP transport: one place that knows how to talk to the upstream API.

Retry policy
------------
* Retry on: 5xx, timeouts, connection resets -- exponential backoff with full
  jitter (`base * 2**n`, capped), so N pollers do not synchronise their retries
  into a thundering herd.
* Do NOT retry on: 400/403/404 (our request is wrong) and 401 (that is auth,
  and auth has its own path -- see `auth.py`).
* Every retry is logged at WARNING with the delay, so a degraded upstream shows
  up in the logs before it shows up as missing data.
"""

from __future__ import annotations

import logging
import random
import time
from typing import Any, Callable, Final
from urllib.parse import urlencode

import requests
from requests import Response
from requests.adapters import HTTPAdapter
from requests.models import PreparedRequest

from .config import Settings
from .exceptions import (
    AuthExpiredError,
    AuthRejectedError,
    RetryableUpstreamError,
    UpstreamClientError,
    UpstreamError,
)

log = logging.getLogger(__name__)

_RETRY_STATUS: Final[frozenset[int]] = frozenset({500, 502, 503, 504})


class _UseSettingsDate:
    """Sentinel: "send whatever `Settings.api_date` says" (the default).

    The live-date resolver needs to ask for *one specific* date -- including
    "no date at all" (the upstream's today-IST default) even when `API_DATE`
    is set -- so `fetch_vehicles(token, date=...)` distinguishes
    *not mentioned* (sentinel) from *explicitly omitted* (None).
    """

    __slots__ = ()

    def __repr__(self) -> str:  # pragma: no cover - cosmetics
        return "<use settings date>"


USE_SETTINGS_DATE: Final = _UseSettingsDate()


def is_auth_required(response: Response) -> bool:
    """True when a 401 carries the guide §5 marker `"auth": "required"`.

    Used for logging precision.  The *decision* on the data endpoint does not
    depend on it -- see the 401 branch in `_request`.
    """
    if response.status_code != 401:
        return False
    try:
        return str(response.json().get("auth", "")).lower() == "required"
    except (ValueError, AttributeError):
        return False


class UpstreamClient:
    """Thin, stateless wrapper over `requests`. Knows nothing about tokens."""

    def __init__(self, settings: Settings, session: requests.Session | None = None) -> None:
        self.settings = settings
        self.session = session or self._build_session()
        # Test hook: lets the suite assert on retry timing without sleeping.
        self.sleeper: Callable[[float], None] = time.sleep

    @staticmethod
    def _build_session() -> requests.Session:
        session = requests.Session()
        # No urllib3-level retries: we own the backoff policy, and hidden retries
        # inside the adapter would double up with ours.
        adapter = HTTPAdapter(pool_connections=4, pool_maxsize=8, max_retries=0)
        session.mount("http://", adapter)
        session.mount("https://", adapter)
        return session

    # ------------------------------------------------------------------ auth
    def request_token(self) -> dict[str, Any]:
        """POST /api/auth/api-token -- never logged with its credentials."""
        payload = {
            "secret_key": self.settings.api_secret_key,
            "passcode": self.settings.api_passcode,
        }
        return self._request(
            "POST",
            self.settings.auth_url(),
            json_body=payload,
            label="auth",
            endpoint="auth",
        )

    # -------------------------------------------------------------- vehicles
    def fetch_vehicles(self, token: str, date: str | None | _UseSettingsDate = USE_SETTINGS_DATE) -> dict[str, Any]:
        """GET /api/v1/vehicles (tier 1) with a Bearer token.

        Returns the fleet summary: per-vehicle frames are high-level only and
        carry `"battery": null`.  Deep telemetry comes from `fetch_vehicle`.

        `date` overrides the query-string date filter for this one request:
        the sentinel (default) keeps `Settings.api_date`, `None` omits the
        parameter entirely, and a string pins that exact day.  The live-date
        resolver in `telemetry.extractor` uses all three.
        """
        return self._request(
            "GET",
            self.settings.vehicles_url(),
            params=self._query_params(date),
            headers={"Authorization": f"Bearer {token}"},
            label="vehicles",
            endpoint="vehicles",
        )

    def fetch_vehicle(self, token: str, vehicle_id: str) -> dict[str, Any]:
        """GET /api/v1/vehicles/{vehicle_id} (tier 2) with a Bearer token.

        Returns the complete live diagnostic frame for one truck -- including
        the battery block under the abbreviated v1 keys.  The detail snapshot
        takes no query parameters: it is the current reading, not a history
        slice.
        """
        return self._request(
            "GET",
            self.settings.vehicle_url(vehicle_id),
            headers={"Authorization": f"Bearer {token}"},
            label=f"vehicle {vehicle_id}",
            endpoint="vehicles",
        )

    def _query_params(self, date: str | None | _UseSettingsDate = USE_SETTINGS_DATE) -> dict[str, str]:
        params: dict[str, str] = {}
        resolved_date = self.settings.api_date if isinstance(date, _UseSettingsDate) else date
        if resolved_date:
            params["date"] = resolved_date
        if self.settings.api_vehicle_filter:
            params["vehicle"] = self.settings.api_vehicle_filter
        return params

    def vehicles_request_url(self, date: str | None | _UseSettingsDate = USE_SETTINGS_DATE) -> str:
        """The exact GET URL the vehicles call will use, query string included.

        Descriptive only: nothing is sent and no header is included, so it is
        safe to log and to print.  The CLI uses it to state what it is about to
        call; `_request` logs the same assembly immediately before sending.
        Pass `date` to describe a date-pinned call (see `fetch_vehicles`).
        """
        return self._full_url(self.settings.vehicles_url(), self._query_params(date))

    def vehicle_request_url(self, vehicle_id: str) -> str:
        """The exact tier-2 GET URL for one vehicle (descriptive, see above)."""
        return self._full_url(self.settings.vehicle_url(vehicle_id), None)

    @staticmethod
    def _full_url(url: str, params: dict[str, str] | None) -> str:
        """`base_url + path` plus the encoded query string, exactly as sent.

        Built through `PreparedRequest.prepare` so the string we show is produced
        by the same encoder that builds the real request -- no hand-rolled
        joining that could drift from what goes on the wire.  If that encoder
        ever rejects an odd URL we still want the request itself to go out, so
        fall back to plain encoding rather than raising.
        """
        if not params:
            return url
        try:
            prepared = PreparedRequest()
            prepared.prepare(method="GET", url=url, params=params)
            return str(prepared.url)
        except (ValueError, requests.exceptions.RequestException):
            return f"{url}?{urlencode(params)}"

    # ----------------------------------------------------------------- core
    def _request(
        self,
        method: str,
        url: str,
        *,
        json_body: dict[str, Any] | None = None,
        params: dict[str, str] | None = None,
        headers: dict[str, str] | None = None,
        label: str,
        endpoint: str = "vehicles",
    ) -> dict[str, Any]:
        attempt = 0
        while True:
            # State the endpoint before calling it: method + fully assembled URL,
            # query string included, e.g.
            #     vehicles: GET https://track.blueenergymotors.com/api/v1/vehicles?date=2026-08-21
            # Logged per attempt, so a retry shows the exact URL it re-sent.  Only
            # the URL is logged, never `json_body` -- the auth call carries the
            # credentials in its body and must stay out of the logs.
            log.info("%s: %s %s", label, method, self._full_url(url, params))
            try:
                response = self.session.request(
                    method,
                    url,
                    json=json_body,
                    params=params,
                    headers=headers,
                    timeout=self.settings.request_timeout,
                )
            except requests.exceptions.RequestException as exc:
                # Timeouts, DNS failures, connection resets, TLS errors...
                if attempt >= self.settings.http_max_retries:
                    raise RetryableUpstreamError(
                        f"{label}: giving up after {attempt + 1} attempts ({exc.__class__.__name__}: {exc})"
                    ) from exc
                self._backoff(attempt, label, f"{exc.__class__.__name__}: {exc}")
                attempt += 1
                continue

            status = response.status_code

            if status < 400:
                return self._decode(response, label)

            snippet = self._snippet(response)

            if status == 401:
                if endpoint == "auth":
                    # 401 here means the secret_key/passcode pair itself is wrong,
                    # or the client was disabled/deleted.  Never retried.
                    raise AuthRejectedError(f"auth endpoint rejected the credentials: {snippet}")
                # Data endpoint: the guide's error table gives 401 only one meaning
                # on this route -- missing/invalid/expired token.  Credentials were
                # already accepted when this token was minted, so treat it as an
                # expiry and let run_with_reauth mint a new one.
                marker = " (auth=required)" if is_auth_required(response) else ""
                raise AuthExpiredError(f"{label}: token rejected{marker} -- {snippet}")

            if status in _RETRY_STATUS:
                if attempt >= self.settings.http_max_retries:
                    raise RetryableUpstreamError(
                        f"{label}: upstream returned {status} after {attempt + 1} attempts",
                        status_code=status,
                        body=snippet,
                    )
                self._backoff(attempt, label, f"HTTP {status}")
                attempt += 1
                continue

            # 400 bad date, 403 admin-only, 404, 418, ... retrying is pointless.
            raise UpstreamClientError(
                f"{label}: upstream returned {status} ({snippet})", status_code=status, body=snippet
            )

    # ------------------------------------------------------------- helpers
    def _backoff(self, attempt: int, label: str, reason: str) -> None:
        ceiling = min(
            self.settings.backoff_max_seconds,
            self.settings.backoff_base_seconds * (2**attempt),
        )
        delay = random.uniform(0, ceiling)  # full jitter
        log.warning(
            "%s: %s -- retry %d/%d in %.2fs",
            label,
            reason,
            attempt + 1,
            self.settings.http_max_retries,
            delay,
        )
        self.sleeper(delay)

    @staticmethod
    def _decode(response: Response, label: str) -> dict[str, Any]:
        try:
            data = response.json()
        except ValueError as exc:
            raise UpstreamError(
                f"{label}: response was not JSON ({response.status_code})",
                status_code=response.status_code,
                body=UpstreamClient._snippet(response),
            ) from exc
        if not isinstance(data, dict):
            raise UpstreamError(f"{label}: expected a JSON object, got {type(data).__name__}")
        if data.get("ok") is False:
            raise UpstreamError(
                f"{label}: upstream reported ok=false",
                status_code=response.status_code,
                body=UpstreamClient._snippet(response),
            )
        return data

    @staticmethod
    def _snippet(response: Response, limit: int = 200) -> str:
        try:
            text = response.text or ""
        except Exception:  # pragma: no cover - defensive
            return "<unreadable body>"
        text = " ".join(text.split())
        return text[:limit] if text else "<empty body>"
