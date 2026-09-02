"""The continuous extraction loop.

Loop contract
-------------
1. Rotate the token *between* cycles, never during one (`TokenManager.get_token`
   is called at the top of each cycle and returns the cached token unless the
   55-minute deadline has passed).
2. Sleep until the next tick.  The sleep is anchored to a wall-clock deadline
   rather than `sleep(interval)`, so a slow cycle cannot make the poll rate
   drift downwards over a 24-hour run.
3. Any failure is contained: the cycle is abandoned, the failure is counted and
   logged, and the loop continues on the next tick.  A single bad hour of
   upstream 500s must not require a restart.
4. Auth failures get a longer pause (`AUTH_BACKOFF`) because retrying bad
   credentials every 60 s is how an API client gets disabled.
5. SIGTERM / SIGINT finish the in-flight cycle, commit, and exit 0 -- so a
   Kubernetes rollout or `docker stop` never truncates a transaction.
"""

from __future__ import annotations

import logging
import signal
import threading
import time
from datetime import datetime, timedelta, timezone

from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import sessionmaker

from .api import UpstreamClient
from .auth import TokenManager
from .config import Settings
from .exceptions import AuthRejectedError, RetryableUpstreamError, TelemetryError, UpstreamError
from .extractor import TelemetryExtractor
from .metrics import Metrics, start_metrics_server

log = logging.getLogger(__name__)

class TelemetryOrchestrator:
    def __init__(
        self,
        settings: Settings,
        session_factory: sessionmaker,
        extractor: TelemetryExtractor | None = None,
        tokens: TokenManager | None = None,
        client: UpstreamClient | None = None,
        metrics: Metrics | None = None,
    ) -> None:
        self.settings = settings
        self.session_factory = session_factory
        self.metrics = metrics or Metrics()
        self.client = client or UpstreamClient(settings)
        self.tokens = tokens or TokenManager(settings, self.client)
        self.extractor = extractor or TelemetryExtractor(
            settings, self.client, self.tokens, metrics=self.metrics
        )

        self._stop = threading.Event()
        self.cycles = 0
        self.failures = 0
        self.last_report = None  # CycleReport of the most recent successful cycle
        self.started_at: datetime | None = None
        self.last_success_at: datetime | None = None

    # ------------------------------------------------------------------ API
    def install_signal_handlers(self) -> None:
        """Only valid from the main thread; the CLI calls this, tests do not."""
        for sig in (signal.SIGTERM, signal.SIGINT):
            try:
                signal.signal(sig, self._handle_signal)
            except ValueError:  # pragma: no cover - not the main thread
                log.debug("could not install handler for %s", sig)

    def request_stop(self) -> None:
        log.info("shutdown requested -- finishing the in-flight cycle")
        self._stop.set()

    def run_forever(self) -> int:
        """Run until asked to stop. Returns a process exit code."""
        self.install_signal_handlers()
        self.started_at = datetime.now(timezone.utc)

        metrics_server = None
        if self.settings.metrics_enabled:
            metrics_server = start_metrics_server(self.metrics, self.settings.metrics_port)
            log.info("metrics endpoint listening on :%d/metrics", self.settings.metrics_port)

        self._log_banner()

        # Fail fast on a bad first authentication instead of discovering it
        # 60 seconds into a container restart loop.
        try:
            self.tokens.get_token(force=True)
        except TelemetryError as exc:
            log.critical("initial authentication failed: %s", exc)
            if metrics_server:
                metrics_server.shutdown()
            return 2

        next_tick = time.monotonic()
        try:
            while not self._stop.is_set():
                next_tick += self.settings.poll_interval_seconds
                self._run_one_cycle()

                delay = next_tick - time.monotonic()
                if delay < 0:
                    # The cycle took longer than the interval: re-anchor instead
                    # of firing a burst of catch-up polls at the upstream.
                    log.warning(
                        "cycle overran the %.0fs interval by %.1fs -- re-anchoring the schedule",
                        self.settings.poll_interval_seconds,
                        -delay,
                    )
                    next_tick = time.monotonic() + self.settings.poll_interval_seconds
                    delay = self.settings.poll_interval_seconds

                # Interruptible sleep: SIGTERM wakes us immediately.
                if self._stop.wait(timeout=delay):
                    break
        finally:
            if metrics_server:
                metrics_server.shutdown()
            log.info(
                "stopped after %d cycle(s), %d failure(s), %d authentication(s)",
                self.cycles,
                self.failures,
                self.tokens.auth_count,
            )
        return 0

    def run_once(self) -> bool:
        """Single cycle, no loop. True on success."""
        try:
            self.tokens.get_token()
        except TelemetryError as exc:
            log.error("authentication failed: %s", exc)
            return False
        return self._run_one_cycle()

    def run_once_and_report(self):
        """Like `run_once`, but hands back the CycleReport.

        Used by the tests (and by the `once` command path) when the interesting
        thing is *what* the cycle did -- rows written, rows skipped -- not just
        whether it survived.
        """
        self.run_once()
        return self.last_report

    # -------------------------------------------------------------- private
    def _run_one_cycle(self) -> bool:
        session = self.session_factory()
        try:
            self.last_report = self.extractor.run_cycle(session)
            self.cycles += 1
            self.last_success_at = datetime.now(timezone.utc)
            self.metrics.set_gauge("twin_auth_total", self.tokens.auth_count)
            self.metrics.set_gauge("twin_auth_forced_total", self.tokens.forced_refresh_count)
            return True
        except AuthRejectedError as exc:
            self._fail(exc, pause=self.settings.auth_backoff_seconds, level=logging.CRITICAL)
        except RetryableUpstreamError as exc:
            self._fail(exc, pause=self.settings.error_backoff_seconds)
        except UpstreamError as exc:
            self._fail(exc, pause=self.settings.error_backoff_seconds)
        except SQLAlchemyError as exc:
            # A DB outage is not the upstream's fault and not ours; keep trying.
            self._fail(exc, pause=self.settings.error_backoff_seconds, label="database")
        except Exception as exc:  # noqa: BLE001 - the loop must never die
            log.exception("unexpected error in extraction cycle: %s", exc)
            self._fail(exc, pause=self.settings.error_backoff_seconds, label="unexpected")
        finally:
            session.close()
        return False

    def _fail(self, exc: Exception, *, pause: float, level: int = logging.ERROR, label: str = "cycle") -> None:
        self.failures += 1
        self.last_report = None
        self.metrics.inc("twin_cycles_failed_total")
        log.log(level, "%s failed (%s): %s -- pausing %.0fs", label, exc.__class__.__name__, exc, pause)
        if pause:
            self._stop.wait(timeout=pause)

    def _handle_signal(self, signum: int, _frame) -> None:
        log.info("received signal %s", signal.Signals(signum).name)
        self.request_stop()

    def _log_banner(self) -> None:
        log.info("=" * 78)
        log.info("EV Battery Swap Station Digital Twin -- telemetry extraction engine")
        log.info("  upstream        : %s", self.settings.api_base_url)
        log.info("  database        : %s", _safe_url(self.settings.database_url))
        log.info("  poll interval   : %.0fs", self.settings.poll_interval_seconds)
        log.info("  token rotation  : every %.0fs (server lifetime %.0fs, margin %.0fs)",
                 self.settings.token_refresh_interval,
                 self.tokens.lifetime_seconds or 3540,
                 self.settings.token_expiry_safety_margin)
        log.info("  date filter     : %s", self.settings.api_date or "<server default: today (IST)>")
        log.info("  strict 24-field : %s", "ON" if self.settings.require_all_fields else "off (missing -> NULL)")
        log.info("=" * 78)


def _safe_url(url: str) -> str:
    """Never print a password to the logs."""
    try:
        from sqlalchemy.engine import make_url

        return make_url(url).render_as_string(hide_password=True)
    except Exception:  # pragma: no cover - cosmetic
        return "<unparseable url>"


def health_snapshot(orchestrator: TelemetryOrchestrator) -> dict:
    """Dict for the `health` CLI command / a future /healthz endpoint."""
    now = datetime.now(timezone.utc)
    last = orchestrator.last_success_at
    return {
        "status": "healthy" if last and (now - last) < timedelta(seconds=orchestrator.settings.poll_interval_seconds * 3) else "degraded",
        "cycles": orchestrator.cycles,
        "failures": orchestrator.failures,
        "authentications": orchestrator.tokens.auth_count,
        "forced_reauths": orchestrator.tokens.forced_refresh_count,
        "token_refresh_in_seconds": round(orchestrator.tokens.seconds_until_refresh, 1),
        "last_success": last.isoformat(timespec="seconds") if last else None,
        "seconds_since_last_success": round((now - last).total_seconds(), 1) if last else None,
    }
