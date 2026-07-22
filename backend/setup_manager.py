"""First-run setup: system checks, image pull/build, progress events.

Docker Desktop *installation* is intentionally not silent — on Windows it
needs UAC and a reboot. We detect its absence and hand the user a download
link (surfaced by the wizard); we do not try to run the installer headless.
"""
import os
import platform
import shutil
import subprocess
import threading
from typing import Callable, Dict, List, Optional

from docker_manager import docker_mgr
from settings import get_settings, update_settings
from logger import get_logger

logger = get_logger("setup")

DOWNLOADER_IMAGE = "ghcr.io/zhaarey/apple-music-downloader"
WRAPPER_IMAGE = "wrapper"
DOCKER_DESKTOP_URL = "https://www.docker.com/products/docker-desktop/"


class SetupManager:
    def __init__(self) -> None:
        self._progress_callbacks: List[Callable[[dict], None]] = []

    def register_progress_callback(self, cb: Callable[[dict], None]) -> None:
        if cb not in self._progress_callbacks:
            self._progress_callbacks.append(cb)

    def _emit(self, step: str, status: str, message: str = "", percent: Optional[int] = None) -> None:
        event = {
            "type": "setup_progress",
            "step": step,
            "status": status,  # pending | running | done | error
            "message": message,
        }
        if percent is not None:
            event["percent"] = percent
        for cb in list(self._progress_callbacks):
            try:
                cb(event)
            except Exception:
                pass

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
    def run_image_setup(self, wrapper_build_context: Optional[str] = None) -> None:
        """Pull the downloader image and build the wrapper image.

        wrapper_build_context: path to a directory containing the wrapper
        Dockerfile. If None or missing, the wrapper build step is skipped
        with a warning (the user can point at it later in Settings).
        """
        threading.Thread(
            target=self._run_image_setup_blocking,
            args=(wrapper_build_context,),
            daemon=True,
        ).start()

    def _run_image_setup_blocking(self, wrapper_build_context: Optional[str]) -> None:
        # 1) Pull downloader
        self._emit("pull_downloader", "running", "Pulling apple-music-downloader...")
        if docker_mgr.image_exists(DOWNLOADER_IMAGE):
            self._emit("pull_downloader", "done", "Already present")
        elif docker_mgr.pull_image(DOWNLOADER_IMAGE):
            self._emit("pull_downloader", "done", "Pulled")
        else:
            self._emit("pull_downloader", "error", "Failed to pull downloader image")
            return

        # 2) Build wrapper
        self._emit("build_wrapper", "running", "Building wrapper image...")
        if docker_mgr.image_exists(WRAPPER_IMAGE):
            self._emit("build_wrapper", "done", "Already built")
        elif wrapper_build_context and os.path.isdir(wrapper_build_context):
            ok = self._build_wrapper(wrapper_build_context)
            self._emit(
                "build_wrapper",
                "done" if ok else "error",
                "Built" if ok else "Build failed — see logs",
            )
        else:
            self._emit(
                "build_wrapper",
                "error",
                "Wrapper Dockerfile not found; set it in Settings and retry.",
            )
            return

        self._emit("complete", "done", "Setup complete")

    def _build_wrapper(self, context: str) -> bool:
        client = docker_mgr.get_client()
        if client is None:
            return False
        try:
            _image, logs = client.images.build(path=context, tag=WRAPPER_IMAGE, rm=True)
            for chunk in logs:
                if "stream" in chunk:
                    line = chunk["stream"].strip()
                    if line:
                        logger.info(f"[wrapper build] {line}")
            return True
        except Exception as e:
            logger.error(f"Wrapper build failed: {e}")
            return False

    def mark_complete(self) -> None:
        update_settings({"setup_complete": True})

    def is_complete(self) -> bool:
        return bool(get_settings().get("setup_complete", False))


setup_mgr = SetupManager()
