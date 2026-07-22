"""Unit tests for auth_manager.py — 2FA file write, session detection."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import settings as settings_mod  # noqa: E402
from auth_manager import AuthManager  # noqa: E402


def test_submit_2fa_writes_file(tmp_path, monkeypatch):
    data_dir = tmp_path / "rootfs" / "data"
    monkeypatch.setattr(
        settings_mod,
        "get_settings",
        lambda: {"wrapper_data_path": str(data_dir)},
    )
    # auth_manager imported get_settings by name, so patch there too.
    import auth_manager

    monkeypatch.setattr(auth_manager, "get_settings", lambda: {"wrapper_data_path": str(data_dir)})

    mgr = AuthManager()
    assert mgr.submit_2fa("123456") is True
    twofa = data_dir / "2fa.txt"
    assert twofa.exists()
    assert twofa.read_text().strip() == "123456"


def test_is_logged_in_false_when_empty(tmp_path, monkeypatch):
    data_dir = tmp_path / "empty"
    data_dir.mkdir()
    import auth_manager

    monkeypatch.setattr(auth_manager, "get_settings", lambda: {"wrapper_data_path": str(data_dir)})
    mgr = AuthManager()
    assert mgr.is_logged_in() is False


def test_is_logged_in_true_with_session(tmp_path, monkeypatch):
    data_dir = tmp_path / "session"
    data_dir.mkdir()
    (data_dir / "token.dat").write_text("x")
    import auth_manager

    monkeypatch.setattr(auth_manager, "get_settings", lambda: {"wrapper_data_path": str(data_dir)})
    mgr = AuthManager()
    assert mgr.is_logged_in() is True


def test_is_logged_in_ignores_2fa_file(tmp_path, monkeypatch):
    data_dir = tmp_path / "only2fa"
    data_dir.mkdir()
    (data_dir / "2fa.txt").write_text("123456")
    import auth_manager

    monkeypatch.setattr(auth_manager, "get_settings", lambda: {"wrapper_data_path": str(data_dir)})
    mgr = AuthManager()
    assert mgr.is_logged_in() is False
