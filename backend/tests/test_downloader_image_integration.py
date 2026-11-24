"""Opt-in check against an existing downloader image, without builds or pulls.

Set AUDORA_TEST_DOWNLOADER_IMAGE to an isolated test image tag to enable.
Requires the backend Docker dependencies and a running Linux Docker engine.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import download_storage
import downloader_image
import flac_converter


@pytest.mark.skipif(
    not os.environ.get("AUDORA_TEST_DOWNLOADER_IMAGE"),
    reason="Set AUDORA_TEST_DOWNLOADER_IMAGE to enable the real Docker probe",
)
def test_ffmpeg_verification_in_a_real_downloader_container(monkeypatch):
    docker = pytest.importorskip("docker")
    client = docker.from_env()
    try:
        image = os.environ["AUDORA_TEST_DOWNLOADER_IMAGE"]
        client.images.get(image)
        monkeypatch.setattr(downloader_image, "AUDORA_DOWNLOADER_IMAGE", image)
        monkeypatch.setattr(downloader_image.docker_mgr, "get_client", lambda: client)

        assert downloader_image.verify_ffmpeg_present() is True
    finally:
        client.close()


@pytest.mark.skipif(
    not os.environ.get("AUDORA_TEST_DOWNLOADER_IMAGE"),
    reason="Set AUDORA_TEST_DOWNLOADER_IMAGE to enable the real Docker probe",
)
def test_download_storage_with_dockers_local_logging_driver(monkeypatch, tmp_path):
    docker = pytest.importorskip("docker")
    image = os.environ["AUDORA_TEST_DOWNLOADER_IMAGE"]
    working, library, stale_mount = (tmp_path / name for name in ("staging", "library", "stale"))
    for folder in (working, library, stale_mount):
        folder.mkdir()
    client = docker.from_env()
    try:
        client.images.get(image)
        monkeypatch.setattr(download_storage.docker_mgr, "get_client", lambda: client)
        monkeypatch.setattr(download_storage, "AUDORA_DOWNLOADER_IMAGE", image)
        monkeypatch.setattr(flac_converter, "AUDORA_DOWNLOADER_IMAGE", image)

        containers = type(client.containers)
        create = containers.create

        def create_with_local_logging(collection, *args, **kwargs):
            kwargs["log_config"] = {"type": "local"}
            return create(collection, *args, **kwargs)

        monkeypatch.setattr(containers, "create", create_with_local_logging)
        assert download_storage.docker_sees_folder(str(working))
        with monkeypatch.context() as mount:
            mount.setattr(download_storage, "windows_to_docker_path", lambda _: stale_mount.as_posix())
            assert not download_storage.docker_sees_folder(str(library))
        assert list(working.iterdir()) == []
        assert list(library.iterdir()) == []

        source = working / "sample.m4a"
        client.containers.run(
            image,
            entrypoint="ffmpeg",
            command=["-loglevel", "error", "-f", "lavfi", "-i", "sine=d=1",
                     "-c:a", "alac", "/scratch/sample.m4a"],
            volumes={working.as_posix(): {"bind": "/scratch", "mode": "rw"}},
            network_mode="none",
            remove=True,
        )
        assert source.is_file()
        assert flac_converter.convert_one(str(source), str(working))
        published = library / "sample.flac"
        assert download_storage.verify_download_files(
            working, library, [], [working / "sample.flac"],
        ) == [str(published)]
        assert flac_converter.is_valid_flac(published)
    finally:
        client.close()
