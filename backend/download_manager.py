"""Manages the apple-music-downloader container lifecycle and output.

Docker invocation (verified in task.md):
  Album: audora-downloader <url>
  Song:  add --song
  Network: host (to reach wrapper ports 10020/20020/30020)
  Volume:  {downloads_path} -> /downloads

Two stages, one job
-------------------
A download is not finished when the downloader exits. Audora always fetches the
lossless ALAC source and then converts it to FLAC (``flac_converter``), because
Chromium — and therefore Electron — has no ALAC decoder and could never play an
``.m4a`` back. Both stages are reported to the UI, and the job is only
``completed`` once every FLAC exists and validates. A conversion failure is
reported as ``convert_failed``, never as success.
"""
import asyncio
import os
from typing import Callable, Dict, List, Optional

import downloader_config
import flac_converter
from docker_manager import docker_mgr
from downloader_image import AUDORA_DOWNLOADER_IMAGE
from settings import get_settings
from logger import get_logger
from utils import validate_apple_music_url, windows_to_docker_path, url_kind
import progress as progress_parser

logger = get_logger("download")

# Container name kept as-is across the FLAC rework: renaming it would orphan
# any container left behind by an earlier version, since start_container only
# force-removes a stale container matching THIS name.
DOWNLOADER_CONTAINER_NAME = "audora-downloader"

# Stage names shared with the frontend (see ws/progress contract in app.py).
STAGE_DOWNLOADING = "downloading"
STAGE_CONVERTING = "converting"
STAGE_READY = "ready"

# Where the generated config.yaml is kept on the host, next to the backend's
# other runtime state (mirrors settings.py's data/ convention).
_BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_DIR = os.path.join(_BASE_DIR, "data", "downloader")


class DownloadManager:
    def __init__(self) -> None:
        self._container_id: Optional[str] = None
        self._current_url: Optional[str] = None
        self._is_running = False
        self._progress_callbacks: List[Callable[[dict], None]] = []
        # Called with a summary dict when a download finishes (for history/queue).
        self._completion_callbacks: List[Callable[[dict], None]] = []
        self._last_summary: Optional[dict] = None
        # Set at the start of each run so the conversion stage knows which files
        # this download produced, and where they live.
        self._downloads_path: Optional[str] = None
        self._sources_before: set = set()

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
    def _build_command(self, url: str) -> List[str]:
        """Downloader arguments for ``url``.

        No codec flag is passed: --aac and --atmos would fetch a lossy or
        spatial mix, and Audora always wants the lossless ALAC default so it has
        something worth converting to FLAC.
        """
        url = url.strip()
        command: List[str] = []
        kind = url_kind(url)
        if kind == "song":
            command.append("--song")
        elif kind == "artist":
            command.append("--all-album")
        command.append(url)
        return command

    # --- Lifecycle ---
    async def start_download(self, url: str) -> bool:
        url = url.strip()
        if self._is_running:
            logger.warning("A download is already running")
            return False
        if not validate_apple_music_url(url):
            logger.error(f"Invalid Apple Music URL: {url}")
            return False

        settings = get_settings()
        downloads_path = settings.get("downloads_path")

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

        # The published image ships a malformed /app/config.yaml and no
        # config.yaml.example to copy from, so Audora supplies its own and
        # mounts it over the broken one. Regenerated every run so an upgrade
        # can never leave a stale config behind.
        try:
            host_config_path = downloader_config.write_config(CONFIG_DIR)
        except OSError as config_error:
            logger.error(f"Cannot write downloader config: {config_error}")
            return False

        # Snapshot the existing ALAC files so the conversion stage can identify
        # exactly what this run produced (see flac_converter.snapshot_sources).
        self._downloads_path = downloads_path
        self._sources_before = flac_converter.snapshot_sources(downloads_path)

        docker_downloads = windows_to_docker_path(downloads_path)
        docker_config = windows_to_docker_path(host_config_path)
        config = {
            "image": AUDORA_DOWNLOADER_IMAGE,
            "name": DOWNLOADER_CONTAINER_NAME,
            "command": self._build_command(url),
            "volumes": {
                docker_downloads: {"bind": "/downloads", "mode": "rw"},
                # Read-only: the container never rewrites its config, and
                # Audora regenerates it before every run.
                docker_config: {
                    "bind": downloader_config.CONTAINER_CONFIG_PATH,
                    "mode": "ro",
                },
            },
            "network_mode": "host",
            "stdin_open": True,   # piped stdin prevents interactive retry loops
            "tty": False,
            "detach": True,
            # No working_dir override: the binary opens "config.yaml" by
            # relative path, so it must run from the image's own WORKDIR
            # (/app). Pointing this at /downloads is what produced
            # "open config.yaml: no such file or directory".
        }

        container = docker_mgr.start_container(config)
        if container is None:
            return False

        self._container_id = container.id
        self._current_url = url
        self._is_running = True
        logger.info(f"Download started for {url}")
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
                        "stage": STAGE_DOWNLOADING,
                        "current_track": current_track,
                        "total_tracks": total_tracks,
                        "track_name": track_name,
                        "status": "downloading",
                        "completed": completed,
                        "failed": failed,
                        "percent": _ratio_percent(current_track, total_tracks),
                    }
                )
        except Exception as e:
            logger.error(f"Download stream error: {e}")
        finally:
            url = self._current_url
            self._container_id = None

            # The download container has exited. Unless the run was cancelled or
            # produced nothing, convert the lossless ALAC it fetched into FLAC
            # before calling the job finished — an unconverted .m4a cannot be
            # played back by Electron, so reporting success here would hand the
            # user a track that silently refuses to play.
            convert_result: Optional[Dict] = None
            download_failed = bool(failed and not completed)
            if not cancelled and not download_failed:
                convert_result = await self._convert_to_flac(track_name)
                # cancel_download() clears _is_running, so losing it here means
                # the user stopped the job mid-conversion rather than a track
                # having failed to convert.
                if not self._is_running:
                    cancelled = True

            self._is_running = False
            status = self._final_status(cancelled, download_failed, convert_result)
            summary = {
                "type": "progress",
                # The stage a terminal event belongs to: a finished job is
                # "ready", a conversion failure stays in "converting" (that is
                # where it broke), and a cancelled or failed download is still
                # attributed to the download stage.
                "stage": (
                    STAGE_READY
                    if status == "completed"
                    else STAGE_CONVERTING
                    if status == "convert_failed"
                    else STAGE_DOWNLOADING
                ),
                "status": status,
                "url": url,
                "current_track": current_track,
                "total_tracks": total_tracks or current_track,
                "completed": completed,
                "failed": failed,
            }
            if convert_result is not None:
                summary["converted"] = convert_result["converted"]
                summary["convert_total"] = convert_result["total"]
                if convert_result["failed"]:
                    summary["convert_failed_tracks"] = convert_result["failed"]
            if status == "completed":
                summary["percent"] = 100
            self._emit_progress(summary)
            self._emit_completion(summary)
            logger.info(f"Download finished: {status} ({completed} ok, {failed} failed)")

    @staticmethod
    def _final_status(
        cancelled: bool,
        download_failed: bool,
        convert_result: Optional[Dict],
    ) -> str:
        """Resolve the terminal status for a run.

        Conversion is part of the job, so a converted-but-incomplete run is
        never ``completed``: it reports ``convert_failed`` so the UI can say so
        plainly instead of claiming a track is ready to play.
        """
        if cancelled:
            return "cancelled"
        if download_failed:
            return "failed"
        if convert_result is None:
            # Nothing was downloaded, so there was nothing to convert.
            return "completed"
        if convert_result["total"] == 0:
            return "completed"
        return "completed" if convert_result["ok"] else "convert_failed"

    async def _convert_to_flac(self, last_track_name: str) -> Optional[Dict]:
        """Run the FLAC conversion stage, reporting real per-file progress."""
        downloads_path = self._downloads_path
        if not downloads_path:
            return None

        new_sources = flac_converter.find_new_sources(downloads_path, self._sources_before)
        if not new_sources:
            logger.info("No new ALAC files to convert")
            return None

        total = len(new_sources)
        logger.info(f"Converting {total} track(s) to FLAC")
        self._emit_progress(
            {
                "type": "progress",
                "stage": STAGE_CONVERTING,
                "status": "converting",
                "track_name": last_track_name,
                "converted": 0,
                "convert_total": total,
                "percent": 0,
            }
        )

        def report(converted: int, convert_total: int, name: str) -> None:
            self._emit_progress(
                {
                    "type": "progress",
                    "stage": STAGE_CONVERTING,
                    "status": "converting",
                    "track_name": name,
                    "converted": converted,
                    "convert_total": convert_total,
                    "percent": _ratio_percent(converted, convert_total),
                }
            )

        # ffmpeg blocks, so run the whole stage off the event loop.
        return await asyncio.to_thread(
            flac_converter.convert_all,
            new_sources,
            downloads_path,
            report,
            lambda: self._is_running,
        )


def _ratio_percent(current: int, total: int) -> int:
    """Whole-number percentage, or 0 when the total is not yet known.

    Never invents a figure: callers with no real total omit ``percent`` entirely
    so the UI can show an indeterminate state instead of a fake number.
    """
    if not total:
        return 0
    return max(0, min(100, int((current / total) * 100)))


dl_mgr = DownloadManager()
