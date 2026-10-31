"""Opt-in check against an existing downloader image, without builds or pulls.

Set AUDORA_TEST_DOWNLOADER_IMAGE to an isolated test image tag to enable.
Requires the backend Docker dependencies and a running Linux Docker engine.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import downloader_image


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
