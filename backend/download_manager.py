"""Manages the apple-music-downloader container lifecycle and output.

Docker invocation (verified in task.md):
  Album: ghcr.io/zhaarey/apple-music-downloader <url>
  Song:  add --song
  Atmos: add --atmos
  AAC:   add --aac
  Network: host (to reach wrapper ports 10020/20020/30020)
  Volume:  {downloads_path} -> /downloads
"""
import asyncio
import os
from typing import Callable, Dict, List, Optional

from docker_manager import docker_mgr
from settings import get_settings
from logger import get_logger
from utils import validate_apple_music_url, windows_to_docker_path, url_kind
import progress as progress_parser

logger = get_logger("download")

DOWNLOADER_IMAGE = "ghcr.io/zhaarey/apple-music-downloader"
DOWNLOADER_CONTAINER_NAME = "audora-downloader"


class DownloadManager:
    def __init__(self) -> None:
        self._container_id: Optional[str] = None
        self._current_url: Optional[str] = None
        self._is_running = False
        self._progress_callbacks: List[Callable[[dict], None]] = []
        # Called with a summary dict when a download finishes (for history/queue).
        self._completion_callbacks: List[Callable[[dict], None]] = []
        self._last_summary: Optional[dict] = None

    # --- Callback registration ---
    def register_progress_callback(self, cb: Callable[[dict], None]) -> None:
        if cb not in self._progress_callbacks:
            self._progress_callbacks.append(cb)

    def unregister_progress_callback(self, cb: Callable[[dict], None]) -> None:
        if cb in self._progress_callbacks:
            self._progress_callbacks.remove(cb)

    def register_completion_callback(self, cb: Callable[[dict], None]) -> None:
        if cb not in self._completion_callbacks:
            self._completion_callbacks.append(cb)

    def _emit_progress(self, data: dict) -> None:
        for cb in list(self._progress_callbacks):
            try:
                cb(data)
            except Exception:
                pass

    def _emit_completion(self, summary: dict) -> None:
        self._last_summary = summary
        for cb in list(self._completion_callbacks):
            try:
                cb(summary)
            except Exception:
                pass

    @property
    def is_running(self) -> bool:
        return self._is_running

    # --- Command construction ---
    def _build_command(self, url: str, fmt: str) -> List[str]:
        cmd: List[str] = []
        kind = url_kind(url)
        if kind == "song":
            cmd.append("--song")
        elif kind == "artist":
            cmd.append("--all-album")
        fmt = (fmt or "alac").lower()
        if fmt == "aac":
            cmd.append("--aac")
        elif fmt == "atmos":
            cmd.append("--atmos")
        # ALAC is the default; no flag.
        cmd.append(url)
        return cmd

    # --- Lifecycle ---
    async def start_download(self, url: str, fmt: Optional[str] = None) -> bool:
        if self._is_running:
            logger.warning("A download is already running")
            return False
        if not validate_apple_music_url(url):
            logger.error(f"Invalid Apple Music URL: {url}")
            return False

        settings = get_settings()
        downloads_path = settings.get("downloads_path")
        fmt = fmt or settings.get("download_format", "alac")

        try:
            os.makedirs(downloads_path, exist_ok=True)
        except OSError as e:
            logger.error(f"Cannot create downloads folder {downloads_path}: {e}")
            return False

        # Guard against a full disk before we bother spawning a container.
        try:
            import shutil as _shutil

            free = _shutil.disk_usage(downloads_path).free
            if free < 200 * 1024 * 1024:  # < 200 MB
                logger.error(
                    f"Not enough disk space in {downloads_path} "
                    f"({free // (1024 * 1024)} MB free)"
                )
                return False
        except OSError:
            pass

        docker_downloads = windows_to_docker_path(downloads_path)
        config = {
            "image": DOWNLOADER_IMAGE,
            "name": DOWNLOADER_CONTAINER_NAME,
            "command": self._build_command(url, fmt),
            "volumes": {docker_downloads: {"bind": "/downloads", "mode": "rw"}},
            "network_mode": "host",
            "stdin_open": True,   # piped stdin prevents interactive retry loops
            "tty": False,
            "detach": True,
            "working_dir": "/downloads",
        }

        container = docker_mgr.start_container(config)
        if container is None:
            return False

        self._container_id = container.id
        self._current_url = url
        self._is_running = True
        logger.info(f"Download started for {url} (format={fmt})")
        asyncio.create_task(self._stream_output())
        return True

    async def cancel_download(self) -> bool:
        self._is_running = False
        if self._container_id:
            docker_mgr.stop_container(DOWNLOADER_CONTAINER_NAME, timeout=5)
            self._container_id = None
        logger.info("Download cancelled")
        return True

    async def _stream_output(self) -> None:
        if not self._container_id:
            return

        current_track = 0
        total_tracks = 0
        track_name = ""
        completed = 0
        failed = 0
        cancelled = False

        loop = asyncio.get_event_loop()

        try:
            # stream_logs is a blocking generator; run it off the event loop
            # in a producer thread and consume lines via an async queue.
            queue: asyncio.Queue = asyncio.Queue()

            def producer():
                try:
                    for line in docker_mgr.stream_logs(self._container_id, follow=True):
                        loop.call_soon_threadsafe(queue.put_nowait, line)
                except Exception as e:
                    logger.warning(f"log producer error: {e}")
                finally:
                    loop.call_soon_threadsafe(queue.put_nowait, None)  # sentinel

            import threading

            threading.Thread(target=producer, daemon=True).start()

            while True:
                line = await queue.get()
                if line is None:
                    break
                if not self._is_running:
                    cancelled = True
                    break

                logger.info(f"[downloader] {line}")
                parsed = progress_parser.parse_line(line)
                if parsed:
                    current_track = parsed.get("current_track", current_track)
                    total_tracks = parsed.get("total_tracks", total_tracks)
                    if "track_name" in parsed:
                        track_name = parsed["track_name"]
                    completed += parsed.get("completed_delta", 0)
                    failed += parsed.get("failed_delta", 0)

                self._emit_progress(
                    {
                        "type": "progress",
                        "current_track": current_track,
                        "total_tracks": total_tracks,
                        "track_name": track_name,
                        "status": "downloading",
                        "completed": completed,
                        "failed": failed,
                    }
                )
        except Exception as e:
            logger.error(f"Download stream error: {e}")
        finally:
            self._is_running = False
            url = self._current_url
            self._container_id = None
            status = "cancelled" if cancelled else ("failed" if failed and not completed else "completed")
            summary = {
                "type": "progress",
                "status": status,
                "url": url,
                "current_track": current_track,
                "total_tracks": total_tracks or current_track,
                "completed": completed,
                "failed": failed,
            }
            self._emit_progress(summary)
            self._emit_completion(summary)
            logger.info(f"Download finished: {status} ({completed} ok, {failed} failed)")


dl_mgr = DownloadManager()
