"""Verify and repair the downloader without depending on the host's Docker."""
import os
import sys
from types import SimpleNamespace

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import downloader_image
import setup_manager


def test_ffmpeg_verification_works_with_local_as_the_engine_log_driver(monkeypatch):
    def run(_image, **kwargs):
        driver = kwargs.get("log_config", {}).get("type", "local")
        # Docker SDK run() discards logs for drivers outside this allowlist.
        return b"ffmpeg version 7.1\n" if driver in ("json-file", "journald") else None

    client = SimpleNamespace(containers=SimpleNamespace(run=run))
    monkeypatch.setattr(downloader_image.docker_mgr, "get_client", lambda: client)

    assert downloader_image.verify_ffmpeg_present() is True


def test_ffmpeg_verification_preserves_the_actual_container_error(monkeypatch):
    def run(*args, **kwargs):
        raise RuntimeError("OCI runtime create failed: ffmpeg: executable file not found")

    client = SimpleNamespace(containers=SimpleNamespace(run=run))
    monkeypatch.setattr(downloader_image.docker_mgr, "get_client", lambda: client)

    with pytest.raises(RuntimeError, match="OCI runtime create failed"):
        downloader_image.verify_ffmpeg_present()


def test_ffmpeg_verification_explains_unavailable_output_without_claiming_missing_binary(monkeypatch):
    client = SimpleNamespace(containers=SimpleNamespace(run=lambda *args, **kwargs: None))
    monkeypatch.setattr(downloader_image.docker_mgr, "get_client", lambda: client)

    with pytest.raises(RuntimeError, match="version output"):
        downloader_image.verify_ffmpeg_present()


def test_an_existing_broken_downloader_is_repaired_before_setup_can_succeed(monkeypatch):
    manager = setup_manager.SetupManager()
    repaired = False
    monkeypatch.setattr(downloader_image, "image_is_built", lambda: True)

    def verify():
        if not repaired:
            raise RuntimeError("ffmpeg executable file not found")
        return True

    def build(on_log=None, *, force=False):
        nonlocal repaired
        if force:
            repaired = True

    monkeypatch.setattr(downloader_image, "verify_ffmpeg_present", verify)
    monkeypatch.setattr(downloader_image, "build_downloader_image", build)

    manager._build_downloader_step()

    assert repaired is True
    assert verify() is True


def test_failed_ffmpeg_repair_keeps_the_underlying_error(monkeypatch):
    manager = setup_manager.SetupManager()
    monkeypatch.setattr(downloader_image, "image_is_built", lambda: True)
    monkeypatch.setattr(downloader_image, "build_downloader_image", lambda **kwargs: None)

    def verify():
        raise RuntimeError("OCI runtime create failed: exec format error")

    monkeypatch.setattr(downloader_image, "verify_ffmpeg_present", verify)
    with pytest.raises(setup_manager._StepFailure) as failure:
        manager._build_downloader_step()

    assert "OCI runtime create failed: exec format error" in failure.value.raw


def test_repair_can_build_even_when_the_image_tag_already_exists(monkeypatch, tmp_path):
    built = []
    client = SimpleNamespace(images=SimpleNamespace(build=lambda **kwargs: (built.append(kwargs), [])))
    monkeypatch.setattr(downloader_image, "image_is_built", lambda: True)
    monkeypatch.setattr(downloader_image.docker_mgr, "get_client", lambda: client)
    monkeypatch.setattr(downloader_image, "write_dockerfile", lambda: str(tmp_path / "Dockerfile"))

    downloader_image.build_downloader_image(force=True)

    assert len(built) == 1
