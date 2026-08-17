"""Convert the downloaded lossless ALAC into FLAC.

Why Audora converts instead of the downloader
---------------------------------------------
The upstream downloader has its own ``convert-*`` config keys, but Audora does
not use them, for two concrete reasons:

* Its behaviour is unverified, and it ships ``convert-keep-original: false``.
  If its conversion failed, the ALAC source would already be deleted and the
  album would produce nothing at all — strictly worse than shipping no
  conversion.
* Audora needs an honest progress signal and a validated result. Doing the pass
  here means every output is checked before the matching source is removed, and
  the UI can report a real converted/total count rather than a guess.

Why FLAC at all
---------------
ALAC and FLAC are both lossless, so this is a container/codec change with no
quality loss. The reason it matters is playback: Chromium (and therefore
Electron) has no ALAC decoder, so an ``.m4a`` ALAC file is fetched successfully
and then silently fails to decode — duration stays at zero and the player never
starts. Chromium does decode raw FLAC, so FLAC is the format that makes
Audora's own player work.

ffmpeg runs inside ``audora-downloader`` (see ``downloader_image``) so the user
never installs anything.
"""
import os
from typing import Callable, Dict, List, Optional, Sequence, Set

from docker_manager import docker_mgr
from downloader_image import AUDORA_DOWNLOADER_IMAGE
from logger import get_logger
from utils import windows_to_docker_path

logger = get_logger("flac")

SOURCE_EXTENSION = ".m4a"
TARGET_EXTENSION = ".flac"

# Container-side root of the downloads bind mount, matching download_manager.
CONTAINER_DOWNLOADS = "/downloads"

# First four bytes of a valid FLAC stream ("fLaC" marker, FLAC spec §8.1).
_FLAC_MAGIC = b"fLaC"

# A real encoded track is far larger than this; anything smaller means ffmpeg
# produced a stub before dying.
_MIN_PLAUSIBLE_FLAC_BYTES = 4096

# Level 5 is ffmpeg's default: past it the encoder spends noticeably more CPU
# for a fraction of a percent of size, which the user pays for as wait time.
_FLAC_COMPRESSION_LEVEL = 5


def snapshot_sources(downloads_path: str) -> Set[str]:
    """Every ALAC file present right now, as absolute paths.

    Taken *before* a download so the files it produces can be identified by set
    difference afterwards. This is deliberate: a modification-time cutoff would
    depend on host and container clocks agreeing, and would also sweep up any
    unrelated ALAC the user happens to keep in the folder.
    """
    return set(_walk_sources(downloads_path))


def find_new_sources(downloads_path: str, before: Set[str]) -> List[str]:
    """ALAC files that appeared since ``before`` was taken."""
    return sorted(set(_walk_sources(downloads_path)) - before)


def _walk_sources(downloads_path: str) -> List[str]:
    if not downloads_path or not os.path.isdir(downloads_path):
        return []
    found: List[str] = []
    for root, _directories, filenames in os.walk(downloads_path):
        for filename in filenames:
            if filename.lower().endswith(SOURCE_EXTENSION):
                found.append(os.path.abspath(os.path.join(root, filename)))
    return found


def target_path_for(source_path: str) -> str:
    """The .flac path a given .m4a converts to (same folder, same stem)."""
    stem, _extension = os.path.splitext(source_path)
    return stem + TARGET_EXTENSION


def is_valid_flac(path: str) -> bool:
    """Whether ``path`` looks like a real FLAC file.

    Checks the magic marker and a plausible size rather than decoding: ffmpeg
    exiting non-zero is the primary failure signal, and this guards the case
    where it exits cleanly having written a truncated or empty file.
    """
    try:
        if os.path.getsize(path) < _MIN_PLAUSIBLE_FLAC_BYTES:
            return False
        with open(path, "rb") as handle:
            return handle.read(4) == _FLAC_MAGIC
    except OSError:
        return False


def _ffmpeg_command(container_source: str, container_target: str) -> List[str]:
    """ffmpeg arguments for a lossless ALAC -> FLAC transcode with tags + art.

    ``-map 0:v?`` and the ``attached_pic`` disposition are what carry embedded
    cover art across: ffmpeg exposes an MP4 ``covr`` atom as a video stream,
    and FLAC stores artwork in a PICTURE metadata block. Without these the
    library's album art would silently disappear.
    """
    return [
        "-nostdin",
        "-hide_banner",
        "-loglevel", "error",
        "-y",
        "-i", container_source,
        "-map", "0:a",
        "-map", "0:v?",
        "-c:a", "flac",
        "-compression_level", str(_FLAC_COMPRESSION_LEVEL),
        "-c:v", "copy",
        "-disposition:v", "attached_pic",
        "-map_metadata", "0",
        container_target,
    ]


def _to_container_path(host_path: str, downloads_path: str) -> str:
    """Map a host path under the downloads folder to its container path."""
    relative = os.path.relpath(host_path, downloads_path).replace("\\", "/")
    return f"{CONTAINER_DOWNLOADS}/{relative}"


def convert_one(source_path: str, downloads_path: str) -> bool:
    """Convert a single ALAC file to FLAC and delete the source on success.

    The source is removed only after the output validates, so a failed
    conversion always leaves the original in place to retry.
    """
    target_path = target_path_for(source_path)
    client = docker_mgr.get_client()
    if client is None:
        logger.error("Docker unavailable; cannot convert to FLAC")
        return False

    command = _ffmpeg_command(
        _to_container_path(source_path, downloads_path),
        _to_container_path(target_path, downloads_path),
    )
    try:
        client.containers.run(
            AUDORA_DOWNLOADER_IMAGE,
            entrypoint="ffmpeg",
            command=command,
            volumes={
                windows_to_docker_path(downloads_path): {
                    "bind": CONTAINER_DOWNLOADS,
                    "mode": "rw",
                }
            },
            # Conversion is purely local file work; no network is required.
            network_mode="none",
            remove=True,
        )
    except Exception as convert_error:
        logger.error(f"ffmpeg failed for {os.path.basename(source_path)}: {convert_error}")
        _discard_partial(target_path)
        return False

    if not is_valid_flac(target_path):
        logger.error(f"Conversion produced an invalid FLAC for {os.path.basename(source_path)}")
        _discard_partial(target_path)
        return False

    try:
        os.remove(source_path)
    except OSError as remove_error:
        # The FLAC is valid, so the track is playable and the run counts as a
        # success; a stale source is cosmetic and must not fail the download.
        logger.warning(f"Converted but could not remove {source_path}: {remove_error}")

    logger.info(f"Converted to FLAC: {os.path.basename(target_path)}")
    return True


def _discard_partial(target_path: str) -> None:
    """Remove a half-written output so a retry starts clean."""
    try:
        if os.path.exists(target_path):
            os.remove(target_path)
    except OSError:
        pass


def convert_all(
    source_paths: Sequence[str],
    downloads_path: str,
    on_progress: Optional[Callable[[int, int, str], None]] = None,
    should_continue: Optional[Callable[[], bool]] = None,
) -> Dict:
    """Convert every source to FLAC, reporting real progress as it goes.

    ``on_progress`` is called with ``(converted, total, track_name)`` after each
    file. The count is genuine — the UI derives its percentage from it rather
    than from an invented figure. ``should_continue`` lets a cancelled download
    stop between files.

    Returns ``{"ok", "converted", "failed", "total", "outputs"}`` where ``ok``
    is True only when every source converted, so the caller can refuse to
    report a download as finished otherwise.
    """
    total = len(source_paths)
    converted = 0
    failed: List[str] = []
    outputs: List[str] = []

    for source_path in source_paths:
        if should_continue is not None and not should_continue():
            logger.info("FLAC conversion stopped early (cancelled)")
            break

        track_name = os.path.splitext(os.path.basename(source_path))[0]
        if convert_one(source_path, downloads_path):
            converted += 1
            outputs.append(target_path_for(source_path))
        else:
            failed.append(track_name)

        if on_progress is not None:
            on_progress(converted, total, track_name)

    return {
        "ok": total > 0 and converted == total and not failed,
        "converted": converted,
        "failed": failed,
        "total": total,
        "outputs": outputs,
    }
