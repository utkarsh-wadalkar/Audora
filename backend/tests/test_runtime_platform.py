"""Tests for the centralized Windows/Linux runtime policy.

The failures these tests guard against are a Linux package writing into its
read-only application resources or a Windows package silently changing its
established backend/download defaults.
"""
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from runtime_platform import create_runtime_platform  # noqa: E402


def test_linux_uses_electron_provided_data_and_download_paths(tmp_path):
    runtime = create_runtime_platform(
        system="Linux",
        machine="x86_64",
        environ={
            "AUDORA_DATA_DIR": str(tmp_path / "data"),
            "AUDORA_DOWNLOADS_DIR": str(tmp_path / "music"),
        },
        legacy_data_dir=tmp_path / "legacy-data",
    )

    assert runtime.data_dir == tmp_path / "data"
    assert runtime.default_downloads_dir == str(tmp_path / "music")
    assert runtime.default_wrapper_data_dir == tmp_path / "data" / "wrapper" / "rootfs" / "data"
    assert runtime.docker_install_label == "Docker Engine"
    assert runtime.docker_download_url == "https://docs.docker.com/engine/install/"
    assert runtime.backend_executable == "backend"
    assert runtime.supports_docker_desktop_start is False
    assert runtime.requires_wsl is False


def test_windows_preserves_the_legacy_backend_and_download_defaults(tmp_path):
    runtime = create_runtime_platform(
        system="Windows",
        machine="AMD64",
        environ={},
        legacy_data_dir=tmp_path / "legacy-data",
    )

    assert runtime.data_dir == tmp_path / "legacy-data"
    assert runtime.default_downloads_dir == r"D:\apple-music-dl\downloads"
    assert runtime.default_wrapper_data_dir == Path(r"D:\apple-music-dl\wrapper\rootfs\data")
    assert runtime.docker_install_label == "Docker Desktop"
    assert runtime.backend_executable == "backend.exe"
    assert runtime.supports_docker_desktop_start is True
    assert runtime.requires_wsl is True


def test_linux_without_electron_environment_uses_a_user_data_fallback(tmp_path):
    runtime = create_runtime_platform(
        system="Linux",
        machine="x86_64",
        environ={"HOME": str(tmp_path / "home")},
        legacy_data_dir=tmp_path / "legacy-data",
    )

    assert runtime.data_dir == tmp_path / "home" / ".local" / "share" / "Audora" / "backend"
    assert runtime.data_dir != tmp_path / "legacy-data"


def test_linux_does_not_expose_windows_only_docker_or_wsl_capabilities(tmp_path):
    runtime = create_runtime_platform(
        system="Linux",
        machine="x86_64",
        environ={"HOME": str(tmp_path / "home")},
        legacy_data_dir=tmp_path / "legacy-data",
    )

    assert runtime.supports_docker_desktop_start is False
    assert runtime.requires_wsl is False
