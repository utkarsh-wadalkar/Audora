"""Wrapper container lifecycle (WorldObservationLog/wrapper fork).

Key facts:
  * Image built locally, tagged ``wrapper``.
  * Args passed via ``-e args="..."`` env var, NOT direct command args.
  * Login mode:  args="-L email:password -H 0.0.0.0"
  * Normal mode: args="-H 0.0.0.0"
  * 2FA: uses ``-F/--code-from-file``; code is written to rootfs/data/2fa.txt.
  * Ports 10020 (decrypt), 20020 (m3u8), 30020 (account).
  * Volume: {wrapper_data_path} -> /app/rootfs/data
  * Readiness: poll logs for "listening".
"""
import threading
import time
from typing import Callable, Dict, List, Optional

from docker_manager import docker_mgr
from settings import get_settings
from logger import get_logger
from utils import redact_credentials, windows_to_docker_path

logger = get_logger("wrapper")

WRAPPER_IMAGE = "wrapper"
WRAPPER_CONTAINER_NAME = "audora-wrapper"

# Substrings matched against lowercased wrapper stdout to detect each state.
_READY_LOG_MARKERS = ("listening", "server started", "ready")
_TWO_FACTOR_LOG_MARKERS = ("2fa", "two-factor", "verification code", "enter the code")
_LOGIN_ERROR_LOG_MARKERS = ("invalid", "incorrect", "failed to login", "authentication failed")


class WrapperManager:
    def __init__(self) -> None:
        self._ready = False
        self._pending_2fa = False
        self._auth_event_listeners: List[Callable[[dict], None]] = []
        self._monitor_thread: Optional[threading.Thread] = None
        self._stop_monitor = False

    # --- Auth event fan-out (consumed by app.py -> ws/auth) ---
    def register_auth_callback(self, listener: Callable[[dict], None]) -> None:
        if listener not in self._auth_event_listeners:
            self._auth_event_listeners.append(listener)

    def _emit_auth(self, event_type: str, message: str) -> None:
        event = {"type": event_type, "message": message}
        for listener in list(self._auth_event_listeners):
            try:
                listener(event)
            except Exception:
                pass

    # --- Container config ---
    def _base_config(self, args: str) -> dict:
        settings = get_settings()
        data_path = windows_to_docker_path(settings.get("wrapper_data_path"))
        return {
            "image": WRAPPER_IMAGE,
            "name": WRAPPER_CONTAINER_NAME,
            "environment": {"args": args},
            "volumes": {data_path: {"bind": "/app/rootfs/data", "mode": "rw"}},
            # The wrapper binary is a launcher: it bind-mounts /dev/urandom,
            # chroots into ./rootfs, and execs the real decryptor inside. Both
            # mount() and chroot() need elevated privileges, so without this
            # the container exits immediately ("mount /dev/urandom failed").
            # Upstream's own run instructions use --privileged for this reason.
            "privileged": True,
            # network_mode="host" shares the host network namespace directly, so
            # the wrapper's ports (10020/20020/30020) are accessible on the host
            # without explicit port bindings.  Passing both network_mode="host"
            # AND a ports mapping causes a Docker APIError ("conflicting options:
            # port publishing and the host network mode"), so we omit ports here.
            "network_mode": "host",
            "detach": True,
            "stdin_open": True,
            "tty": False,
        }

    # --- Lifecycle ---
    def start_wrapper(self, login: bool = False) -> bool:
        """Start in normal mode (saved session)."""
        return self._start(args="-H 0.0.0.0", is_login=False)

    def start_wrapper_login(self, email: str, password: str) -> bool:
        """Start in login mode with credentials + code-from-file (2FA)."""
        args = f"-L {email}:{password} -F -H 0.0.0.0"
        return self._start(args=args, is_login=True)

    def _start(self, args: str, is_login: bool) -> bool:
        if not docker_mgr.is_docker_running():
            logger.error("Docker is not running; cannot start wrapper")
            self._emit_auth("auth_error", "Docker is not running")
            return False

        self._ready = False
        self._pending_2fa = False
        logger.info(f"Starting wrapper: {redact_credentials(args)}")
        if is_login:
            self._emit_auth("auth_progress", "Starting wrapper...")

        config = self._base_config(args)
        container = docker_mgr.start_container(config)
        if container is None:
            # Surface the real Docker error (image missing, daemon error, etc.)
            # so the UI shows an actionable message instead of a generic one.
            real_error = docker_mgr.last_start_error or "Failed to start decryption service"
            self._emit_auth("auth_error", real_error)
            return False

        # Monitor logs in a background thread for readiness / 2FA / errors.
        self._start_monitor(container.id, is_login)
        return True

    def stop_wrapper(self) -> bool:
        self._stop_monitor = True
        self._ready = False
        self._pending_2fa = False
        return docker_mgr.stop_container(WRAPPER_CONTAINER_NAME, timeout=8)

    # --- Log monitoring ---
    def _start_monitor(self, container_id: str, is_login: bool) -> None:
        self._stop_monitor = False

        def run() -> None:
            try:
                for line in docker_mgr.stream_logs(container_id, follow=True):
                    if self._stop_monitor:
                        break
                    self._inspect_log_line(line, is_login)
            except Exception as monitor_error:
                logger.warning(f"wrapper monitor ended: {monitor_error}")

        self._monitor_thread = threading.Thread(target=run, daemon=True)
        self._monitor_thread.start()

    def _inspect_log_line(self, line: str, is_login: bool) -> None:
        redacted_line = redact_credentials(line)
        logger.info(f"[wrapper] {redacted_line}")
        lowered_line = line.lower()

        if any(marker in lowered_line for marker in _LOGIN_ERROR_LOG_MARKERS):
            self._emit_auth("auth_error", "Incorrect Apple ID or password")
            return

        if is_login and not self._pending_2fa and any(marker in lowered_line for marker in _TWO_FACTOR_LOG_MARKERS):
            self._pending_2fa = True
            self._emit_auth("auth_2fa_required", "Enter your 6-digit verification code")
            return

        if any(marker in lowered_line for marker in _READY_LOG_MARKERS):
            if not self._ready:
                self._ready = True
                self._pending_2fa = False
                if is_login:
                    self._emit_auth("auth_success", "Signed in successfully")
                logger.info("Wrapper is ready (listening)")

    # --- Readiness ---
    def is_wrapper_ready(self) -> bool:
        if self._ready:
            return True
        # Fall back to container-running check if we missed the ready log marker.
        return docker_mgr.get_container_status(WRAPPER_CONTAINER_NAME) == "running"

    def wait_until_ready(self, timeout: int = 60) -> bool:
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self._ready:
                return True
            if self._pending_2fa:
                # Waiting on the user; don't burn the timeout.
                deadline = time.time() + timeout
            time.sleep(1)
        return self._ready

    def get_wrapper_status(self) -> Dict:
        status = docker_mgr.get_container_status(WRAPPER_CONTAINER_NAME)
        running = status == "running"
        return {
            "running": running,
            "ready": self._ready,
            "pending_2fa": self._pending_2fa,
            "message": "Ready" if self._ready else ("Running" if running else "Stopped"),
        }


wrapper_mgr = WrapperManager()
