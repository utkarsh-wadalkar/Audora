"""Unit tests for docker_manager.py — streaming pull + preflight checks.

These tests mock the Docker SDK entirely, so they pass on a machine with no
Docker daemon and no ``docker`` python lib installed.
"""
import os
import socket
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import shutil  # noqa: E402

import docker_manager  # noqa: E402
from docker_manager import DockerManager  # noqa: E402


class _FakeApi:
    """Stand-in for ``client.api`` exposing a low-level ``pull``."""

    def __init__(self, events):
        self._events = events

    def pull(self, image, stream=True, decode=True):
        # Mirror the real low-level signature; yield decoded dict events.
        assert stream is True
        assert decode is True
        for ev in self._events:
            yield ev


class _FakeClient:
    def __init__(self, events=None, ping_result=True, ping_exc=None):
        self.api = _FakeApi(events or [])
        self._ping_result = ping_result
        self._ping_exc = ping_exc

    def ping(self):
        if self._ping_exc is not None:
            raise self._ping_exc
        return self._ping_result


# ---------------------------------------------------------------------------
# pull_image_streaming
# ---------------------------------------------------------------------------

def _multi_layer_events():
    """Realistic Downloading -> Extracting -> Pull complete over 2 layers."""
    return [
        {"status": "Pulling from library/test", "id": "latest"},
        {"status": "Downloading", "progressDetail": {"current": 50, "total": 200}, "id": "layerA"},
        {"status": "Downloading", "progressDetail": {"current": 200, "total": 200}, "id": "layerA"},
        {"status": "Extracting", "progressDetail": {"current": 100, "total": 200}, "id": "layerA"},
        {"status": "Pull complete", "id": "layerA"},
        {"status": "Downloading", "progressDetail": {"current": 30, "total": 90}, "id": "layerB"},
        {"status": "Downloading", "progressDetail": {"current": 90, "total": 90}, "id": "layerB"},
        {"status": "Extracting", "progressDetail": {"current": 90, "total": 90}, "id": "layerB"},
        {"status": "Pull complete", "id": "layerB"},
        {"status": "Status: Downloaded newer image for test:latest"},
    ]


def test_pull_image_streaming_forwards_every_event_in_order(monkeypatch):
    events = _multi_layer_events()
    mgr = DockerManager()
    monkeypatch.setattr(mgr, "get_client", lambda: _FakeClient(events=events))

    received = []
    ok = mgr.pull_image_streaming("test:latest", received.append)

    assert ok is True
    # Every decoded event forwarded, in order.
    assert received == events
    # At least two distinct layers were observed.
    layer_ids = {e.get("id") for e in received if e.get("id")}
    assert {"layerA", "layerB"}.issubset(layer_ids)


def test_pull_image_streaming_idempotent_already_up_to_date(monkeypatch):
    # Re-pull of a fully-present image: registry emits "Already exists" /
    # "up to date" style events and no error. Must return True.
    events = [
        {"status": "Pulling from library/test", "id": "latest"},
        {"status": "Already exists", "id": "layerA"},
        {"status": "Already exists", "id": "layerB"},
        {"status": "Status: Image is up to date for test:latest"},
    ]
    mgr = DockerManager()
    monkeypatch.setattr(mgr, "get_client", lambda: _FakeClient(events=events))

    received = []
    ok = mgr.pull_image_streaming("test:latest", received.append)
    assert ok is True
    assert received == events


def test_pull_image_streaming_returns_false_when_client_none(monkeypatch):
    mgr = DockerManager()
    monkeypatch.setattr(mgr, "get_client", lambda: None)
    received = []
    ok = mgr.pull_image_streaming("test:latest", received.append)
    assert ok is False
    assert received == []


def test_pull_image_streaming_returns_false_on_error_event(monkeypatch):
    events = [
        {"status": "Downloading", "progressDetail": {"current": 1, "total": 2}, "id": "layerA"},
        {"error": "toomanyrequests: rate limit"},
    ]
    mgr = DockerManager()
    monkeypatch.setattr(mgr, "get_client", lambda: _FakeClient(events=events))
    received = []
    ok = mgr.pull_image_streaming("test:latest", received.append)
    assert ok is False
    # Error event is still forwarded so callers can classify it.
    assert received[-1] == {"error": "toomanyrequests: rate limit"}


def test_pull_image_streaming_callback_error_does_not_abort(monkeypatch):
    events = _multi_layer_events()
    mgr = DockerManager()
    monkeypatch.setattr(mgr, "get_client", lambda: _FakeClient(events=events))

    calls = {"n": 0}

    def bad_cb(_ev):
        calls["n"] += 1
        raise ValueError("boom")

    ok = mgr.pull_image_streaming("test:latest", bad_cb)
    assert ok is True
    # Callback was attempted for every event despite raising each time.
    assert calls["n"] == len(events)


# ---------------------------------------------------------------------------
# check_disk_space
# ---------------------------------------------------------------------------

def _usage(total, used, free):
    from collections import namedtuple

    Usage = namedtuple("usage", ["total", "used", "free"])
    return Usage(total, used, free)


def test_check_disk_space_enough(monkeypatch):
    monkeypatch.setattr(shutil, "disk_usage", lambda p: _usage(100, 40, 60))
    mgr = DockerManager()
    assert mgr.check_disk_space("C:\\", 50) is True


def test_check_disk_space_not_enough(monkeypatch):
    monkeypatch.setattr(shutil, "disk_usage", lambda p: _usage(100, 90, 10))
    mgr = DockerManager()
    assert mgr.check_disk_space("C:\\", 50) is False


def test_check_disk_space_degrades_true_on_error(monkeypatch):
    def boom(_p):
        raise OSError("no such path")

    monkeypatch.setattr(shutil, "disk_usage", boom)
    mgr = DockerManager()
    assert mgr.check_disk_space("C:\\nope", 50) is True


# ---------------------------------------------------------------------------
# check_dns
# ---------------------------------------------------------------------------

def test_check_dns_success(monkeypatch):
    monkeypatch.setattr(
        socket, "getaddrinfo", lambda host, port: [(2, 1, 6, "", ("1.2.3.4", 0))]
    )
    mgr = DockerManager()
    assert mgr.check_dns("ghcr.io") is True


def test_check_dns_failure(monkeypatch):
    def boom(host, port):
        raise socket.gaierror("name resolution failed")

    monkeypatch.setattr(socket, "getaddrinfo", boom)
    mgr = DockerManager()
    assert mgr.check_dns("nonexistent.invalid") is False


def test_check_dns_restores_default_timeout(monkeypatch):
    before = socket.getdefaulttimeout()
    monkeypatch.setattr(
        socket, "getaddrinfo", lambda host, port: [(2, 1, 6, "", ("1.2.3.4", 0))]
    )
    mgr = DockerManager()
    mgr.check_dns("ghcr.io")
    assert socket.getdefaulttimeout() == before


# ---------------------------------------------------------------------------
# is_docker_api_responsive
# ---------------------------------------------------------------------------

def test_is_docker_api_responsive_true(monkeypatch):
    mgr = DockerManager()
    monkeypatch.setattr(mgr, "get_client", lambda: _FakeClient(ping_result=True))
    assert mgr.is_docker_api_responsive() is True


def test_is_docker_api_responsive_false_when_client_none(monkeypatch):
    mgr = DockerManager()
    monkeypatch.setattr(mgr, "get_client", lambda: None)
    assert mgr.is_docker_api_responsive() is False


def test_is_docker_api_responsive_false_on_ping_exception(monkeypatch):
    mgr = DockerManager()
    fake = _FakeClient(ping_exc=docker_manager.DockerException("engine down"))
    mgr._client = "stale"  # should be cleared on failure
    monkeypatch.setattr(mgr, "get_client", lambda: fake)
    assert mgr.is_docker_api_responsive() is False
    assert mgr._client is None
