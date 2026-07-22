"""Wrapper container lifecycle (WorldObservationLog/wrapper fork).

Key facts (verified in task.md):
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
WRAPPER_PORTS = {"10020/tcp": 10020, "20020/tcp": 20020, "30020/tcp": 30020}

# Substrings that signal each state in the wrapper's stdout.
_READY_MARKERS = ("listening", "server started", "ready")
_2FA_MARKERS = ("2fa", "two-factor", "verification code", "enter the code")
_ERROR_MARKERS = ("invalid", "incorrect", "failed to login", "authentication failed")


class WrapperManager:
    def __init__(self) -> None:
        self._ready = False
        self._pending_2fa = False
        self._auth_callbacks: List[Callable[[dict], None]] = []
        self._monitor_thread: Optional[threading.Thread] = None
        self._stop_monitor = False

    # --- Auth event fan-out (consumed by app.py -> ws/auth) ---
    def register_auth_callback(self, cb: Callable[[dict], None]) -> None:
        if cb not in self._auth_callbacks:
            self._auth_callbacks.append(cb)

    def _emit_auth(self, event_type: str, message: str) -> None:
        event = {"type": event_type, "message": message}
        for cb in list(self._auth_callbacks):
            try:
                cb(event)
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
            "ports": WRAPPER_PORTS,
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
            self._emit_auth("auth_error", "Failed to start decryption service")
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
                    self._inspect_line(line, is_login)
            except Exception as e:
                logger.warning(f"wrapper monitor ended: {e}")

        self._monitor_thread = threading.Thread(target=run, daemon=True)
        self._monitor_thread.start()

    def _inspect_line(self, line: str, is_login: bool) -> None:
        safe = redact_credentials(line)
        logger.info(f"[wrapper] {safe}")
        low = line.lower()

        if any(m in low for m in _ERROR_MARKERS):
            self._emit_auth("auth_error", "Incorrect Apple ID or password")
            return

        if is_login and not self._pending_2fa and any(m in low for m in _2FA_MARKERS):
            self._pending_2fa = True
            self._emit_auth("auth_2fa_required", "Enter your 6-digit verification code")
            return

        if any(m in low for m in _READY_MARKERS):
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
        # Fall back to container-running check if we missed the marker.
        return docker_mgr.get_container_status(WRAPPER_CONTAINER_NAME) == "running" and self._ready

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
