"""Verify Docker can see the host folder and publish staged FLAC files."""
import os
import shutil
import tempfile
from pathlib import Path

from docker_manager import docker_mgr
from downloader_image import AUDORA_DOWNLOADER_IMAGE
from flac_converter import is_valid_flac
from logger import get_logger
from utils import windows_to_docker_path

logger = get_logger("download-storage")


def docker_sees_folder(folder: str) -> bool:
    client = docker_mgr.get_client()
    if client is None:
        return False
    probe = None
    container = None
    try:
        with tempfile.NamedTemporaryFile(dir=folder, prefix=".audora-mount-", delete=False) as marker:
            probe = Path(marker.name)
            token = os.urandom(24).hex().encode()
            marker.write(token)
        # A successful run() may return None with Docker's local log driver.
        # Compare inside the container and read its exit status instead.
        container = client.containers.create(
            AUDORA_DOWNLOADER_IMAGE,
            entrypoint=["/bin/sh", "-c"],
            command=['actual=$(cat "$1") && [ "$actual" = "$2" ]',
                     "audora-mount-check", f"/probe/{probe.name}", token.decode("ascii")],
            volumes={windows_to_docker_path(folder): {"bind": "/probe", "mode": "ro"}},
            network_mode="none",
        )
        container.start()
        return container.wait(timeout=10)["StatusCode"] == 0
    except Exception as error:
        logger.warning("Could not verify Docker’s view of %s (%s)", folder, type(error).__name__)
        return False
    finally:
        if container is not None:
            try:
                container.remove(force=True, v=True)
            except Exception as error:
                logger.debug("Could not remove the Docker storage probe (%s)", type(error).__name__)
        if probe is not None:
            try:
                probe.unlink(missing_ok=True)
            except OSError:
                pass


def verify_download_files(working_folder, library_folder, collection_folders, outputs, track_stems=()):
    working = Path(working_folder).resolve()
    library = Path(library_folder).resolve()
    if not library.is_dir():
        raise FileNotFoundError(str(library))
    candidates = {Path(path) for path in outputs}
    for folder in collection_folders:
        candidates.update(
            path for path in Path(folder).glob("*.[fF][lL][aA][cC]")
            if track_stems and path.stem.casefold() in track_stems
        )

    verified = set()
    for source in sorted(candidates):
        source = source.resolve()
        if not source.is_relative_to(working) or not is_valid_flac(source):
            continue
        destination = (library / source.relative_to(working)).resolve()
        if not destination.is_relative_to(library):
            continue
        if working != library and not destination.exists():
            destination.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(dir=destination.parent, prefix=".audora-copy-", delete=False) as temporary:
                temporary_path = Path(temporary.name)
            try:
                shutil.copyfile(source, temporary_path)
                if not destination.exists():
                    os.replace(temporary_path, destination)
            finally:
                temporary_path.unlink(missing_ok=True)
        if is_valid_flac(destination):
            verified.add(str(destination))
    return sorted(verified)
