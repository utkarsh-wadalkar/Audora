"""System-check output must describe the host without Windows-only claims."""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import setup_manager  # noqa: E402
import docker_manager  # noqa: E402
from runtime_platform import create_runtime_platform  # noqa: E402


@pytest.fixture
def windows_setup(tmp_path, monkeypatch):
    runtime = create_runtime_platform(
        system="Windows",
        machine="AMD64",
        environ={"LOCALAPPDATA": str(tmp_path / "Local")},
        legacy_data_dir=tmp_path / "legacy-data",
    )
    manager = setup_manager.SetupManager()
    monkeypatch.setattr(setup_manager, "get_runtime_platform", lambda: runtime)
    monkeypatch.setattr(manager, "_wsl_available", lambda: True)
    monkeypatch.setattr(docker_manager.shutil, "which", lambda _tool: None)
    for source in ("_registry_install_roots", "_path_install_roots", "_default_install_roots"):
        monkeypatch.setattr(docker_manager, source, lambda: iter(()))
    monkeypatch.setattr(setup_manager.docker_mgr, "image_exists", lambda _image: False)
    monkeypatch.setattr(setup_manager.downloader_image, "image_is_built", lambda: False)
    return manager


@pytest.mark.parametrize("source", ["_registry_install_roots", "_default_install_roots"])
def test_windows_amd64_setup_detects_desktop_without_cli_on_path(
    windows_setup, tmp_path, monkeypatch, source,
):
    root = tmp_path / "custom-or-per-user" / "DockerDesktop"
    root.mkdir(parents=True)
    (root / "Docker Desktop.exe").write_text("fixture", encoding="utf-8")
    monkeypatch.setattr(docker_manager, source, lambda: iter([str(root)]))
    monkeypatch.setattr(setup_manager.docker_mgr, "is_docker_running", lambda: False)

    report = windows_setup.check_system()

    assert report["docker"]["installed"] is True
    assert report["docker"]["running"] is False


def test_windows_amd64_running_engine_is_usable_without_discoverable_install(
    windows_setup, monkeypatch,
):
    monkeypatch.setattr(windows_setup, "_docker_installed", lambda: False)
    monkeypatch.setattr(setup_manager.docker_mgr, "is_docker_running", lambda: True)

    report = windows_setup.check_system()

    assert report["docker"]["running"] is True
    assert report["docker"]["installed"] is True


def test_windows_setup_reports_missing_docker_when_no_install_or_engine(
    windows_setup, monkeypatch,
):
    monkeypatch.setattr(setup_manager.docker_mgr, "is_docker_running", lambda: False)

    report = windows_setup.check_system()

    assert report["docker"]["installed"] is False
    assert report["docker"]["running"] is False


def test_linux_system_check_uses_a_linux_label_and_hides_wsl(tmp_path, monkeypatch):
    linux_runtime = create_runtime_platform(
        system="Linux",
        machine="x86_64",
        environ={"HOME": str(tmp_path / "home")},
        legacy_data_dir=tmp_path / "legacy-data",
    )
    manager = setup_manager.SetupManager()
    monkeypatch.setattr(setup_manager, "get_runtime_platform", lambda: linux_runtime)
    monkeypatch.setattr(manager, "_docker_installed", lambda: True)
    monkeypatch.setattr(setup_manager.docker_mgr, "is_docker_running", lambda: True)
    monkeypatch.setattr(setup_manager.docker_mgr, "image_exists", lambda _image: False)
    monkeypatch.setattr(setup_manager.downloader_image, "image_is_built", lambda: False)

    report = manager.check_system()

    assert report["platform"] == {"ok": True, "label": "Linux x64"}
    assert report["wsl2"] == {"applicable": False, "ok": False}
    assert report["docker"]["install_label"] == "Docker Engine"
    assert report["docker"]["download_url"] == "https://docs.docker.com/engine/install/"
