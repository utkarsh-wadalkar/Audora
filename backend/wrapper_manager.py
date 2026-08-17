"""Wrapper container lifecycle (WorldObservationLog/wrapper fork).

Key facts:
  * Image built locally, tagged ``wrapper``.
  * Args passed via ``-e args="..."`` env var, NOT direct command args.
  * Login mode:  args="-L email:password -H 0.0.0.0"
  * Normal mode: args="-H 0.0.0.0"
  * 2FA: uses ``-F/--code-from-file``. The target path is parsed from this
    container run's own prompt and mapped through the configured data volume;
    no version-specific suffix is stored in Audora.
  * Ports 10020 (decrypt), 20020 (m3u8), 30020 (account).
  * Volume: {wrapper_data_path} -> /app/rootfs/data
  * Readiness: poll logs for "listening".
"""
import os
import posixpath
import re
import threading
import time
from collections import deque
from typing import Callable, Deque, Dict, List, Optional

from docker_manager import docker_mgr
from settings import get_settings
from logger import get_logger
from utils import redact_credentials, windows_to_docker_path

logger = get_logger("wrapper")

WRAPPER_IMAGE = "wrapper"
WRAPPER_CONTAINER_NAME = "audora-wrapper"

# Host ports the wrapper serves on (network_mode="host", so container ports
# are host ports). 10020 is the one downloads actually need, so it is what
# gates readiness; the other two are probed only for reporting.
WRAPPER_DECRYPT_PORT = 10020
WRAPPER_M3U8_PORT = 20020
WRAPPER_ACCOUNT_PORT = 30020

# How long a single liveness probe may take. This runs on the startup path,
# so it must not add perceptible latency.
_PROBE_TIMEOUT_SECONDS = 1.0

# How often to check the container is still alive while awaiting a 2FA code.
# The wrapper's own window is ~60s, so a couple of seconds is responsive enough
# to release the UI promptly without polling the Docker API hard.
_TWOFA_POLL_SECONDS = 2.0

# Wrapper output is the source of truth for setup authentication state.
_READY_LOG_PATTERN = re.compile(r"\blistening(?:\s+on)?\s+0\.0\.0\.0:\d+\b", re.IGNORECASE)
_TWOFA_PATH_PATTERNS = (
    re.compile(r"Enter your 2FA code into\s+(.+?)\s*$", re.IGNORECASE),
    re.compile(r"Example command:\s*echo\s+-n\s+\S+\s*>\s*(.+?)\s*$", re.IGNORECASE),
)
_LOGIN_ERROR_LOG_MARKERS = ("invalid", "incorrect", "failed to login", "authentication failed")
_CREDENTIALS_REQUIRED_LOG_MARKERS = (
    "account database not found",
    "username and password environment variables must be set",
    "login required",
)
_ANSI_ESCAPE_PATTERN = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")

WRAPPER_STATE_STOPPED = "stopped"
WRAPPER_STATE_STARTING = "starting"
WRAPPER_STATE_AUTHENTICATED = "authenticated"
WRAPPER_STATE_NEEDS_CREDENTIALS = "needs_credentials"
WRAPPER_STATE_NEEDS_2FA = "needs_2fa"
WRAPPER_STATE_ERROR = "error"
_TERMINAL_SETUP_STATES = {
    WRAPPER_STATE_AUTHENTICATED,
    WRAPPER_STATE_NEEDS_CREDENTIALS,
    WRAPPER_STATE_NEEDS_2FA,
    WRAPPER_STATE_ERROR,
}


def parse_twofa_path_from_log(line: str) -> str:
    """Return the exact path printed by the wrapper's current 2FA prompt."""
    clean_line = _ANSI_ESCAPE_PATTERN.sub("", line or "")
    for pattern in _TWOFA_PATH_PATTERNS:
        match = pattern.search(clean_line)
        if not match:
            continue
        return match.group(1).strip().strip("`'\"")
    return ""


def resolve_twofa_host_path(reported_path: str, wrapper_data_path: str) -> str:
    """Map a wrapper-reported container path through the configured volume.

    The only stable path contract is the Docker mount itself:
    ``wrapper_data_path`` is mounted at ``/app/rootfs/data``. Everything below
    that mount is taken from the wrapper's current log line, never from a
    version-specific suffix stored in Audora.
    """
    if not reported_path or not wrapper_data_path:
        return ""

    normalized = reported_path.replace("\\", "/")
    if normalized.startswith("/"):
        container_path = posixpath.normpath(normalized)
    else:
        container_path = posixpath.normpath(posixpath.join("/app", normalized))

    mount_path = "/app/rootfs/data"
    if container_path == mount_path:
        relative_path = ""
    elif container_path.startswith(f"{mount_path}/"):
        relative_path = container_path[len(mount_path) + 1 :]
    else:
        logger.error(
            f"Wrapper reported a 2FA path outside the mounted data volume: {reported_path}"
        )
        return ""

    host_root = os.path.abspath(wrapper_data_path)
    candidate = os.path.abspath(
        os.path.join(host_root, *relative_path.split("/"))
        if relative_path
        else host_root
    )
    try:
        if os.path.commonpath((host_root, candidate)) != host_root:
            return ""
    except ValueError:
        return ""
    return candidate


class WrapperManager:
    def __init__(self) -> None:
        self._ready = False
        self._pending_2fa = False
        self._auth_event_listeners: List[Callable[[dict], None]] = []
        self._log_event_listeners: List[Callable[[dict], None]] = []
        self._recent_logs: Deque[dict] = deque(maxlen=2000)
        self._log_sequence = 0
        self._monitor_thread: Optional[threading.Thread] = None
        self._twofa_watchdog: Optional[threading.Thread] = None
        self._stop_monitor = False
        self._state = WRAPPER_STATE_STOPPED
        self._state_condition = threading.Condition()
        self._twofa_reported_path = ""
        self._twofa_host_path = ""

    # --- Auth event fan-out (consumed by app.py -> ws/auth) ---
    def register_auth_callback(self, listener: Callable[[dict], None]) -> None:
        if listener not in self._auth_event_listeners:
            self._auth_event_listeners.append(listener)

    def _emit_auth(self, event_type: str, message: str, **extra: str) -> None:
        event = {"type": event_type, "message": message, **extra}
        for listener in list(self._auth_event_listeners):
            try:
                listener(event)
            except Exception:
                pass

    def register_log_callback(self, listener: Callable[[dict], None]) -> None:
        if listener not in self._log_event_listeners:
            self._log_event_listeners.append(listener)

    def _emit_log(self, line: str) -> None:
        self._log_sequence += 1
        event = {"sequence": self._log_sequence, "line": line}
        self._recent_logs.append(event)
        for listener in list(self._log_event_listeners):
            try:
                listener(event)
            except Exception:
                pass

    def get_recent_logs(self) -> List[dict]:
        return list(self._recent_logs)

    def _set_state(self, state: str) -> None:
        with self._state_condition:
            self._state = state
            self._state_condition.notify_all()

    def wait_for_setup_state(self, timeout: int = 60) -> str:
        deadline = time.time() + timeout
        with self._state_condition:
            while self._state not in _TERMINAL_SETUP_STATES:
                remaining = deadline - time.time()
                if remaining <= 0:
                    return self._state
                self._state_condition.wait(timeout=remaining)
            return self._state

    def get_twofa_host_path(self) -> str:
        return self._twofa_host_path

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
            self._set_state(WRAPPER_STATE_ERROR)
            return False

        # Reuse an already-serving wrapper instead of recreating it.
        #
        # A fresh backend process starts with `_ready = False` and no log
        # monitor, so without this check a healthy container left over from a
        # previous run gets force-removed and rebuilt on every app start,
        # killing anything mid-download. The port probe is authoritative in a
        # way the log scraping cannot be: it works regardless of which process
        # started the container.
        #
        # Login is excluded deliberately — it passes different args
        # (`-L email:password`), so reusing a container started without them
        # would silently ignore the new credentials.
        if not is_login and self._can_reuse_running_wrapper():
            logger.info("Wrapper already running and serving; reusing it")
            self._ready = True
            self._pending_2fa = False
            self._set_state(WRAPPER_STATE_AUTHENTICATED)
            self._emit_auth("auth_success", "Signed in successfully")
            existing = docker_mgr.get_container(WRAPPER_CONTAINER_NAME)
            if existing is not None:
                self._start_monitor(existing.id, is_login=False)
            return True

        self._ready = False
        self._pending_2fa = False
        self._twofa_reported_path = ""
        self._twofa_host_path = ""
        self._set_state(WRAPPER_STATE_STARTING)
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
            self._set_state(WRAPPER_STATE_ERROR)
            return False

        # Monitor logs in a background thread for readiness / 2FA / errors.
        self._start_monitor(container.id, is_login)
        return True

    def _can_reuse_running_wrapper(self) -> bool:
        """True if a container is up AND actually serving on its port.

        Both halves matter. A container can report ``running`` while the
        wrapper inside is still chrooting and has bound nothing, so status
        alone would hand callers a dead port.
        """
        if docker_mgr.get_container_status(WRAPPER_CONTAINER_NAME) != "running":
            return False
        return self.is_wrapper_listening()

    def is_wrapper_listening(self) -> bool:
        """True if the wrapper's decrypt port accepts connections.

        Only 10020 is checked: it is the port downloads depend on, and the
        m3u8/account servers bind slightly later, so requiring all three would
        report a usable wrapper as dead.
        """
        return docker_mgr.is_port_listening(
            WRAPPER_DECRYPT_PORT, timeout=_PROBE_TIMEOUT_SECONDS
        )

    def stop_wrapper(self) -> bool:
        self._stop_monitor = True
        self._ready = False
        self._pending_2fa = False
        self._twofa_reported_path = ""
        self._twofa_host_path = ""
        self._set_state(WRAPPER_STATE_STOPPED)
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
            finally:
                # The log stream ending means the container stopped producing
                # output — almost always because it exited. If that happens
                # while we are still waiting for a 2FA code, the user is sitting
                # on a code-entry screen for a container that no longer exists,
                # so it has to be surfaced rather than silently dropped.
                if not self._stop_monitor:
                    self._handle_container_exit()

        self._monitor_thread = threading.Thread(target=run, daemon=True)
        self._monitor_thread.start()

    def _handle_container_exit(self) -> None:
        """Emit an auth error if the wrapper died while 2FA was outstanding.

        The wrapper waits 60s for a code and then exits for good — it does NOT
        retry — so without this the frontend waits forever on a dead container.
        """
        status = docker_mgr.get_container_status(WRAPPER_CONTAINER_NAME)
        if status == "running":
            # Log stream hiccup rather than a real exit; leave state alone.
            return
        if not self._pending_2fa:
            if self._state == WRAPPER_STATE_STARTING:
                self._set_state(WRAPPER_STATE_NEEDS_CREDENTIALS)
                self._emit_auth(
                    "auth_credentials_required",
                    "Sign in with your Apple ID to continue",
                )
            return
        self._pending_2fa = False
        self._ready = False
        self._set_state(WRAPPER_STATE_ERROR)
        logger.warning(f"Wrapper exited while awaiting 2FA (status={status})")
        self._emit_auth(
            "auth_error",
            "The verification window expired. Please sign in again to get a new code.",
        )

    def _start_2fa_watchdog(self) -> None:
        """Poll container status while a 2FA code is outstanding.

        Belt-and-braces alongside the log stream: if the stream stalls without
        closing (a stuck reader, a Docker API hiccup), polling still notices the
        container has gone and releases the UI.
        """
        if self._twofa_watchdog and self._twofa_watchdog.is_alive():
            return

        def run() -> None:
            while not self._stop_monitor and self._pending_2fa:
                time.sleep(_TWOFA_POLL_SECONDS)
                if self._stop_monitor or not self._pending_2fa:
                    return
                status = docker_mgr.get_container_status(WRAPPER_CONTAINER_NAME)
                if status != "running":
                    self._handle_container_exit()
                    return

        self._twofa_watchdog = threading.Thread(target=run, daemon=True)
        self._twofa_watchdog.start()

    def _inspect_log_line(self, line: str, is_login: bool) -> None:
        self._emit_log(line)
        redacted_line = redact_credentials(line)
        logger.info(f"[wrapper] {redacted_line}")
        lowered_line = line.lower()

        if any(marker in lowered_line for marker in _LOGIN_ERROR_LOG_MARKERS):
            self._set_state(WRAPPER_STATE_ERROR)
            self._emit_auth("auth_error", "Incorrect Apple ID or password")
            return

        reported_path = parse_twofa_path_from_log(line)
        if reported_path:
            host_path = resolve_twofa_host_path(
                reported_path, get_settings().get("wrapper_data_path", "")
            )
            if not host_path:
                self._set_state(WRAPPER_STATE_ERROR)
                self._emit_auth(
                    "auth_error", "The wrapper reported an unusable 2FA file path"
                )
                return
            self._twofa_reported_path = reported_path
            self._twofa_host_path = host_path
            if self._pending_2fa:
                return
            self._pending_2fa = True
            self._set_state(WRAPPER_STATE_NEEDS_2FA)
            # The wrapper gives the user only ~60s before it exits for good, so
            # start watching for that exit the moment we ask for a code.
            self._start_2fa_watchdog()
            self._emit_auth(
                "auth_2fa_required",
                "Enter your 6-digit verification code",
                path=reported_path,
            )
            return

        if any(marker in lowered_line for marker in _CREDENTIALS_REQUIRED_LOG_MARKERS):
            self._set_state(WRAPPER_STATE_NEEDS_CREDENTIALS)
            self._emit_auth(
                "auth_credentials_required", "Sign in with your Apple ID to continue"
            )
            return

        if _READY_LOG_PATTERN.search(line):
            if not self._ready:
                self._ready = True
                self._pending_2fa = False
                self._set_state(WRAPPER_STATE_AUTHENTICATED)
                self._emit_auth("auth_success", "Signed in successfully")
                logger.info("Wrapper is ready (listening)")

    # --- Readiness ---
    def is_wrapper_ready(self) -> bool:
        if self._ready:
            return True
        # Fall back to a real liveness probe if we missed the ready log marker
        # (e.g. the container was started by a previous backend process, so no
        # monitor thread ever scraped its logs). Container status alone is too
        # weak — "running" is true before the wrapper binds its port.
        if docker_mgr.get_container_status(WRAPPER_CONTAINER_NAME) != "running":
            return False
        return self.is_wrapper_listening()

    def wait_until_ready(self, timeout: int = 60) -> bool:
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self._ready:
                return True
            # A reused container never emits a fresh "listening" line, so the
            # probe is the only way this can ever succeed for it.
            if self.is_wrapper_listening():
                self._ready = True
                return True
            if self._pending_2fa:
                # Waiting on the user; don't burn the timeout.
                deadline = time.time() + timeout
            time.sleep(1)
        return self._ready

    def get_wrapper_status(self) -> Dict:
        status = docker_mgr.get_container_status(WRAPPER_CONTAINER_NAME)
        running = status == "running"
        # Report the same readiness the rest of the app acts on. Using the raw
        # `_ready` flag here made queue_processor think a perfectly healthy
        # reused wrapper was not ready, so it tore it down and restarted it.
        ready = self.is_wrapper_ready() if running else False
        return {
            "running": running,
            "ready": ready,
            "pending_2fa": self._pending_2fa,
            "state": self._state,
            "twofa_path": self._twofa_reported_path,
            "message": "Ready" if ready else ("Running" if running else "Stopped"),
        }


wrapper_mgr = WrapperManager()
