"""Docker SDK wrapper — Windows named pipe, with graceful degradation.

All methods swallow ``DockerException`` and return safe defaults / log a
user-friendly message so the API never 500s just because Docker is down.
"""
import os
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

# --- Docker Desktop discovery ----------------------------------------------
#
# Audora ships publicly, so it cannot assume where Docker Desktop lives. Per
# Docker's own docs there are three genuinely different layouts:
#
#   * per-user (the installer's DEFAULT):  %LOCALAPPDATA%\Programs\DockerDesktop
#     with registry state under HKCU, and NO com.docker.service.
#   * all-users:                           C:\Program Files\Docker\Docker
#     with registry state under HKLM.
#   * anywhere at all: the installer supports --installation-dir=<path>, e.g.
#     D:\Docker\Docker.
#
# That third case means no hardcoded list can ever be complete, so discovery is
# ordered most-reliable-first and only falls back to guesses:
#
#   1. Registry  — the uninstall key's InstallLocation, probed in HKCU and HKLM
#                  (and the 32-bit view), which is authoritative even for a
#                  relocated install.
#   2. PATH      — locate docker.exe and derive the install root from it.
#   3. Hardcoded — the two documented defaults, as a last resort.
#
# Every step returns only paths that actually exist on disk, so a stale
# registry entry left behind by an uninstall cannot produce a dead path.

# The executable that starts Docker Desktop (and thus the engine).
_DOCKER_DESKTOP_EXE = "Docker Desktop.exe"

# Uninstall keys Docker Desktop registers under. Per-user installs write to
# HKCU, all-users to HKLM; the subkey is the plain product name, not a GUID.
_UNINSTALL_SUBKEYS = (
    r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Docker Desktop",
    r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Docker Desktop",
)

# Vendor key some versions use to record the install root.
_VENDOR_SUBKEYS = (
    r"SOFTWARE\Docker Inc.\Docker Desktop",
    r"SOFTWARE\Docker Inc.\Docker\1.0",
)


def _exe_in(root: str) -> Optional[str]:
    """Return ``root``'s Docker Desktop executable if it exists on disk."""
    if not root:
        return None
    candidate = os.path.join(root.strip().strip('"'), _DOCKER_DESKTOP_EXE)
    return candidate if os.path.isfile(candidate) else None


def _registry_install_roots() -> Iterator[str]:
    """Yield install roots recorded in the registry (HKCU and HKLM).

    Authoritative even when the user installed to a custom directory via
    ``--installation-dir``. Never raises: a missing key, a missing value, or
    no winreg module at all simply yields nothing.
    """
    try:
        import winreg
    except ImportError:  # not Windows
        return

    hives = (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE)
    subkeys = _UNINSTALL_SUBKEYS + _VENDOR_SUBKEYS
    # InstallLocation is the documented install root. AppPath is what the
    # vendor key uses. DisplayIcon is deliberately NOT read: on a per-user
    # install it points at "Docker Desktop Installer.exe", so launching it
    # would run the installer rather than the app.
    value_names = ("InstallLocation", "AppPath", "InstallPath")

    for hive in hives:
        for subkey in subkeys:
            try:
                with winreg.OpenKey(hive, subkey) as key:
                    for value_name in value_names:
                        try:
                            value, _kind = winreg.QueryValueEx(key, value_name)
                        except OSError:
                            continue
                        if isinstance(value, str) and value.strip():
                            yield value
            except OSError:
                # Key absent in this hive/view — expected for the other mode.
                continue


def _path_install_roots() -> Iterator[str]:
    """Yield install roots derived from ``docker.exe`` on PATH.

    Docker Desktop puts its CLI at ``<root>\\resources\\bin\\docker.exe``, so the
    root is three levels up. Each candidate is verified by checking that the GUI
    executable is actually there, which also rejects an unrelated docker.exe
    (a Chocolatey/Scoop shim, or a plain Docker CE install with no Desktop).
    """
    for tool in ("docker", "com.docker.cli"):
        located = shutil.which(tool)
        if not located:
            continue
        current = os.path.dirname(os.path.abspath(located))
        # Walk up a few levels rather than assuming a fixed depth, so a layout
        # change between versions does not break discovery.
        for _ in range(4):
            yield current
            parent = os.path.dirname(current)
            if parent == current:
                break
            current = parent


def _default_install_roots() -> Iterator[str]:
    """Yield the two documented default roots, as a last resort."""
    local_app_data = os.environ.get("LOCALAPPDATA")
    if local_app_data:
        yield os.path.join(local_app_data, "Programs", "DockerDesktop")
    program_files = os.environ.get("ProgramFiles", r"C:\Program Files")
    yield os.path.join(program_files, "Docker", "Docker")
    program_files_x86 = os.environ.get("ProgramFiles(x86)")
    if program_files_x86:
        yield os.path.join(program_files_x86, "Docker", "Docker")


def find_docker_desktop() -> Optional[str]:
    """Locate ``Docker Desktop.exe``, or None if it cannot be found.

    Tries the registry, then PATH, then the documented defaults, returning the
    first candidate that exists on disk.
    """
    for source, roots in (
        ("registry", _registry_install_roots),
        ("PATH", _path_install_roots),
        ("default location", _default_install_roots),
    ):
        try:
            for root in roots():
                found = _exe_in(root)
                if found:
                    logger.info(f"Found Docker Desktop via {source}: {found}")
                    return found
        except Exception as discovery_error:  # noqa: BLE001 - never block startup
            logger.warning(f"Docker Desktop {source} discovery failed: {discovery_error}")
    logger.warning("Could not locate Docker Desktop in the registry, on PATH, or at a default location")
    return None


def _docker_desktop_paths() -> list:
    """Every candidate executable that exists on disk, best first.

    Kept as a list (rather than a single path) so ``start_docker_desktop`` can
    still try the next candidate if launching one fails.
    """
    found: list = []
    for roots in (_registry_install_roots, _path_install_roots, _default_install_roots):
        try:
            for root in roots():
                candidate = _exe_in(root)
                if candidate and candidate not in found:
                    found.append(candidate)
        except Exception:  # noqa: BLE001 - discovery must never raise
            continue
    return found


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
        # Discovered per call rather than at import time: the user may install
        # Docker Desktop while Audora is already running, and this is the exact
        # path the "Start Docker & Retry" button takes after they do.
        for path in _docker_desktop_paths():
            try:
                subprocess.Popen([path], close_fds=True)
                launched = True
                logger.info(f"Launched Docker Desktop from {path}")
                break
            except OSError as launch_error:
                logger.warning(f"Could not launch {path}: {launch_error}")
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
                    # Preserve blank lines too: setup displays the container's
                    # complete raw output, not a summarized/non-empty subset.
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

    def check_internet(self, timeout: float = 3.0) -> bool:
        """True if the machine appears to have working internet access.

        Used to tell "offline" apart from other network failures: DNS can fail
        while online (bad resolver, blocked port 53), and Docker being down is
        not a connectivity problem at all. Only a failure here justifies
        telling the user to connect to the internet.

        Deliberately a TCP connect to a well-known host:port rather than a DNS
        lookup, so a broken resolver on an otherwise-online machine does not
        read as offline. Short timeout — this runs on a failure path where the
        user is already waiting. Never raises.
        """
        # 1.1.1.1:443 and 8.8.8.8:443 — reachable without DNS.
        for host, port in (("1.1.1.1", 443), ("8.8.8.8", 443)):
            try:
                with socket.create_connection((host, port), timeout=timeout):
                    return True
            except (OSError, ValueError):
                continue
        logger.info("Connectivity probe failed; treating the machine as offline")
        return False

    def is_port_listening(
        self, port: int, host: str = "127.0.0.1", timeout: float = 1.0
    ) -> bool:
        """Return True if something accepts TCP connections on ``host:port``.

        Used as a wrapper-liveness probe. The wrapper container runs with
        ``network_mode="host"``, so its ports are host ports and a plain
        connect is a valid check that the service is actually serving —
        stronger than "the container status says running", which is true well
        before the process inside has bound anything.

        Runs on the startup path, so the timeout is deliberately short. Never
        raises: any failure means "not listening".
        """
        try:
            with socket.create_connection((host, port), timeout=timeout):
                return True
        except (OSError, ValueError) as probe_error:
            logger.debug(f"Port {host}:{port} not listening: {probe_error}")
            return False

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
