"""Pin and verify the public downloader image used for ALAC and FLAC conversion."""
from typing import Callable, Optional

from docker_manager import docker_mgr
from logger import get_logger

logger = get_logger("downloader-image")

# Keep the downloader and setup pull on the same verified public image.
UPSTREAM_DOWNLOADER_IMAGE = (
    "ghcr.io/zhaarey/apple-music-downloader@"
    "sha256:d7e601189d825b456b41c4658683b6952a8f1de0f345b45de15f1b775faad928"
)

# The image Audora actually runs, both for downloading and for converting.
AUDORA_DOWNLOADER_IMAGE = "audora-downloader:2"

# v0.1.4 already includes ffmpeg. A dedicated tag distinguishes this verified
# version from Audora's older local image, which used a different config schema.


def image_is_built() -> bool:
    """True when the derived image already exists locally."""
    return docker_mgr.image_exists(AUDORA_DOWNLOADER_IMAGE)


def build_downloader_image(
    on_log: Optional[Callable[[str], None]] = None,
    *,
    force: bool = False,
) -> None:
    """Tag the pinned upstream runtime without rebuilding or another image pull."""
    if not force and image_is_built():
        logger.info(f"{AUDORA_DOWNLOADER_IMAGE} already prepared")
        return

    client = docker_mgr.get_client()
    if client is None:
        raise RuntimeError("Docker client unavailable; cannot prepare downloader image")

    try:
        image = client.images.get(UPSTREAM_DOWNLOADER_IMAGE)
    except Exception as image_error:
        raise RuntimeError("The pinned downloader image must be pulled before FLAC setup") from image_error
    if not image.tag("audora-downloader", tag="2", force=True):
        raise RuntimeError("Docker could not tag the pinned downloader image")
    logger.info(f"Prepared {AUDORA_DOWNLOADER_IMAGE} from the pinned public image")
    if on_log is not None:
        on_log("Tagged downloader image; checking FFmpeg...")


def verify_ffmpeg_present() -> bool:
    """Run ``ffmpeg -version`` inside the built image.

    Checked at setup time on purpose: a missing ffmpeg discovered here is a
    clear, actionable setup failure, whereas the same problem discovered at
    conversion time would strand a finished download in a broken state.
    Raises with the actual probe failure rather than mislabeling every error
    as a missing binary.
    """
    client = docker_mgr.get_client()
    if client is None:
        raise RuntimeError("Docker engine unavailable while checking FFmpeg")
    try:
        output = client.containers.run(
            AUDORA_DOWNLOADER_IMAGE,
            entrypoint="ffmpeg",
            command=["-version"],
            remove=True,
            network_mode="none",
            # SDK run() returns None with the engine's `local` logging driver.
            # Override only this disposable probe, leaving host policy intact.
            log_config={"type": "json-file"},
            stderr=True,
        )
    except Exception as probe_error:
        logger.error(f"ffmpeg probe failed in {AUDORA_DOWNLOADER_IMAGE}: {probe_error}")
        raise RuntimeError(f"FFmpeg check failed in {AUDORA_DOWNLOADER_IMAGE}: {probe_error}") from probe_error

    if not output:
        raise RuntimeError("FFmpeg exited successfully, but Docker returned no version output")

    text = output.decode("utf-8", errors="replace") if isinstance(output, bytes) else str(output)
    present = "ffmpeg version" in text.lower()
    if present:
        logger.info(f"ffmpeg verified: {text.strip().splitlines()[0]}")
    else:
        raise RuntimeError(f"Unexpected FFmpeg version output: {text[:1000]}")
    return present
