"""The downloader and wrapper must agree on the same live HTTP API."""

import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import downloader_config  # noqa: E402
import setup_manager  # noqa: E402
import wrapper_manager  # noqa: E402


def test_generated_config_uses_the_current_nested_schema():
    yaml = pytest.importorskip("yaml")
    config = yaml.safe_load(downloader_config.build_config())
    assert set(config) == {"general", "media", "paths", "metadata", "convert"}
    assert config["general"]["lite-server"] == "http://127.0.0.1:12340"
    assert config["paths"]["alac"] == "/downloads/ALAC"
    assert config["metadata"]["tags"]["use-songinfo-for-playlist"] is True
    assert config["metadata"]["artwork"]["embed"] is True
    assert config["convert"]["after-download"] is False
    assert "decrypt-m3u8-port" not in config


def test_setup_pulls_the_lite_image_instead_of_building_the_legacy_wrapper(monkeypatch):
    manager = setup_manager.SetupManager()
    calls = []
    monkeypatch.setattr(
        manager,
        "_pull_image_step",
        lambda step, image, target: calls.append((step, image)),
    )
    manager._build_wrapper_step()
    assert calls == [("build_wrapper", wrapper_manager.WRAPPER_IMAGE)]


def test_login_uses_lite_image_and_environment_credentials(monkeypatch, tmp_path):
    manager = wrapper_manager.WrapperManager()
    monkeypatch.setattr(wrapper_manager, "get_settings", lambda: {"wrapper_data_path": str(tmp_path)})
    config = manager._base_config({"USERNAME": "user@example.com", "PASSWORD": "secret"})
    assert config["image"] == wrapper_manager.WRAPPER_IMAGE
    assert config["environment"]["USERNAME"] == "user@example.com"
    assert config["environment"]["PASSWORD"] == "secret"
    assert "args" not in config["environment"]


def test_readiness_requires_successful_lite_status_response(monkeypatch):
    manager = wrapper_manager.WrapperManager()

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self):
            return json.dumps({"code": 0, "msg": "SUCCESS", "data": {"regions": ["us"]}}).encode()

    called = []
    monkeypatch.setattr(wrapper_manager.urllib.request, "urlopen", lambda url, timeout: called.append(url) or Response())
    assert manager.is_wrapper_listening() is True
    assert called == ["http://127.0.0.1:12340/status"]


@pytest.mark.parametrize(
    "payload",
    [
        {"code": 1, "data": {"regions": ["us"]}},
        {"code": 0, "data": {"regions": []}},
        {"code": 0, "data": {}},
    ],
)
def test_open_port_without_authenticated_regions_is_not_ready(monkeypatch, payload):
    manager = wrapper_manager.WrapperManager()

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self):
            return json.dumps(payload).encode()

    monkeypatch.setattr(wrapper_manager.urllib.request, "urlopen", lambda *_args, **_kwargs: Response())
    assert manager.is_wrapper_listening() is False


def test_connection_refused_is_not_ready(monkeypatch):
    manager = wrapper_manager.WrapperManager()

    def refuse(*_args, **_kwargs):
        raise ConnectionRefusedError("connection refused")

    monkeypatch.setattr(wrapper_manager.urllib.request, "urlopen", refuse)
    assert manager.is_wrapper_listening() is False


def test_lite_twofa_path_maps_to_the_mounted_host_data(tmp_path):
    assert wrapper_manager.resolve_twofa_host_path("/data/2fa.txt", str(tmp_path)) == str(
        tmp_path / "2fa.txt"
    )
