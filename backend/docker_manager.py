"""Docker SDK wrapper — Windows named pipe, with graceful degradation.

All methods swallow ``DockerException`` and return safe defaults / log a
user-friendly message so the API never 500s just because Docker is down.
"""
import shutil
import socket
import subprocess
import time
from typing import Callable, Iterator, Optional

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
        # Human-readable reason the last start_container() call failed, or None.
        self.last_start_error: Optional[str] = None

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
        """Run a container, removing any stale one with the same name first.

        On failure returns None; the reason is stored on
        ``self.last_start_error`` so callers can surface the real cause
        instead of a generic message.
        """
        self.last_start_error = None
        client = self.get_client()
        if client is None:
            self.last_start_error = "Docker is not running"
            logger.error("Cannot start container: Docker not running")
            return None

        name = config.get("name")
        if name:
            existing = self.get_container(name)
            if existing is not None:
                try:
                    existing.remove(force=True)
                    logger.info(f"Removed stale container {name}")
                except Exception as remove_error:
                    logger.warning(f"Could not remove stale {name}: {remove_error}")

        try:
            container = client.containers.run(**config)
            logger.info(f"Started container {name or container.short_id}")
            return container
        except APIError as api_error:
            detail = api_error.explanation or str(api_error)
            self.last_start_error = detail
            logger.error(f"Docker API error starting container: {detail}")
            return None
        except Exception as start_error:
            self.last_start_error = str(start_error)
            logger.error(f"Failed to start container: {start_error}")
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

    def pull_image_streaming(self, image: str, on_progress: Callable) -> bool:
        """Pull ``image`` streaming per-layer progress events to ``on_progress``.

        Uses the low-level SDK API (``client.api.pull(..., stream=True,
        decode=True)``) so callers receive the same structured per-layer JSON
        events the Docker CLI renders (``Downloading`` / ``Extracting`` /
        ``Pull complete`` with ``progressDetail`` byte counters and layer
        ``id``\\ s). ``on_progress`` is invoked for EVERY decoded event.

        Idempotent: Docker's pull naturally resumes an already-partially-pulled
        image and is a no-op ("Image is up to date" / "Already exists") for a
        fully-pulled one — either way the stream completes and we return True.

        Graceful degradation: if the docker lib is missing or the client is
        None, log and return False rather than raising.
        """
        client = self.get_client()
        if client is None:
            logger.error(f"Cannot pull {image}: Docker not running")
            return False
        try:
            logger.info(f"Streaming pull of image {image} ...")
            # Low-level API yields decoded dict events, one per status update.
            for event in client.api.pull(image, stream=True, decode=True):
                if not isinstance(event, dict):
                    # Defensive: skip anything that isn't a decoded event.
                    continue
                # Surface registry-side errors instead of silently "succeeding".
                if event.get("error"):
                    logger.error(f"Pull error for {image}: {event.get('error')}")
                    # Still forward the event so callers can classify/branch.
                    try:
                        on_progress(event)
                    except Exception as cb_err:
                        logger.warning(f"on_progress callback failed: {cb_err}")
                    return False
                try:
                    on_progress(event)
                except Exception as cb_err:
                    # A misbehaving callback must not abort the pull.
                    logger.warning(f"on_progress callback failed: {cb_err}")
            logger.info(f"Pulled {image} (streaming)")
            return True
        except Exception as e:
            logger.error(f"Failed to stream-pull {image}: {e}")
            return False

    def check_disk_space(self, path: str, required_bytes: int) -> bool:
        """Return True if ``path``'s filesystem has >= ``required_bytes`` free.

        Degrades gracefully: on any unexpected error we return True and log it,
        so a bug in this preflight check never blocks setup outright.
        """
        try:
            usage = shutil.disk_usage(path)
            ok = usage.free >= required_bytes
            if not ok:
                logger.warning(
                    f"Low disk space at {path}: {usage.free} free, "
                    f"{required_bytes} required"
                )
            return ok
        except Exception as e:
            logger.warning(f"check_disk_space({path}) failed, assuming OK: {e}")
            return True

    def check_dns(self, host: str) -> bool:
        """Return True if ``host`` resolves via DNS within a short timeout."""
        old_timeout = socket.getdefaulttimeout()
        try:
            socket.setdefaulttimeout(5.0)
            socket.getaddrinfo(host, None)
            return True
        except Exception as e:
            logger.warning(f"DNS resolution failed for {host}: {e}")
            return False
        finally:
            socket.setdefaulttimeout(old_timeout)

    def is_docker_api_responsive(self) -> bool:
        """Actually ping the Docker Engine API (not just a process check).

        Returns False on any failure rather than raising.
        """
        client = self.get_client()
        if client is None:
            return False
        try:
            return bool(client.ping())
        except Exception as e:
            logger.warning(f"Docker API ping failed: {e}")
            # Stale client — drop it so a later call reconnects.
            self._client = None
            return False


docker_mgr = DockerManager()
