"""Live Docker smoke check for Audora's public wrapper-lite setup image.

Run ``python backend/verify_docker.py`` with Docker Desktop running. No Apple
credentials are needed; authentication and a real download require user input.
"""

import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from docker_manager import docker_mgr  # noqa: E402
from setup_manager import SetupManager, WRAPPER_IMAGE  # noqa: E402


def main() -> int:
    client = docker_mgr.get_client()
    if client is None or not docker_mgr.is_docker_api_responsive():
        print("Docker Desktop is not responding.")
        return 1

    manager = SetupManager()
    events = []
    manager.register_progress_callback(events.append)
    try:
        manager._build_wrapper_step()
    except Exception as error:
        print(f"Could not pull public wrapper-lite image: {error}")
        return 1

    if not docker_mgr.image_exists(WRAPPER_IMAGE):
        print("Docker did not retain the wrapper-lite image after the pull.")
        return 1

    try:
        client.containers.run(
            WRAPPER_IMAGE,
            entrypoint="/bin/sh",
            command=["-c", "test -x /app/wrapper-lite-rootless && test -d /app/rootfs"],
            remove=True,
            network_mode="none",
        )
    except Exception as error:
        print(f"Pulled image is missing wrapper-lite runtime files: {error}")
        return 1

    started = time.monotonic()
    manager._build_wrapper_step()
    if time.monotonic() - started > 5:
        print("Repeating setup did not skip the already present image promptly.")
        return 1

    print(f"Public wrapper-lite image is ready: {WRAPPER_IMAGE}")
    print(f"Setup progress events: {len(events)}")
    print("A signed-in /status check and a music download still need user credentials.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
