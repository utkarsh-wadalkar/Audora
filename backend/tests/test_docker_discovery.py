"""Docker Desktop discovery tests — must work on any Windows machine.

Audora ships publicly, so discovery cannot assume the developer's layout.
Docker documents three genuinely different install shapes:

* per-user (the installer's default) -- %LOCALAPPDATA%\\Programs\\DockerDesktop,
  registry under HKCU, no com.docker.service
* all-users -- C:\\Program Files\\Docker\\Docker, registry under HKLM
* custom -- anywhere, via the installer's ``--installation-dir=<path>``

The third case is why hardcoded lists cannot be sufficient and the registry and
PATH are consulted first.

Every test here builds a *fake* install tree under ``tmp_path`` and points
discovery at it, so nothing depends on where Docker really is on the machine
running the tests. These pass on a machine with no Docker installed at all.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import docker_manager  # noqa: E402

EXE_NAME = "Docker Desktop.exe"


def _make_install(root, *, with_cli=True):
    """Create a fake Docker Desktop install tree and return its root.

    Mirrors the real layout: the GUI at ``<root>\\Docker Desktop.exe`` and the
    CLI at ``<root>\\resources\\bin\\docker.exe``.
    """
    root.mkdir(parents=True, exist_ok=True)
    (root / EXE_NAME).write_text("fake gui", encoding="utf-8")
    if with_cli:
        cli_dir = root / "resources" / "bin"
        cli_dir.mkdir(parents=True, exist_ok=True)
        (cli_dir / "docker.exe").write_text("fake cli", encoding="utf-8")
    return root


def _isolate(monkeypatch):
    """Silence every discovery source, so each test enables just one.

    Without this a test would pass because the real Docker on the developer's
    machine was found -- exactly the false confidence being guarded against.
    """
    monkeypatch.setattr(docker_manager, "_registry_install_roots", lambda: iter(()))
    monkeypatch.setattr(docker_manager, "_path_install_roots", lambda: iter(()))
    monkeypatch.setattr(docker_manager, "_default_install_roots", lambda: iter(()))


# ---------------------------------------------------------------------------
# Two different install locations, neither assumed to be the dev's
# ---------------------------------------------------------------------------

def test_finds_a_per_user_install(monkeypatch, tmp_path):
    """Per-user: %LOCALAPPDATA%\\Programs\\DockerDesktop (installer default)."""
    _isolate(monkeypatch)
    local_app_data = tmp_path / "AppData" / "Local"
    root = _make_install(local_app_data / "Programs" / "DockerDesktop")

    monkeypatch.setattr(docker_manager, "_default_install_roots", lambda: iter([str(root)]))

    found = docker_manager.find_docker_desktop()
    assert found == str(root / EXE_NAME)


def test_finds_an_all_users_install(monkeypatch, tmp_path):
    """All-users: <ProgramFiles>\\Docker\\Docker -- a layout this dev box lacks."""
    _isolate(monkeypatch)
    program_files = tmp_path / "Program Files"
    root = _make_install(program_files / "Docker" / "Docker")

    monkeypatch.setattr(docker_manager, "_default_install_roots", lambda: iter([str(root)]))

    found = docker_manager.find_docker_desktop()
    assert found == str(root / EXE_NAME)


def test_finds_a_custom_installation_dir(monkeypatch, tmp_path):
    """--installation-dir puts Docker anywhere, e.g. on another drive.

    No hardcoded list can cover this, which is why the registry is consulted
    first.
    """
    _isolate(monkeypatch)
    root = _make_install(tmp_path / "SomeOtherDrive" / "Tools" / "DockerDesktop")

    monkeypatch.setattr(docker_manager, "_registry_install_roots", lambda: iter([str(root)]))

    found = docker_manager.find_docker_desktop()
    assert found == str(root / EXE_NAME)


def test_default_roots_cover_both_documented_layouts(monkeypatch, tmp_path):
    """The fallback list must offer per-user AND all-users, not just one."""
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "Local"))
    monkeypatch.setenv("ProgramFiles", str(tmp_path / "Program Files"))

    roots = [os.path.normcase(root) for root in docker_manager._default_install_roots()]

    assert any(
        "programs" in root and "dockerdesktop" in root for root in roots
    ), f"no per-user candidate in {roots}"
    assert any(
        "program files" in root and "docker" in root for root in roots
    ), f"no all-users candidate in {roots}"


def test_default_roots_survive_a_missing_localappdata(monkeypatch, tmp_path):
    """LOCALAPPDATA unset (odd service accounts) must not lose the defaults."""
    monkeypatch.delenv("LOCALAPPDATA", raising=False)
    monkeypatch.setenv("ProgramFiles", str(tmp_path / "Program Files"))

    roots = list(docker_manager._default_install_roots())

    assert roots, "no candidates offered without LOCALAPPDATA"
    assert all(isinstance(root, str) for root in roots)


# ---------------------------------------------------------------------------
# Source precedence: registry > PATH > hardcoded defaults
# ---------------------------------------------------------------------------

def test_registry_wins_over_path_and_defaults(monkeypatch, tmp_path):
    """The registry is authoritative, including for relocated installs."""
    _isolate(monkeypatch)
    registry_root = _make_install(tmp_path / "from-registry")
    path_root = _make_install(tmp_path / "from-path")
    default_root = _make_install(tmp_path / "from-default")

    monkeypatch.setattr(
        docker_manager, "_registry_install_roots", lambda: iter([str(registry_root)])
    )
    monkeypatch.setattr(docker_manager, "_path_install_roots", lambda: iter([str(path_root)]))
    monkeypatch.setattr(
        docker_manager, "_default_install_roots", lambda: iter([str(default_root)])
    )

    assert docker_manager.find_docker_desktop() == str(registry_root / EXE_NAME)


def test_path_used_when_the_registry_is_silent(monkeypatch, tmp_path):
    _isolate(monkeypatch)
    path_root = _make_install(tmp_path / "from-path")
    default_root = _make_install(tmp_path / "from-default")

    monkeypatch.setattr(docker_manager, "_path_install_roots", lambda: iter([str(path_root)]))
    monkeypatch.setattr(
        docker_manager, "_default_install_roots", lambda: iter([str(default_root)])
    )

    assert docker_manager.find_docker_desktop() == str(path_root / EXE_NAME)


def test_defaults_used_only_as_a_last_resort(monkeypatch, tmp_path):
    _isolate(monkeypatch)
    default_root = _make_install(tmp_path / "from-default")
    monkeypatch.setattr(
        docker_manager, "_default_install_roots", lambda: iter([str(default_root)])
    )

    assert docker_manager.find_docker_desktop() == str(default_root / EXE_NAME)


# ---------------------------------------------------------------------------
# PATH derivation
# ---------------------------------------------------------------------------

def test_install_root_derived_from_docker_exe_on_path(monkeypatch, tmp_path):
    """Real layout: the CLI sits at <root>\\resources\\bin\\docker.exe."""
    _isolate(monkeypatch)
    root = _make_install(tmp_path / "DockerDesktop")
    cli = root / "resources" / "bin" / "docker.exe"

    # Exercise the REAL derivation, not the _isolate stub.
    monkeypatch.undo()
    monkeypatch.setattr(
        docker_manager.shutil,
        "which",
        lambda tool: str(cli) if tool == "docker" else None,
    )
    roots = list(docker_manager._path_install_roots())

    assert str(root) in roots, f"install root not derived from the CLI: {roots}"


def test_unrelated_docker_exe_on_path_is_rejected(monkeypatch, tmp_path):
    """A Docker CE / Chocolatey shim has no Docker Desktop.exe near it.

    Discovery must not return a path just because some docker.exe exists.
    """
    _isolate(monkeypatch)
    shim = tmp_path / "chocolatey" / "bin"
    shim.mkdir(parents=True)
    (shim / "docker.exe").write_text("shim", encoding="utf-8")

    monkeypatch.setattr(
        docker_manager.shutil,
        "which",
        lambda tool: str(shim / "docker.exe") if tool == "docker" else None,
    )
    monkeypatch.setattr(
        docker_manager, "_registry_install_roots", lambda: iter(())
    )
    monkeypatch.setattr(docker_manager, "_default_install_roots", lambda: iter(()))

    assert docker_manager.find_docker_desktop() is None


# ---------------------------------------------------------------------------
# Robustness — must never crash or return a path that is not there
# ---------------------------------------------------------------------------

def test_stale_registry_entry_is_ignored(monkeypatch, tmp_path):
    """An uninstall can leave InstallLocation behind pointing at nothing."""
    _isolate(monkeypatch)
    missing = tmp_path / "uninstalled"
    real = _make_install(tmp_path / "actually-here")

    monkeypatch.setattr(
        docker_manager,
        "_registry_install_roots",
        lambda: iter([str(missing), str(real)]),
    )

    assert docker_manager.find_docker_desktop() == str(real / EXE_NAME)


def test_returns_none_when_docker_is_not_installed(monkeypatch):
    """A machine with no Docker at all must get None, not a crash."""
    _isolate(monkeypatch)
    assert docker_manager.find_docker_desktop() is None


def test_discovery_survives_a_raising_source(monkeypatch, tmp_path):
    """A registry failure must not stop PATH and defaults being tried."""
    _isolate(monkeypatch)
    root = _make_install(tmp_path / "fallback")

    def explode():
        raise OSError("registry unavailable")
        yield  # pragma: no cover - generator marker

    monkeypatch.setattr(docker_manager, "_registry_install_roots", explode)
    monkeypatch.setattr(docker_manager, "_default_install_roots", lambda: iter([str(root)]))

    assert docker_manager.find_docker_desktop() == str(root / EXE_NAME)


def test_paths_list_collects_every_working_candidate(monkeypatch, tmp_path):
    """start_docker_desktop needs alternatives if launching the first fails."""
    _isolate(monkeypatch)
    first = _make_install(tmp_path / "one")
    second = _make_install(tmp_path / "two")

    monkeypatch.setattr(docker_manager, "_registry_install_roots", lambda: iter([str(first)]))
    monkeypatch.setattr(docker_manager, "_path_install_roots", lambda: iter([str(second)]))

    candidates = docker_manager._docker_desktop_paths()
    assert candidates == [str(first / EXE_NAME), str(second / EXE_NAME)]


def test_paths_list_has_no_duplicates(monkeypatch, tmp_path):
    """Registry and PATH usually agree; the same exe must not appear twice."""
    _isolate(monkeypatch)
    root = _make_install(tmp_path / "same")

    monkeypatch.setattr(docker_manager, "_registry_install_roots", lambda: iter([str(root)]))
    monkeypatch.setattr(docker_manager, "_path_install_roots", lambda: iter([str(root)]))

    assert docker_manager._docker_desktop_paths() == [str(root / EXE_NAME)]


def test_registry_probe_never_raises():
    """Runs for real: on non-Windows there is no winreg, and that is fine."""
    assert isinstance(list(docker_manager._registry_install_roots()), list)


def test_quoted_registry_value_is_handled(monkeypatch, tmp_path):
    """Registry paths are sometimes stored quoted."""
    _isolate(monkeypatch)
    root = _make_install(tmp_path / "quoted")

    monkeypatch.setattr(
        docker_manager, "_registry_install_roots", lambda: iter([f'"{root}"'])
    )

    assert docker_manager.find_docker_desktop() == str(root / EXE_NAME)


def test_start_uses_live_discovery_not_an_import_time_snapshot(monkeypatch, tmp_path):
    """The user may install Docker while Audora is already running.

    'Start Docker & Retry' has to find an install that appeared after startup.
    """
    _isolate(monkeypatch)
    manager = docker_manager.DockerManager()
    monkeypatch.setattr(manager, "is_docker_running", lambda: False)

    root = _make_install(tmp_path / "installed-later")
    monkeypatch.setattr(docker_manager, "_registry_install_roots", lambda: iter([str(root)]))

    launched = []
    monkeypatch.setattr(
        docker_manager.subprocess, "Popen", lambda args, **kw: launched.append(args)
    )
    # Do not actually wait 60s for an engine that will never arrive.
    monkeypatch.setattr(docker_manager.time, "sleep", lambda _seconds: None)

    manager.start_docker_desktop()

    assert launched, "never attempted to launch the newly-installed Docker"
    assert launched[0] == [str(root / EXE_NAME)]
