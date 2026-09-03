"""Platform safeguards around Docker Desktop startup."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import docker_manager  # noqa: E402
from runtime_platform import create_runtime_platform  # noqa: E402


def test_linux_never_attempts_to_launch_windows_docker_desktop(tmp_path, monkeypatch):
    linux_runtime = create_runtime_platform(
        system="Linux",
        machine="x86_64",
        environ={"HOME": str(tmp_path / "home")},
        legacy_data_dir=tmp_path / "legacy-data",
    )
    manager = docker_manager.DockerManager(runtime_provider=lambda: linux_runtime)
    monkeypatch.setattr(manager, "is_docker_running", lambda: False)

    attempted_launches = []
    monkeypatch.setattr(
        docker_manager.subprocess,
        "Popen",
        lambda args, **kwargs: attempted_launches.append(args),
    )

    assert manager.start_docker_desktop() is False
    assert attempted_launches == []
