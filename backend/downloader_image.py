"""The Audora-managed downloader image (upstream downloader + ffmpeg).

Why this module exists
---------------------
Audora downloads the lossless ALAC source with
``ghcr.io/zhaarey/apple-music-downloader``, then converts it to FLAC itself
(see ``flac_converter``). That conversion needs ``ffmpeg``, and the user must
never be asked to install it, so Audora builds a thin derived image that adds
ffmpeg on top of the upstream one.

Why the binaries are COPIED rather than installed
-------------------------------------------------
The upstream image's base distribution is not something Audora controls, and a
``RUN apk add`` / ``apt-get install`` would break the moment upstream rebases.
Copying static binaries out of a dedicated ffmpeg image needs no package
manager at all, so this build is correct whatever upstream is based on. It also
keeps the derived layer tiny and reproducible: the ffmpeg version is pinned
here rather than resolved from whatever a mirror serves that day.

Nothing else about upstream is altered — no ``ENTRYPOINT``, ``CMD``, ``WORKDIR``
or config override — so the downloader keeps behaving exactly as before and
``download_manager`` can invoke it unchanged.
"""
import os
from typing import Callable, Optional

from docker_manager import docker_mgr
from logger import get_logger

logger = get_logger("downloader-image")

# Upstream image Audora pulls. Kept here so the derived Dockerfile and the
# setup pull step cannot drift apart.
UPSTREAM_DOWNLOADER_IMAGE = "ghcr.io/zhaarey/apple-music-downloader"

# The image Audora actually runs, both for downloading and for converting.
AUDORA_DOWNLOADER_IMAGE = "audora-downloader"

# Static-ffmpeg source image. Pinned: an unpinned tag would silently change the
# ffmpeg version under the user between builds.
_STATIC_FFMPEG_IMAGE = "mwader/static-ffmpeg:7.1"

# Multi-stage so only the two binaries land in the final image.
AUDORA_DOWNLOADER_DOCKERFILE = f"""FROM {_STATIC_FFMPEG_IMAGE} AS ffmpeg
FROM {UPSTREAM_DOWNLOADER_IMAGE}
COPY --from=ffmpeg /ffmpeg /usr/local/bin/ffmpeg
COPY --from=ffmpeg /ffprobe /usr/local/bin/ffprobe
"""

# Where the generated Dockerfile is written. Mirrors the data/ convention used
# by settings.py and download_manager.py.
_BASE_DIR = os.path.dirname(os.path.abspath(__file__))
BUILD_CONTEXT_DIR = os.path.join(_BASE_DIR, "data", "downloader_image")


def write_dockerfile(directory: str = BUILD_CONTEXT_DIR) -> str:
    """Write the derived Dockerfile and return its path.

    ``newline="\\n"`` because Docker reads the file as Linux text; stray CRs
    from a Windows host corrupt the instructions.
    """
    os.makedirs(directory, exist_ok=True)
    path = os.path.join(directory, "Dockerfile")
    with open(path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(AUDORA_DOWNLOADER_DOCKERFILE)
    return path


def image_is_built() -> bool:
    """True when the derived image already exists locally."""
    return docker_mgr.image_exists(AUDORA_DOWNLOADER_IMAGE)


def build_downloader_image(
    on_log: Optional[Callable[[str], None]] = None,
) -> None:
    """Build ``audora-downloader``. Idempotent; raises on failure.

    An already-built image is a no-op success so this is safe to re-run after a
    partial setup. ``on_log`` receives each build log line for surfacing in the
    setup wizard's terminal.
    """
    if image_is_built():
        logger.info(f"{AUDORA_DOWNLOADER_IMAGE} already built")
        return

    client = docker_mgr.get_client()
    if client is None:
        raise RuntimeError("Docker client unavailable; cannot build downloader image")

    context = os.path.dirname(write_dockerfile())
    logger.info(f"Building {AUDORA_DOWNLOADER_IMAGE} (adds ffmpeg for FLAC conversion)")
    _image, build_logs = client.images.build(
        path=context,
        tag=AUDORA_DOWNLOADER_IMAGE,
        rm=True,
        # Pull both FROM images when needed. The upstream image is normally
        # already present from the preceding setup step, while a clean Docker
        # host still needs the static-ffmpeg stage fetched automatically.
        pull=True,
    )
    for chunk in build_logs:
        if isinstance(chunk, dict) and "stream" in chunk:
            line = str(chunk["stream"]).strip()
            if line:
                logger.info(f"[downloader build] {line}")
                if on_log is not None:
                    on_log(line)


def verify_ffmpeg_present() -> bool:
    """Run ``ffmpeg -version`` inside the built image.

    Checked at setup time on purpose: a missing ffmpeg discovered here is a
    clear, actionable setup failure, whereas the same problem discovered at
    conversion time would strand a finished download in a broken state.
    """
    client = docker_mgr.get_client()
    if client is None:
        return False
    try:
        output = client.containers.run(
            AUDORA_DOWNLOADER_IMAGE,
            entrypoint="ffmpeg",
            command=["-version"],
            remove=True,
            network_mode="none",
        )
    except Exception as probe_error:
        logger.error(f"ffmpeg probe failed in {AUDORA_DOWNLOADER_IMAGE}: {probe_error}")
        return False

    text = output.decode("utf-8", errors="replace") if isinstance(output, bytes) else str(output)
    present = "ffmpeg version" in text.lower()
    if present:
        logger.info(f"ffmpeg verified: {text.strip().splitlines()[0]}")
    else:
        logger.error(f"ffmpeg probe returned unexpected output: {text[:200]}")
    return present
