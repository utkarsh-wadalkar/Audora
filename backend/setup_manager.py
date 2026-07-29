"""First-run setup: system checks, image pull/build, progress events.

Docker Desktop *installation* is intentionally not silent — on Windows it
needs UAC and a reboot. We detect its absence and hand the user a download
link (surfaced by the wizard); we do not try to run the installer headless.

Workstream B (QC_plan.md §6, §7) extends this module additively with:

- an explicit per-step state machine (§6.1) modelled by ``StepState``,
- silent auto-retry with backoff for *transient* failures (§6.2),
- an error taxonomy that classifies each failure and marks it transient or
  permanent (§7.1, §6.3),
- idempotent Docker-facing steps safe to re-run after a partial failure
  (§6.4), and
- preflight checks run before any pull (§7.2) via the A-provided
  ``docker_manager`` helpers.

The existing public API and the ``setup_progress`` event shape emitted by
``_emit`` are PRESERVED. New event keys (``progress``, ``error``) are added
additively; existing keys and ``status`` values (``pending|running|done|
error``) are never renamed or removed, so the live wizard keeps working.
"""
import os
import platform
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.request
import zipfile
from typing import Callable, Dict, List, Optional, Tuple

from docker_manager import docker_mgr
from settings import get_settings, update_settings
from logger import get_logger

logger = get_logger("setup")

DOWNLOADER_IMAGE = "ghcr.io/zhaarey/apple-music-downloader"
WRAPPER_IMAGE = "wrapper"
DOCKER_DESKTOP_URL = "https://www.docker.com/products/docker-desktop/"

# --- Wrapper source (maintained fork) --------------------------------------
# Audora builds the wrapper image itself from the upstream release so the user
# never has to clone a repo, keep a Dockerfile around, or configure a path.
# The archived zhaarey/wrapper is superseded by this maintained fork.
#
# The release tag is lowercase but the asset filename is capitalised, so the
# filename cannot be derived from the tag — both are pinned explicitly.
WRAPPER_RELEASE_TAG = "wrapper.x86_64.latest"
WRAPPER_ASSET_NAME = "Wrapper.x86_64.latest.zip"
WRAPPER_RELEASE_URL = (
    "https://github.com/WorldObservationLog/wrapper/releases/download/"
    f"{WRAPPER_RELEASE_TAG}/{WRAPPER_ASSET_NAME}"
)

# Host used for the DNS preflight before downloading the wrapper release.
WRAPPER_RELEASE_HOST = "github.com"

# The wrapper release unpacks flat (``wrapper``, ``rootfs/``, plus upstream's
# own ``Dockerfile``/``compose.yaml``/``entrypoint.sh``) so ``COPY . /app``
# needs no flattening. We deliberately overwrite upstream's Dockerfile with
# this one, which is the known-working build for how Audora runs the container
# (args passed via the ``args`` env var — see wrapper_manager).
#
# ``chmod +x`` is required, not optional: the zip records the exec bit but
# extracting on Windows drops it, and ``COPY`` faithfully preserves the
# non-executable mode, so ``./wrapper`` would fail with permission denied.
WRAPPER_DOCKERFILE = """FROM ubuntu:latest
WORKDIR /app
COPY . /app
RUN chmod +x /app/wrapper
ENV args ""
CMD ["bash", "-c", "./wrapper ${args}"]
EXPOSE 10020 20020
"""

# Registry host used for the DNS preflight (§7.2). Derived from the image
# reference so it tracks DOWNLOADER_IMAGE if that ever changes.
REGISTRY_HOST = DOWNLOADER_IMAGE.split("/", 1)[0]  # "ghcr.io"


# Rough footprint of the downloader image on disk; used for the disk-space
# preflight (§7.2). ~3.7GB image (§2 root-cause #4) plus headroom so we fail
# *before* a mid-pull vhdx cap rather than after (§2 root-cause #5).
_DOWNLOADER_REQUIRED_BYTES = 6 * 1024 * 1024 * 1024  # 6 GB with buffer


# --- Step state machine (§6.1) --------------------------------------------
# pending -> running -> (success | failed);  failed -> running on retry.
class StepState:
    PENDING = "pending"
    RUNNING = "running"
    SUCCESS = "success"
    FAILED = "failed"


# Map internal state-machine states onto the *existing* emitted ``status``
# values so we never break the live wizard's event contract.
_STATE_TO_EMIT_STATUS = {
    StepState.PENDING: "pending",
    StepState.RUNNING: "running",
    StepState.SUCCESS: "done",
    StepState.FAILED: "error",
}


# --- Error taxonomy (§7.1) + transient/permanent classification (§6.3) -----
class ErrorCode:
    DOCKER_UNRESPONSIVE = "docker_unresponsive"  # API unreachable despite "running"
    DNS_FAILURE = "dns_failure"                   # cannot resolve registry host
    DISK_FULL = "disk_full"                       # < required + buffer free
    REGISTRY_RATE_LIMIT = "registry_rate_limit"   # HTTP 429 from ghcr.io
    REGISTRY_UNAVAILABLE = "registry_unavailable"  # registry 5xx / connection reset
    AUTH_DENIED = "auth_denied"                   # auth / permission / access denied
    UNKNOWN = "unknown"                            # unclassified — generic recovery

# Only TRANSIENT codes auto-retry (§6.2/§6.3). Everything else surfaces
# immediately with an actionable message + code so Workstream E can render
# exactly one recovery button.
_TRANSIENT_CODES = frozenset({
    ErrorCode.DOCKER_UNRESPONSIVE,
    ErrorCode.DNS_FAILURE,
    ErrorCode.REGISTRY_RATE_LIMIT,
    ErrorCode.REGISTRY_UNAVAILABLE,
})

# Human-facing, actionable messages (§7.1). Never "run this command".
_CODE_MESSAGES = {
    ErrorCode.DOCKER_UNRESPONSIVE: "Docker is still starting up. Retrying automatically...",
    ErrorCode.DNS_FAILURE: "Having trouble reaching the download server. Retrying automatically...",
    ErrorCode.DISK_FULL: "You need about 6 GB free to continue. Free up some space and click Retry.",
    ErrorCode.REGISTRY_RATE_LIMIT: "The download server is temporarily busy. We'll try again shortly.",
    ErrorCode.REGISTRY_UNAVAILABLE: "The download server is temporarily unavailable. Retrying automatically...",
    ErrorCode.AUTH_DENIED: "Access to the download server was denied. Please check your connection and click Retry.",
    ErrorCode.UNKNOWN: "Something went wrong downloading a required component.",
}


def classify_error(reason: str) -> str:
    """Map a raw error/reason string to an :class:`ErrorCode` (§7.1, §6.3).

    Matching is substring-based and case-insensitive so it survives the
    varied wording Docker/registry errors arrive in. Unrecognized reasons
    fall through to ``UNKNOWN`` (a *permanent*, generically-recoverable code)
    so we never auto-retry a failure we don't understand.
    """
    text = (reason or "").lower()
    # Order matters: most specific / most actionable first.
    if "429" in text or "toomanyrequests" in text or "rate limit" in text:
        return ErrorCode.REGISTRY_RATE_LIMIT
    if "no space" in text or "disk" in text or "not enough space" in text:
        return ErrorCode.DISK_FULL
    if any(t in text for t in ("dns", "resolve", "name resolution", "getaddrinfo", "name or service not known")):
        return ErrorCode.DNS_FAILURE
    if any(t in text for t in ("unauthorized", "denied", "forbidden", "401", "403", "authentication")):
        return ErrorCode.AUTH_DENIED
    if any(t in text for t in ("500", "502", "503", "504", "server error", "connection reset", "connection aborted", "bad gateway")):
        return ErrorCode.REGISTRY_UNAVAILABLE
    if any(t in text for t in ("docker", "engine", "pipe", "daemon", "not running", "cannot connect")):
        return ErrorCode.DOCKER_UNRESPONSIVE
    return ErrorCode.UNKNOWN


def is_transient(code: str) -> bool:
    """True if ``code`` should auto-retry (§6.2/§6.3)."""
    return code in _TRANSIENT_CODES


class _StepFailure(Exception):
    """Internal signal that a setup step failed with a classified code.

    Carries the taxonomy ``code`` (§7.1) so the retry loop can decide whether
    to auto-retry (transient) or surface immediately (permanent), and a
    human-facing ``message`` for the emitted error event.
    """

    def __init__(self, code: str, message: Optional[str] = None, raw: str = "") -> None:
        self.code = code
        self.message = message or _CODE_MESSAGES.get(code, _CODE_MESSAGES[ErrorCode.UNKNOWN])
        self.raw = raw
        super().__init__(self.message)


class SetupManager:
    def __init__(self) -> None:
        self._progress_callbacks: List[Callable[[dict], None]] = []
        # Explicit per-step state machine (§6.1): step id -> StepState.
        self._step_states: Dict[str, str] = {}

    def register_progress_callback(self, cb: Callable[[dict], None]) -> None:
        if cb not in self._progress_callbacks:
            self._progress_callbacks.append(cb)

    # --- Step state machine (§6.1) ---
    def get_step_state(self, step: str) -> str:
        """Current :class:`StepState` for ``step`` (PENDING if never seen)."""
        return self._step_states.get(step, StepState.PENDING)

    def _set_state(self, step: str, state: str) -> bool:
        """Transition ``step`` to ``state``; return True if the state changed.

        Valid transitions (§6.1): pending->running, running->success,
        running->failed, failed->running. Invalid transitions are logged and
        ignored so a stray call can never corrupt the machine. A same-state
        call returns False (no change) — the caller uses this to keep a
        re-completion of an already-done step a true no-op (§6.4).
        """
        current = self.get_step_state(step)
        allowed = {
            StepState.PENDING: {StepState.RUNNING},
            StepState.RUNNING: {StepState.SUCCESS, StepState.FAILED, StepState.RUNNING},
            StepState.FAILED: {StepState.RUNNING},
            StepState.SUCCESS: set(),  # terminal; re-completing is a no-op (§6.4)
        }
        if state == current:
            return False
        if state not in allowed.get(current, set()):
            logger.warning(f"Ignoring invalid transition {step}: {current} -> {state}")
            return False
        self._step_states[step] = state
        return True

    def _emit(
        self,
        step: str,
        status: str,
        message: str = "",
        percent: Optional[int] = None,
        progress: Optional[Dict[str, int]] = None,
        error: Optional[Dict[str, object]] = None,
    ) -> None:
        """Emit a ``setup_progress`` event.

        Existing keys (``type``/``step``/``status``/``message``/``percent``)
        are preserved unchanged. ``progress`` and ``error`` are ADDITIVE:

        - ``progress``: ``{"current": <bytes>, "total": <bytes>}`` — real
          aggregated byte counts from the streamed pull (§3.3, §5.4).
        - ``error``: ``{"code": <ErrorCode>, "transient": <bool>}`` — taxonomy
          code so Workstream E renders exactly one recovery button (§7.1).
        """
        event = {
            "type": "setup_progress",
            "step": step,
            "status": status,  # pending | running | done | error
            "message": message,
        }
        if percent is not None:
            event["percent"] = percent
        if progress is not None:
            event["progress"] = progress
        if error is not None:
            event["error"] = error
        for cb in list(self._progress_callbacks):
            try:
                cb(event)
            except Exception:
                pass

    def _emit_state(
        self,
        step: str,
        state: str,
        message: str = "",
        percent: Optional[int] = None,
        progress: Optional[Dict[str, int]] = None,
        error: Optional[Dict[str, object]] = None,
    ) -> None:
        """Transition the state machine and emit the mapped event together.

        Suppresses the emit only for a redundant re-entry into a *terminal*
        state (SUCCESS/FAILED that didn't change) so re-completing a done step
        is a true no-op (§6.4). A repeated RUNNING is allowed to emit — the
        retry loop re-emits RUNNING each attempt to restart the live stream.
        """
        changed = self._set_state(step, state)
        if not changed and state in (StepState.SUCCESS, StepState.FAILED):
            return
        self._emit(
            step,
            _STATE_TO_EMIT_STATUS[state],
            message,
            percent=percent,
            progress=progress,
            error=error,
        )

    # --- Auto-retry with backoff (§6.2) ---
    # Silent-retry backoff schedule: 2s -> 5s -> 10s, up to 3 retries.
    _BACKOFF_SCHEDULE: Tuple[int, ...] = (2, 5, 10)

    def _run_step_with_retry(
        self,
        step: str,
        attempt: Callable[[], None],
        running_message: str,
        sleep: Callable[[float], None] = time.sleep,
    ) -> bool:
        """Run ``attempt`` for ``step`` with silent auto-retry (§6.2).

        ``attempt`` performs one try of the step and raises ``_StepFailure``
        (classified) on failure or returns normally on success. On a
        *transient* failure we retry silently up to 3 times with backoff
        (2s -> 5s -> 10s) before surfacing anything to the user. A *permanent*
        failure surfaces immediately with no retry (§6.3).

        ``sleep`` is injected so tests patch it to run instantly. Returns True
        on eventual success, False once the failure has been surfaced.
        """
        max_retries = len(self._BACKOFF_SCHEDULE)
        for attempt_idx in range(max_retries + 1):  # initial try + up to 3 retries
            # failed -> running on retry; pending/failed -> running on first try.
            self._emit_state(step, StepState.RUNNING, running_message)
            try:
                attempt()
                return True
            except _StepFailure as failure:
                transient = is_transient(failure.code)
                have_retries_left = attempt_idx < max_retries
                if transient and have_retries_left:
                    delay = self._BACKOFF_SCHEDULE[attempt_idx]
                    logger.warning(
                        f"[{step}] transient failure ({failure.code}); "
                        f"silent retry {attempt_idx + 1}/{max_retries} in {delay}s"
                    )
                    sleep(delay)
                    continue
                # Permanent, or transient with retries exhausted -> surface.
                logger.error(
                    f"[{step}] surfacing failure code={failure.code} "
                    f"transient={transient}: {failure.raw or failure.message}"
                )
                self._emit_state(
                    step,
                    StepState.FAILED,
                    failure.message,
                    error={"code": failure.code, "transient": transient},
                )
                return False
        return False  # unreachable, kept for clarity

    # --- Preflight checks (§7.2) ---
    def _preflight(self, disk_target: str) -> Optional[_StepFailure]:
        """Run the A-provided preflight checks before any risky pull (§7.2).

        Returns a classified ``_StepFailure`` for the first failing check, or
        ``None`` if all pass. Docker responsiveness and DNS are transient
        (auto-retry); disk-full is permanent (surface immediately).
        """
        if not docker_mgr.is_docker_api_responsive():
            return _StepFailure(ErrorCode.DOCKER_UNRESPONSIVE, raw="Docker API not responsive")
        if not docker_mgr.check_dns(REGISTRY_HOST):
            return _StepFailure(ErrorCode.DNS_FAILURE, raw=f"DNS resolution failed for {REGISTRY_HOST}")
        if not docker_mgr.check_disk_space(disk_target, _DOWNLOADER_REQUIRED_BYTES):
            return _StepFailure(ErrorCode.DISK_FULL, raw="Insufficient disk space for image")
        return None

    def _pull_image_step(self, step: str, image: str, disk_target: str) -> None:
        """One idempotent attempt at pulling ``image`` (§6.4, §3.3, §7.2).

        Idempotent: if the image is already present this returns immediately as
        a no-op success (no re-pull, no half state). Otherwise runs preflight,
        then streams the pull, aggregating REAL per-layer byte counts and
        emitting real percent — never fabricated (§5.4). Raises ``_StepFailure``
        on any failure so the caller's retry loop can classify/retry.
        """
        # Idempotency (§6.4): already-present image is a no-op success.
        if docker_mgr.image_exists(image):
            self._emit_state(step, StepState.RUNNING, "Already present")
            return  # caller marks SUCCESS

        # Preflight (§7.2): fail fast with a classified error before pulling.
        pf = self._preflight(disk_target)
        if pf is not None:
            raise pf

        # Real streaming progress (§3.3, §5.4): aggregate per-layer bytes.
        layer_bytes: Dict[str, Dict[str, int]] = {}
        captured_error: List[str] = []

        def on_progress(event: dict) -> None:
            if not isinstance(event, dict):
                return
            err = event.get("error")
            if err:
                captured_error.append(str(err))
                return
            layer_id = event.get("id")
            detail = event.get("progressDetail") or {}
            current = detail.get("current")
            total = detail.get("total")
            if layer_id and isinstance(total, int) and total > 0 and isinstance(current, int):
                # Latest current/total wins per layer (monotonic per layer).
                layer_bytes[layer_id] = {"current": current, "total": total}
                agg_current = sum(l["current"] for l in layer_bytes.values())
                agg_total = sum(l["total"] for l in layer_bytes.values())
                if agg_total > 0:
                    percent = int(agg_current * 100 / agg_total)
                    # Clamp defensively; never exceed 100 from partial layer data.
                    percent = max(0, min(100, percent))
                    self._emit(
                        step,
                        "running",
                        event.get("status", "Downloading"),
                        percent=percent,
                        progress={"current": agg_current, "total": agg_total},
                    )

        ok = docker_mgr.pull_image_streaming(image, on_progress)
        if not ok:
            raw = captured_error[0] if captured_error else "pull_image_streaming returned False"
            raise _StepFailure(classify_error(raw), raw=raw)

    # --- System checks ---
    def check_system(self) -> Dict:
        """Return a system-readiness report for the wizard's Screen 2."""
        win_ok = platform.system() == "Windows"
        win_ver = platform.version()
        docker_installed = self._docker_installed()
        docker_running = docker_mgr.is_docker_running()
        wsl_ok = self._wsl_available()

        return {
            "windows": {
                "ok": win_ok,
                "version": win_ver,
                "label": "Windows 10/11" if win_ok else f"{platform.system()} (unsupported)",
            },
            "docker": {
                "installed": docker_installed,
                "running": docker_running,
                "download_url": DOCKER_DESKTOP_URL,
            },
            "wsl2": {"ok": wsl_ok},
            "images": {
                "downloader": docker_mgr.image_exists(DOWNLOADER_IMAGE),
                "wrapper": docker_mgr.image_exists(WRAPPER_IMAGE),
            },
        }

    def _docker_installed(self) -> bool:
        if shutil.which("docker"):
            return True
        return any(
            os.path.exists(p)
            for p in (
                r"C:\Program Files\Docker\Docker\Docker Desktop.exe",
                r"C:\Program Files\Docker\Docker\resources\bin\docker.exe",
            )
        )

    def _wsl_available(self) -> bool:
        if platform.system() != "Windows":
            return False
        try:
            result = subprocess.run(
                ["wsl", "--status"],
                capture_output=True,
                timeout=10,
                text=True,
            )
            return result.returncode == 0
        except (OSError, subprocess.SubprocessError):
            return False

    # --- Image setup (runs in a background thread) ---
    def run_image_setup(self) -> None:
        """Pull the downloader image and build the wrapper image.

        Fully automatic: the wrapper image is built from the upstream release
        (download -> extract -> generate Dockerfile -> docker build), so no
        user-supplied Dockerfile or Settings path is ever required.

        Idempotent (§6.4): safe to re-call after a partial failure — present
        images are no-op successes, an already-complete run re-emits success
        without side effects.
        """
        threading.Thread(
            target=self._run_image_setup_blocking,
            daemon=True,
        ).start()

    def _run_image_setup_blocking(
        self,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        """Blocking orchestration of the image-setup steps.

        Runs synchronously (the thread wrapper is ``run_image_setup``) so tests
        can call it directly and patch ``sleep`` for instant backoff. Each step
        is idempotent and classified; a surfaced failure stops the run (the
        user retries that step via the same code path — §6.3/§6.4).
        """
        disk_target = self._disk_target()

        # 1) Pull downloader (streaming + preflight + auto-retry).
        ok = self._run_step_with_retry(
            "pull_downloader",
            lambda: self._pull_image_step("pull_downloader", DOWNLOADER_IMAGE, disk_target),
            "Pulling apple-music-downloader...",
            sleep=sleep,
        )
        if not ok:
            return
        self._emit_state("pull_downloader", StepState.SUCCESS, "Pulled")

        # 2) Build wrapper from source (idempotent: present image is a no-op).
        build_ok = self._run_step_with_retry(
            "build_wrapper",
            self._build_wrapper_step,
            "Building wrapper image...",
            sleep=sleep,
        )
        if not build_ok:
            return
        self._emit_state("build_wrapper", StepState.SUCCESS, "Built")

        self._emit_state("complete", StepState.RUNNING, "Finishing setup...")
        self._emit_state("complete", StepState.SUCCESS, "Setup complete")


    def _disk_target(self) -> str:
        """Filesystem path used for the disk-space preflight (§7.2)."""
        target = get_settings().get("wrapper_data_path") or os.path.expanduser("~")
        # If the configured path doesn't exist yet, fall back to its drive root.
        if not os.path.exists(target):
            drive = os.path.splitdrive(os.path.abspath(target))[0]
            target = (drive + os.sep) if drive else os.path.expanduser("~")
        return target

    def _wrapper_work_dir(self) -> str:
        """Directory the wrapper source is unpacked into and built from.

        Derived from ``wrapper_data_path`` (which points at
        ``<wrapper>/rootfs/data``) so the extracted ``rootfs`` lands exactly
        where the running container expects its bind mount. Falls back to a
        directory next to the backend if the setting is unusable.
        """
        data_path = get_settings().get("wrapper_data_path") or ""
        # ".../wrapper/rootfs/data" -> ".../wrapper"
        marker = os.path.join("rootfs", "data")
        normalised = os.path.normpath(data_path) if data_path else ""
        if normalised and normalised.lower().endswith(marker.lower()):
            return os.path.dirname(os.path.dirname(normalised))
        if normalised:
            return normalised
        return os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "wrapper")

    def _download_file(self, url: str, dest: str) -> None:
        """Stream ``url`` to ``dest``. Raises on any network/IO error."""
        os.makedirs(os.path.dirname(dest) or ".", exist_ok=True)
        # Explicit UA: bare urllib is rejected by some GitHub edge nodes.
        request = urllib.request.Request(url, headers={"User-Agent": "Audora"})
        with urllib.request.urlopen(request, timeout=60) as response:
            with open(dest, "wb") as out:
                shutil.copyfileobj(response, out, length=1024 * 256)

    def _extract_archive(self, archive: str, dest: str) -> None:
        """Extract the wrapper zip into ``dest``. Raises on a bad archive."""
        os.makedirs(dest, exist_ok=True)
        with zipfile.ZipFile(archive) as zf:
            zf.extractall(dest)

    def _write_dockerfile(self, context: str) -> str:
        """Write the pinned Dockerfile into ``context``, returning its path.

        Called AFTER extraction on purpose: the release ships its own
        Dockerfile, and ours must be the one that survives.
        """
        os.makedirs(context, exist_ok=True)
        path = os.path.join(context, "Dockerfile")
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            f.write(WRAPPER_DOCKERFILE)
        return path

    def _docker_build_wrapper(self, context: str) -> None:
        """``docker build -t wrapper <context>``. Raises on failure."""
        client = docker_mgr.get_client()
        if client is None:
            raise _StepFailure(ErrorCode.DOCKER_UNRESPONSIVE, raw="Docker client is None")
        _image, logs = client.images.build(path=context, tag=WRAPPER_IMAGE, rm=True)
        for chunk in logs:
            if isinstance(chunk, dict) and "stream" in chunk:
                line = str(chunk["stream"]).strip()
                if line:
                    logger.info(f"[wrapper build] {line}")

    def _build_wrapper_step(self) -> None:
        """One idempotent attempt at building the wrapper image from source.

        Downloads the upstream release, extracts it, generates the Dockerfile,
        and builds — emitting a ``setup_progress`` event per stage in the same
        schema the streamed pull uses. Raises ``_StepFailure`` (classified) so
        the caller's retry loop can auto-retry transient network failures.

        Requires no user configuration whatsoever.
        """
        step = "build_wrapper"

        # Idempotency (§6.4): already-built image is a no-op success.
        if docker_mgr.image_exists(WRAPPER_IMAGE):
            self._emit_state(step, StepState.RUNNING, "Already built")
            return  # caller marks SUCCESS

        context = self._wrapper_work_dir()
        archive = os.path.join(context, WRAPPER_ASSET_NAME)

        # 1) Download the release archive.
        self._emit(step, "running", "Downloading wrapper...")
        try:
            self._download_file(WRAPPER_RELEASE_URL, archive)
        except Exception as e:
            logger.error(f"Wrapper download failed: {e}")
            raise _StepFailure(
                classify_error(str(e)),
                "Could not download the wrapper component.",
                raw=str(e),
            )

        # 2) Extract it (flat: ``wrapper`` + ``rootfs/`` land at the root).
        self._emit(step, "running", "Extracting wrapper...")
        try:
            self._extract_archive(archive, context)
        except Exception as e:
            logger.error(f"Wrapper extract failed: {e}")
            raise _StepFailure(
                ErrorCode.UNKNOWN,
                "The downloaded wrapper component could not be unpacked.",
                raw=str(e),
            )
        finally:
            # The build context is COPY'd wholesale into the image, so the
            # ~48MB archive must not linger there. Removal is best-effort:
            # failing to tidy up must never fail the build.
            try:
                os.remove(archive)
            except OSError as cleanup_error:
                logger.warning(f"Could not remove {archive}: {cleanup_error}")

        # 3) Generate the Dockerfile — after extraction, so ours wins.
        self._emit(step, "running", "Generating Dockerfile...")
        try:
            self._write_dockerfile(context)
        except Exception as e:
            logger.error(f"Wrapper Dockerfile write failed: {e}")
            raise _StepFailure(
                ErrorCode.UNKNOWN,
                "Could not prepare the wrapper build.",
                raw=str(e),
            )

        # 4) Build the image.
        self._emit(step, "running", "Building wrapper image...")
        try:
            self._docker_build_wrapper(context)
        except _StepFailure:
            raise
        except Exception as e:
            logger.error(f"Wrapper build failed: {e}")
            raise _StepFailure(classify_error(str(e)), "Build failed — see logs", raw=str(e))


    def mark_complete(self) -> None:
        update_settings({"setup_complete": True})

    def is_complete(self) -> bool:
        return bool(get_settings().get("setup_complete", False))


setup_mgr = SetupManager()
