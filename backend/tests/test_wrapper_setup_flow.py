"""Setup API contracts for starting and observing the wrapper."""
import asyncio
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import app as app_module  # noqa: E402
import auth_manager  # noqa: E402
import wrapper_manager  # noqa: E402


def test_setup_wrapper_start_returns_the_log_detected_state(monkeypatch):
    monkeypatch.setattr(app_module.wrapper_mgr, "start_wrapper", lambda: True)
    monkeypatch.setattr(
        app_module.wrapper_mgr,
        "wait_for_setup_state",
        lambda timeout=60: "authenticated",
    )

    response = asyncio.run(app_module.setup_wrapper())

    assert response.success is True
    assert response.data == {"started": True, "state": "authenticated"}


def test_setup_wrapper_start_surfaces_start_failure(monkeypatch):
    monkeypatch.setattr(app_module.wrapper_mgr, "start_wrapper", lambda: False)

    response = asyncio.run(app_module.setup_wrapper())

    assert response.success is False
    assert response.data == {"started": False, "state": "error"}


def test_wrapper_log_callback_forwards_the_full_raw_line(monkeypatch):
    forwarded = []
    monkeypatch.setattr(
        app_module,
        "_broadcast_from_thread",
        lambda manager, message: forwarded.append((manager, message)),
    )

    app_module.wrapper_log_callback({"sequence": 7, "line": "listening 0.0.0.0:10020"})

    assert forwarded == [
        (
            app_module.wrapper_log_ws_manager,
            {
                "type": "wrapper_log",
                "sequence": 7,
                "line": "listening 0.0.0.0:10020",
            },
        )
    ]


def test_wrapper_does_not_auto_start_before_first_run_setup_is_complete():
    settings = {"auto_start_wrapper": True}
    assert app_module.should_auto_start_wrapper(settings, setup_complete=False) is False


def test_completed_installation_auto_starts_cached_wrapper():
    settings = {"auto_start_wrapper": True}
    assert app_module.should_auto_start_wrapper(settings, setup_complete=True) is True


def test_real_parser_to_writer_flow_creates_the_reported_2fa_file(
    tmp_path, monkeypatch
):
    """Exercise the real parser, resolver and file writer together."""
    data_root = tmp_path / "rootfs" / "data"
    settings = {"wrapper_data_path": str(data_root)}
    manager = wrapper_manager.WrapperManager()
    monkeypatch.setattr(wrapper_manager, "get_settings", lambda: settings)
    monkeypatch.setattr(auth_manager, "get_settings", lambda: settings)
    monkeypatch.setattr(manager, "_start_2fa_watchdog", lambda: None)
    monkeypatch.setattr(auth_manager, "wrapper_mgr", manager)

    manager._inspect_log_line(
        "Example command: echo -n 114514 > rootfs/data/current-run/2fa.txt",
        is_login=True,
    )
    writer = auth_manager.AuthManager()

    assert writer.submit_2fa("123456") is True
    target = data_root / "current-run" / "2fa.txt"
    assert target.read_bytes() == b"123456"


@pytest.mark.parametrize("volume_name", ["wrapper", "Custom wrapper location"])
@pytest.mark.parametrize(
    "prompt",
    [
        "[!] Enter your 2FA code into rootfs/data/data/com.apple.android.music/files/2fa.txt",
        "Example command: echo -n 114514 > /app/rootfs/data/data/com.apple.android.music/files/2fa.txt",
    ],
)
def test_apple_music_twofa_write_uses_the_configured_native_volume(
    tmp_path, monkeypatch, volume_name, prompt
):
    """The real writer keeps the full suffix on each native OS and custom mount."""
    data_root = tmp_path / volume_name / "rootfs" / "data"
    settings = {"wrapper_data_path": str(data_root)}
    manager = wrapper_manager.WrapperManager()
    monkeypatch.setattr(wrapper_manager, "get_settings", lambda: settings)
    monkeypatch.setattr(auth_manager, "get_settings", lambda: settings)
    monkeypatch.setattr(manager, "_start_2fa_watchdog", lambda: None)
    monkeypatch.setattr(auth_manager, "wrapper_mgr", manager)

    manager._inspect_log_line(prompt, is_login=True)
    writer = auth_manager.AuthManager()
    target = data_root / "data" / "com.apple.android.music" / "files" / "2fa.txt"

    assert writer.twofa_path() == str(target)
    assert writer.submit_2fa(" 123456\n") is True
    assert target.read_bytes() == b"123456"
    assert not (data_root / "2fa.txt").exists()
    assert list(data_root.rglob("2fa.txt")) == [target]
