"""System-check output must describe the host without Windows-only claims."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import setup_manager  # noqa: E402
from runtime_platform import create_runtime_platform  # noqa: E402


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
