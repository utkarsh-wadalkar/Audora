"""Central Windows/Linux runtime policy for Audora's frozen backend.

The backend is deliberately not a package, so this module is imported directly
by its peers.  It is the only backend location that decides which supported
host platform is running, where writable application state lives, and whether
Windows-only Docker/WSL actions are available.
"""
from dataclasses import dataclass
from pathlib import Path
import os
import platform as system_platform
from typing import Mapping, Optional


_WINDOWS_DOWNLOADS_DIR = r"D:\apple-music-dl\downloads"
_WINDOWS_WRAPPER_DATA_DIR = Path(r"D:\apple-music-dl\wrapper\rootfs\data")
_DOCKER_DESKTOP_URL = "https://www.docker.com/products/docker-desktop/"
_DOCKER_ENGINE_URL = "https://docs.docker.com/engine/install/"
_SUPPORTED_SYSTEMS = frozenset({"Windows", "Linux"})


@dataclass(frozen=True)
class RuntimePlatform:
    """Resolved host-specific values consumed by the backend."""

    system: str
    system_version: str
    data_dir: Path
    default_downloads_dir: str
    default_wrapper_data_dir: Path
    docker_install_label: str
    docker_download_url: str
    backend_executable: str
    supports_docker_desktop_start: bool
    requires_wsl: bool


def _linux_data_dir(environ: Mapping[str, str]) -> Path:
    configured = environ.get("AUDORA_DATA_DIR")
    if configured:
        return Path(configured)
    xdg_data_home = environ.get("XDG_DATA_HOME")
    if xdg_data_home:
        return Path(xdg_data_home) / "Audora" / "backend"
    home = environ.get("HOME")
    if home:
        return Path(home) / ".local" / "share" / "Audora" / "backend"
    return Path.home() / ".local" / "share" / "Audora" / "backend"


def _linux_downloads_dir(environ: Mapping[str, str]) -> str:
    configured = environ.get("AUDORA_DOWNLOADS_DIR")
    if configured:
        return configured
    home = environ.get("HOME")
    return str(Path(home) / "Music" / "Audora") if home else str(Path.home() / "Music" / "Audora")


def create_runtime_platform(
    *,
    system: str,
    machine: str,
    environ: Mapping[str, str],
    legacy_data_dir: Path,
    system_version: str = "",
) -> RuntimePlatform:
    """Return the complete host policy without reading global process state.

    Windows uses the exact legacy writable directory and default download path.
    Linux must never write beneath the packaged resource directory, so it uses
    an Electron-provided directory or an XDG-compatible user-data fallback.
    """
    if system not in _SUPPORTED_SYSTEMS:
        raise RuntimeError(f"Audora desktop packages support Windows and Linux only, not {system}")

    if system == "Windows":
        return RuntimePlatform(
            system=system,
            system_version=system_version,
            data_dir=legacy_data_dir,
            default_downloads_dir=_WINDOWS_DOWNLOADS_DIR,
            default_wrapper_data_dir=_WINDOWS_WRAPPER_DATA_DIR,
            docker_install_label="Docker Desktop",
            docker_download_url=_DOCKER_DESKTOP_URL,
            backend_executable="backend.exe",
            supports_docker_desktop_start=True,
            requires_wsl=True,
        )

    return RuntimePlatform(
        system=system,
        system_version=system_version,
        data_dir=_linux_data_dir(environ),
        default_downloads_dir=_linux_downloads_dir(environ),
        default_wrapper_data_dir=_linux_data_dir(environ) / "wrapper" / "rootfs" / "data",
        docker_install_label="Docker Engine",
        docker_download_url=_DOCKER_ENGINE_URL,
        backend_executable="backend",
        supports_docker_desktop_start=False,
        requires_wsl=False,
    )


def get_runtime_platform(*, legacy_data_dir: Optional[Path] = None) -> RuntimePlatform:
    """Resolve the current process platform once callers need runtime paths."""
    base_dir = legacy_data_dir or (Path(__file__).resolve().parent / "data")
    return create_runtime_platform(
        system=system_platform.system(),
        machine=system_platform.machine(),
        environ=os.environ,
        legacy_data_dir=base_dir,
        system_version=system_platform.version(),
    )


def get_data_dir(*, legacy_data_dir: Optional[Path] = None) -> Path:
    """Return the writable backend state directory for the current host."""
    return get_runtime_platform(legacy_data_dir=legacy_data_dir).data_dir


def get_backend_port(environ: Mapping[str, str]) -> int:
    """Return the normal backend port or an explicit smoke-test override."""
    raw_value = environ.get("AUDORA_BACKEND_PORT", "8000")
    try:
        port = int(raw_value)
    except (TypeError, ValueError):
        return 8000
    return port if 1 <= port <= 65535 else 8000
