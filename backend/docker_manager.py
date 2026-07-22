"""Docker SDK wrapper — Windows named pipe, with graceful degradation.

All methods swallow ``DockerException`` and return safe defaults / log a
user-friendly message so the API never 500s just because Docker is down.
"""
import subprocess
import time
from typing import Iterator, Optional

try:
    import docker
    from docker.errors import DockerException, NotFound, APIError
    from docker.models.containers import Container
except Exception:  # pragma: no cover - docker lib always present in prod
    docker = None
    DockerException = Exception
    NotFound = Exception
    APIError = Exception
    Container = object  # type: ignore

from logger import get_logger

logger = get_logger("docker")

# Windows Docker Desktop engine pipe.
_WINDOWS_PIPE = "npipe:////./pipe/docker_engine"

# Common Docker Desktop install locations to try when auto-starting.
_DOCKER_DESKTOP_PATHS = [
    r"C:\Program Files\Docker\Docker\Docker Desktop.exe",
    r"C:\Program Files\Docker\Docker\resources\bin\com.docker.cli.exe",
]


class DockerManager:
    def __init__(self) -> None:
        self._client: Optional["docker.DockerClient"] = None

    def get_client(self) -> Optional["docker.DockerClient"]:
        """Return a connected client, or None if the engine is unreachable."""
        if docker is None:
            logger.error("docker SDK not installed")
            return None
        if self._client is not None:
            return self._client
        try:
            # from_env respects DOCKER_HOST; on Windows fall back to the pipe.
            try:
                client = docker.from_env()
                client.ping()
            except Exception:
                client = docker.DockerClient(base_url=_WINDOWS_PIPE)
                client.ping()
            self._client = client
            return client
        except DockerException as e:
            logger.warning(f"Docker engine unreachable: {e}")
            return None
        except Exception as e:
            logger.warning(f"Docker connect failed: {e}")
            return None

    def is_docker_running(self) -> bool:
        client = self.get_client()
        if client is None:
            return False
        try:
            client.ping()
            return True
        except Exception:
            # Stale client — drop it so the next call reconnects.
            self._client = None
            return False

    def start_docker_desktop(self) -> bool:
        """Launch Docker Desktop and wait (best effort) for the engine."""
        if self.is_docker_running():
            return True
        launched = False
        for path in _DOCKER_DESKTOP_PATHS:
            try:
                subprocess.Popen([path], close_fds=True)
                launched = True
                logger.info(f"Launched Docker Desktop from {path}")
                break
            except OSError:
                continue
        if not launched:
            logger.error("Could not find Docker Desktop executable")
            return False
        # Wait up to 60s for the engine to come up.
        for _ in range(60):
            if self.is_docker_running():
                return True
            time.sleep(1)
        return self.is_docker_running()

    def get_container(self, name: str) -> Optional["Container"]:
        client = self.get_client()
        if client is None:
            return None
        try:
            return client.containers.get(name)
        except NotFound:
            return None
        except Exception as e:
            logger.warning(f"get_container({name}) failed: {e}")
            return None

    def get_container_status(self, name: str) -> str:
        c = self.get_container(name)
        if c is None:
            return "absent"
        try:
            c.reload()
            return c.status  # created/running/paused/exited/dead
        except Exception:
            return "unknown"

    def start_container(self, config: dict) -> Optional["Container"]:
        """Run a container, removing any stale one with the same name first."""
        client = self.get_client()
        if client is None:
            logger.error("Cannot start container: Docker not running")
            return None

        name = config.get("name")
        if name:
            existing = self.get_container(name)
            if existing is not None:
                try:
                    existing.remove(force=True)
                    logger.info(f"Removed stale container {name}")
                except Exception as e:
                    logger.warning(f"Could not remove stale {name}: {e}")

        try:
            container = client.containers.run(**config)
            logger.info(f"Started container {name or container.short_id}")
            return container
        except APIError as e:
            logger.error(f"Docker API error starting container: {e.explanation or e}")
            return None
        except Exception as e:
            logger.error(f"Failed to start container: {e}")
            return None

    def stop_container(self, name: str, timeout: int = 10) -> bool:
        c = self.get_container(name)
        if c is None:
            return True  # already gone
        try:
            c.stop(timeout=timeout)
            try:
                c.remove(force=True)
            except Exception:
                pass
            logger.info(f"Stopped container {name}")
            return True
        except Exception as e:
            logger.warning(f"Failed to stop {name}: {e}")
            return False

    def stream_logs(self, container_id: str, follow: bool = True) -> Iterator[str]:
        """Yield decoded log lines from a container as they arrive."""
        client = self.get_client()
        if client is None:
            return
        try:
            container = client.containers.get(container_id)
        except Exception as e:
            logger.warning(f"stream_logs: container gone: {e}")
            return
        try:
            for chunk in container.logs(stream=True, follow=follow, stdout=True, stderr=True):
                if not chunk:
                    continue
                text = chunk.decode("utf-8", errors="replace")
                for line in text.splitlines():
                    if line:
                        yield line
        except Exception as e:
            logger.warning(f"stream_logs ended: {e}")

    def pull_image(self, name: str) -> bool:
        client = self.get_client()
        if client is None:
            return False
        try:
            logger.info(f"Pulling image {name} ...")
            client.images.pull(name)
            logger.info(f"Pulled {name}")
            return True
        except Exception as e:
            logger.error(f"Failed to pull {name}: {e}")
            return False

    def image_exists(self, name: str) -> bool:
        client = self.get_client()
        if client is None:
            return False
        try:
            client.images.get(name)
            return True
        except Exception:
            return False


docker_mgr = DockerManager()
