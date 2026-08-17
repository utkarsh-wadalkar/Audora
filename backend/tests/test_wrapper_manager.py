"""Wrapper lifecycle tests — reuse a running wrapper instead of recreating it.

Audora used to force-remove and re-run the wrapper container on every app
start. A fresh backend process starts with ``_ready = False`` and no log
monitor, so a perfectly healthy container left over from a previous run was
destroyed and rebuilt — killing any in-flight download with it.

The fix is a TCP liveness probe: ``network_mode: "host"`` means the wrapper's
ports are host ports, so a plain connect to ``127.0.0.1:<port>`` tells us
whether the wrapper is actually serving. If it is, reuse it untouched.

All Docker interaction is mocked, so these run with no daemon and no
``docker`` python lib installed.
"""
import os
import socket
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import wrapper_manager  # noqa: E402
from wrapper_manager import (
    WRAPPER_CONTAINER_NAME,
    WrapperManager,
    parse_twofa_path_from_log,
    resolve_twofa_host_path,
)  # noqa: E402


class _FakeContainer:
    def __init__(self, container_id="deadbeef1234"):
        self.id = container_id


def _make_mgr(
    monkeypatch,
    *,
    docker_running=True,
    container_status="absent",
    listening=False,
):
    """A WrapperManager with every Docker touchpoint stubbed."""
    manager = WrapperManager()
    docker_mgr = wrapper_manager.docker_mgr

    monkeypatch.setattr(docker_mgr, "is_docker_running", lambda: docker_running)
    monkeypatch.setattr(docker_mgr, "get_container_status", lambda name: container_status)
    monkeypatch.setattr(docker_mgr, "get_container", lambda name: _FakeContainer())
    monkeypatch.setattr(
        docker_mgr, "is_port_listening", lambda port, host="127.0.0.1", timeout=1.0: listening
    )
    # Settings are read by _base_config; the module imported get_settings by
    # name, so patch it on wrapper_manager rather than on settings.
    monkeypatch.setattr(
        wrapper_manager,
        "get_settings",
        lambda: {"wrapper_data_path": "D:\\audora\\wrapper\\rootfs\\data"},
    )
    # Never start a real log-monitor thread.
    monkeypatch.setattr(manager, "_start_monitor", lambda container_id, is_login: None)
    return manager, docker_mgr


def _spy_start_container(monkeypatch, docker_mgr, *, result=None):
    """Record start_container calls so tests can assert it was never made."""
    calls = []

    def fake_start(config):
        calls.append(config)
        return result if result is not None else _FakeContainer()

    monkeypatch.setattr(docker_mgr, "start_container", fake_start)
    return calls


def _spy_stop_container(monkeypatch, docker_mgr):
    calls = []
    monkeypatch.setattr(
        docker_mgr, "stop_container", lambda name, timeout=10: calls.append(name) or True
    )
    return calls


# ---------------------------------------------------------------------------
# The port probe itself
# ---------------------------------------------------------------------------

def test_probe_reports_listening_when_connect_succeeds(monkeypatch):
    from docker_manager import DockerManager

    manager = DockerManager()
    attempted = {}

    class _FakeSocket:
        def __enter__(self):
            return self

        def __exit__(self, *exc_info):
            return False

    def fake_create_connection(address, timeout=None):
        attempted["address"] = address
        attempted["timeout"] = timeout
        return _FakeSocket()

    monkeypatch.setattr(socket, "create_connection", fake_create_connection)

    assert manager.is_port_listening(10020) is True
    assert attempted["address"] == ("127.0.0.1", 10020)
    # Must be a short timeout — this runs on the startup path.
    assert attempted["timeout"] is not None and attempted["timeout"] <= 2.0


def test_probe_reports_not_listening_when_connect_refused(monkeypatch):
    from docker_manager import DockerManager

    manager = DockerManager()

    def refuse(address, timeout=None):
        raise ConnectionRefusedError("nothing there")

    monkeypatch.setattr(socket, "create_connection", refuse)
    assert manager.is_port_listening(10020) is False


def test_probe_never_raises_on_unexpected_error(monkeypatch):
    from docker_manager import DockerManager

    manager = DockerManager()

    def explode(address, timeout=None):
        raise OSError("network unreachable")

    monkeypatch.setattr(socket, "create_connection", explode)
    # Degrades to False rather than propagating — startup must not crash.
    assert manager.is_port_listening(10020) is False


def test_wrapper_listening_requires_the_decrypt_port(monkeypatch):
    """10020 is the port downloads actually need, so it gates readiness."""
    manager, docker_mgr = _make_mgr(monkeypatch)
    probed = []

    def only_decrypt(port, host="127.0.0.1", timeout=1.0):
        probed.append(port)
        return port == 10020

    monkeypatch.setattr(docker_mgr, "is_port_listening", only_decrypt)
    assert manager.is_wrapper_listening() is True
    assert 10020 in probed


def test_wrapper_not_listening_when_decrypt_port_is_dead(monkeypatch):
    manager, docker_mgr = _make_mgr(monkeypatch)
    monkeypatch.setattr(
        docker_mgr,
        "is_port_listening",
        lambda port, host="127.0.0.1", timeout=1.0: port != 10020,
    )
    assert manager.is_wrapper_listening() is False


# ---------------------------------------------------------------------------
# Reuse: a live wrapper must not be torn down
# ---------------------------------------------------------------------------

def test_running_and_listening_wrapper_is_reused_untouched(monkeypatch):
    """The core regression: no stop, no remove, no re-run."""
    manager, docker_mgr = _make_mgr(
        monkeypatch, container_status="running", listening=True
    )
    start_calls = _spy_start_container(monkeypatch, docker_mgr)
    stop_calls = _spy_stop_container(monkeypatch, docker_mgr)

    assert manager.start_wrapper() is True
    assert start_calls == [], "a live wrapper was recreated instead of reused"
    assert stop_calls == [], "a live wrapper was stopped instead of reused"
    # Reuse implies ready — downloads can proceed immediately.
    assert manager.is_wrapper_ready() is True


def test_reuse_marks_ready_without_log_scraping(monkeypatch):
    """A fresh process has no monitor, so readiness must not need log markers."""
    manager, _docker_mgr = _make_mgr(
        monkeypatch, container_status="running", listening=True
    )
    _spy_start_container(monkeypatch, _docker_mgr)

    assert manager._ready is False  # fresh process
    manager.start_wrapper()
    assert manager._ready is True


def test_login_never_reuses_an_existing_container(monkeypatch):
    """Login passes different args, so the container MUST be recreated."""
    manager, docker_mgr = _make_mgr(
        monkeypatch, container_status="running", listening=True
    )
    start_calls = _spy_start_container(monkeypatch, docker_mgr)

    assert manager.start_wrapper_login("user@example.com", "secret") is True
    assert len(start_calls) == 1, "login must not reuse a container started without -L"
    assert "-L" in start_calls[0]["environment"]["args"]


# ---------------------------------------------------------------------------
# Fallback: force-remove only when the container is not serving
# ---------------------------------------------------------------------------

def test_exists_but_dead_container_is_recreated(monkeypatch):
    """exited/dead container -> fall through to the normal start path."""
    manager, docker_mgr = _make_mgr(
        monkeypatch, container_status="exited", listening=False
    )
    start_calls = _spy_start_container(monkeypatch, docker_mgr)

    assert manager.start_wrapper() is True
    assert len(start_calls) == 1, "a dead container should be replaced"


def test_running_but_not_listening_container_is_recreated(monkeypatch):
    """Container up but the wrapper inside never bound its port."""
    manager, docker_mgr = _make_mgr(
        monkeypatch, container_status="running", listening=False
    )
    start_calls = _spy_start_container(monkeypatch, docker_mgr)

    assert manager.start_wrapper() is True
    assert len(start_calls) == 1, "a non-serving container should be replaced"


def test_absent_container_starts_normally(monkeypatch):
    manager, docker_mgr = _make_mgr(
        monkeypatch, container_status="absent", listening=False
    )
    start_calls = _spy_start_container(monkeypatch, docker_mgr)

    assert manager.start_wrapper() is True
    assert len(start_calls) == 1


def test_start_still_fails_cleanly_when_docker_is_down(monkeypatch):
    manager, docker_mgr = _make_mgr(monkeypatch, docker_running=False)
    start_calls = _spy_start_container(monkeypatch, docker_mgr)
    events = []
    manager.register_auth_callback(events.append)

    assert manager.start_wrapper() is False
    assert start_calls == []
    assert any(event["type"] == "auth_error" for event in events)


# ---------------------------------------------------------------------------
# Readiness reporting consistency
# ---------------------------------------------------------------------------

def test_is_wrapper_ready_requires_the_port_not_just_running(monkeypatch):
    """A running-but-not-bound container must not report ready.

    Otherwise /download skips the start and hands a dead port to the
    downloader.
    """
    manager, _docker_mgr = _make_mgr(
        monkeypatch, container_status="running", listening=False
    )
    assert manager.is_wrapper_ready() is False


def test_get_wrapper_status_reports_a_reused_wrapper_as_ready(monkeypatch):
    """queue_processor gates on this dict; raw _ready would say not-ready."""
    manager, _docker_mgr = _make_mgr(
        monkeypatch, container_status="running", listening=True
    )
    status = manager.get_wrapper_status()
    assert status["running"] is True
    assert status["ready"] is True, "a live wrapper reported itself not ready"
    assert status["message"] == "Ready"


def test_get_wrapper_status_when_stopped(monkeypatch):
    manager, _docker_mgr = _make_mgr(
        monkeypatch, container_status="absent", listening=False
    )
    status = manager.get_wrapper_status()
    assert status["running"] is False
    assert status["ready"] is False
    assert status["message"] == "Stopped"


def test_wait_until_ready_succeeds_via_the_probe(monkeypatch):
    """A reused container never emits a fresh 'listening' log line."""
    manager, _docker_mgr = _make_mgr(
        monkeypatch, container_status="running", listening=True
    )
    assert manager._ready is False
    assert manager.wait_until_ready(timeout=1) is True


# ---------------------------------------------------------------------------
# Config invariants that must not regress (v1.3.1)
# ---------------------------------------------------------------------------

def test_base_config_keeps_privileged_and_host_network(monkeypatch):
    manager, _docker_mgr = _make_mgr(monkeypatch)
    config = manager._base_config("-H 0.0.0.0")

    # The wrapper bind-mounts /dev/urandom and chroots; both need privileges.
    assert config["privileged"] is True
    assert config["network_mode"] == "host"
    # Docker rejects port publishing combined with host networking.
    assert "ports" not in config
    assert config["name"] == WRAPPER_CONTAINER_NAME


# ---------------------------------------------------------------------------
# Shutdown: a clean exit leaves the wrapper up so the next start reuses it
# ---------------------------------------------------------------------------

def test_keep_wrapper_running_defaults_to_true():
    """Otherwise a clean exit removes the container and the next start rebuilds."""
    from settings import DEFAULTS

    assert DEFAULTS.get("keep_wrapper_running") is True


def test_keep_wrapper_running_is_an_accepted_setting():
    """update_settings only persists known keys, so it must be declared."""
    from schemas import SettingsUpdate
    from settings import DEFAULTS

    assert "keep_wrapper_running" in DEFAULTS
    assert "keep_wrapper_running" in SettingsUpdate.model_fields


# ---------------------------------------------------------------------------
# Runtime 2FA path and authentication state detection
# ---------------------------------------------------------------------------

def test_twofa_path_is_parsed_from_the_wrapper_prompt():
    line = "[!] Enter your 2FA code into rootfs//data/2fa.txt"
    assert parse_twofa_path_from_log(line) == "rootfs//data/2fa.txt"


def test_twofa_example_command_path_is_parsed_without_hardcoding_tail():
    line = "Example command: echo -n 114514 > rootfs/data/data/com.apple.android.music/files/2fa.txt"
    assert parse_twofa_path_from_log(line) == (
        "rootfs/data/data/com.apple.android.music/files/2fa.txt"
    )


def test_runtime_twofa_path_resolves_against_the_configured_mount(tmp_path):
    reported = "rootfs/data/2fa.txt"
    host_root = tmp_path / "rootfs" / "data"
    assert resolve_twofa_host_path(reported, str(host_root)) == str(
        host_root / "2fa.txt"
    )


def test_runtime_twofa_path_keeps_every_reported_nested_segment(tmp_path):
    reported = "rootfs//data/data/com.apple.android.music/files/2fa.txt"
    host_root = tmp_path / "rootfs" / "data"
    assert resolve_twofa_host_path(reported, str(host_root)) == str(
        host_root / "data" / "com.apple.android.music" / "files" / "2fa.txt"
    )


def test_wrapper_emits_raw_log_and_twofa_state_from_runtime_prompt(monkeypatch):
    manager, _docker_mgr = _make_mgr(monkeypatch)
    raw_lines = []
    events = []
    manager.register_log_callback(raw_lines.append)
    manager.register_auth_callback(events.append)

    line = "[!] Enter your 2FA code into rootfs/data/2fa.txt"
    manager._inspect_log_line(line, is_login=False)

    assert raw_lines == [{"sequence": 1, "line": line}]
    assert events == [
        {
            "type": "auth_2fa_required",
            "message": "Enter your 6-digit verification code",
            "path": "rootfs/data/2fa.txt",
        }
    ]
    assert manager.get_twofa_host_path().endswith("rootfs\\data\\2fa.txt")


def test_wrapper_emits_authenticated_state_only_for_listening_log(monkeypatch):
    manager, _docker_mgr = _make_mgr(monkeypatch)
    events = []
    manager.register_auth_callback(events.append)

    manager._inspect_log_line("listening 0.0.0.0:10020", is_login=False)

    assert events == [{"type": "auth_success", "message": "Signed in successfully"}]


def test_later_example_command_refreshes_the_path_for_the_same_run(monkeypatch):
    manager, _docker_mgr = _make_mgr(monkeypatch)

    manager._inspect_log_line(
        "Enter your 2FA code into rootfs/data/2fa.txt", is_login=True
    )
    manager._inspect_log_line(
        "Example command: echo -n 114514 > rootfs/data/current-version/2fa.txt",
        is_login=True,
    )

    assert manager.get_twofa_host_path().endswith(
        "rootfs\\data\\current-version\\2fa.txt"
    )
