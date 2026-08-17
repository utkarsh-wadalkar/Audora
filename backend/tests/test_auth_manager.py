"""Unit tests for runtime 2FA writes and cached-session detection."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import auth_manager  # noqa: E402
from auth_manager import (  # noqa: E402
    TWOFA_FILENAME,
    WRAPPER_BASE_SUBDIR,
    AuthManager,
)

def _mgr(monkeypatch, data_dir):
    """An AuthManager pointed at ``data_dir`` as its wrapper volume root."""
    # auth_manager imported get_settings by name, so patch it there.
    monkeypatch.setattr(
        auth_manager, "get_settings", lambda: {"wrapper_data_path": str(data_dir)}
    )
    return AuthManager()


def _session_db(data_dir):
    """Path of the account store that proves a completed sign-in."""
    return data_dir / WRAPPER_BASE_SUBDIR / "mpl_db" / "accounts.sqlitedb"


# ---------------------------------------------------------------------------
# The 2FA path — the actual bug
# ---------------------------------------------------------------------------

def test_twofa_path_comes_from_the_current_wrapper_run(tmp_path, monkeypatch):
    manager = _mgr(monkeypatch, tmp_path)
    runtime_path = tmp_path / "this-run" / "2fa.txt"
    monkeypatch.setattr(
        auth_manager.wrapper_mgr, "get_twofa_host_path", lambda: str(runtime_path)
    )
    assert manager.twofa_path() == str(runtime_path)


def test_submit_2fa_fails_until_wrapper_reports_a_path(tmp_path, monkeypatch):
    manager = _mgr(monkeypatch, tmp_path)
    monkeypatch.setattr(auth_manager.wrapper_mgr, "get_twofa_host_path", lambda: "")
    assert manager.submit_2fa("123456") is False


def test_submit_2fa_writes_to_the_runtime_reported_path(tmp_path, monkeypatch):
    data_dir = tmp_path / "rootfs" / "data"
    manager = _mgr(monkeypatch, data_dir)
    runtime_path = data_dir / "version-specific" / "2fa.txt"
    monkeypatch.setattr(
        auth_manager.wrapper_mgr, "get_twofa_host_path", lambda: str(runtime_path)
    )

    assert manager.submit_2fa("123456") is True

    assert runtime_path.is_file(), f"2FA code not written to {runtime_path}"
    assert runtime_path.read_text(encoding="utf-8") == "123456"


def test_submit_2fa_does_not_write_to_the_volume_root(tmp_path, monkeypatch):
    """The old location the wrapper never reads must stay empty."""
    data_dir = tmp_path / "rootfs" / "data"
    manager = _mgr(monkeypatch, data_dir)
    runtime_path = data_dir / "reported" / "2fa.txt"
    monkeypatch.setattr(
        auth_manager.wrapper_mgr, "get_twofa_host_path", lambda: str(runtime_path)
    )

    manager.submit_2fa("123456")

    assert not (data_dir / TWOFA_FILENAME).exists(), (
        "wrote to the volume root, which the wrapper does not poll"
    )


def test_submit_2fa_creates_missing_intermediate_directories(tmp_path, monkeypatch):
    """The target is several levels down and may not exist yet."""
    data_dir = tmp_path / "fresh"
    manager = _mgr(monkeypatch, data_dir)
    runtime_path = data_dir / "created-at-runtime" / "2fa.txt"
    monkeypatch.setattr(
        auth_manager.wrapper_mgr, "get_twofa_host_path", lambda: str(runtime_path)
    )
    assert not data_dir.exists()

    assert manager.submit_2fa("654321") is True
    assert runtime_path.is_file()


def test_submit_2fa_writes_bare_digits_with_no_newline(tmp_path, monkeypatch):
    """The wrapper's own example is `echo -n 114514 > ...` — no trailing NL."""
    data_dir = tmp_path / "data"
    manager = _mgr(monkeypatch, data_dir)
    runtime_path = data_dir / "runtime" / "2fa.txt"
    monkeypatch.setattr(
        auth_manager.wrapper_mgr, "get_twofa_host_path", lambda: str(runtime_path)
    )

    manager.submit_2fa("  123456\n")

    raw = runtime_path.read_bytes()
    assert raw == b"123456", f"expected bare digits, got {raw!r}"


def test_submit_2fa_clears_pending_flag(tmp_path, monkeypatch):
    manager = _mgr(monkeypatch, tmp_path / "data")
    monkeypatch.setattr(
        auth_manager.wrapper_mgr,
        "get_twofa_host_path",
        lambda: os.path.join(str(tmp_path), "data", "runtime", "2fa.txt"),
    )
    manager._pending_2fa = True
    manager.submit_2fa("123456")
    assert manager._pending_2fa is False


def test_submit_2fa_fails_cleanly_without_a_configured_path(monkeypatch):
    monkeypatch.setattr(auth_manager, "get_settings", lambda: {"wrapper_data_path": ""})
    assert AuthManager().submit_2fa("123456") is False


def test_login_removes_a_stale_code_first(tmp_path, monkeypatch):
    """A leftover code would be consumed instantly and rejected."""
    import asyncio

    data_dir = tmp_path / "data"
    manager = _mgr(monkeypatch, data_dir)
    stale = data_dir / "old-version" / "2fa.txt"
    stale.parent.mkdir(parents=True)
    stale.write_text("000000", encoding="utf-8")
    assert stale.is_file()

    monkeypatch.setattr(
        auth_manager.wrapper_mgr, "start_wrapper_login", lambda email, password: True
    )
    asyncio.run(manager.login("user@example.com", "pw"))

    assert not stale.exists(), "stale 2FA code survived a fresh login"


# ---------------------------------------------------------------------------
# Session detection — must not count the nested directory as a session
# ---------------------------------------------------------------------------

def test_is_logged_in_false_when_empty(tmp_path, monkeypatch):
    data_dir = tmp_path / "empty"
    data_dir.mkdir()
    assert _mgr(monkeypatch, data_dir).is_logged_in() is False


def test_is_logged_in_true_with_a_real_session_store(tmp_path, monkeypatch):
    data_dir = tmp_path / "session"
    database = _session_db(data_dir)
    database.parent.mkdir(parents=True)
    database.write_text("sqlite", encoding="utf-8")

    assert _mgr(monkeypatch, data_dir).is_logged_in() is True


def test_is_logged_in_false_with_only_the_nested_directory(tmp_path, monkeypatch):
    """The regression that made a failed sign-in look successful.

    Listing the volume root counted the nested ``data/`` directory as a session
    file, so status reported "Signed in" with no session at all.
    """
    data_dir = tmp_path / "dironly"
    (data_dir / WRAPPER_BASE_SUBDIR).mkdir(parents=True)

    assert _mgr(monkeypatch, data_dir).is_logged_in() is False


def test_is_logged_in_false_with_only_provisioning_files(tmp_path, monkeypatch):
    """adi.pb / fsi.pdat appear on first run without any sign-in."""
    data_dir = tmp_path / "provisioned"
    base = data_dir / WRAPPER_BASE_SUBDIR
    base.mkdir(parents=True)
    for name in ("adi.pb", "fsi.pdat", "IC-Info.sids"):
        (base / name).write_text("x", encoding="utf-8")

    assert _mgr(monkeypatch, data_dir).is_logged_in() is False


def test_is_logged_in_false_for_an_empty_session_store(tmp_path, monkeypatch):
    """A zero-byte database is not a usable session."""
    data_dir = tmp_path / "truncated"
    database = _session_db(data_dir)
    database.parent.mkdir(parents=True)
    database.write_bytes(b"")

    assert _mgr(monkeypatch, data_dir).is_logged_in() is False


def test_is_logged_in_ignores_2fa_file(tmp_path, monkeypatch):
    data_dir = tmp_path / "only2fa"
    manager = _mgr(monkeypatch, data_dir)
    monkeypatch.setattr(
        auth_manager.wrapper_mgr,
        "get_twofa_host_path",
        lambda: os.path.join(str(data_dir), "runtime", "2fa.txt"),
    )
    manager.submit_2fa("123456")

    assert manager.is_logged_in() is False


def test_auth_status_trusts_a_listening_wrapper_even_if_cache_layout_changed(
    tmp_path, monkeypatch
):
    manager = _mgr(monkeypatch, tmp_path / "unknown-layout")
    monkeypatch.setattr(
        auth_manager.wrapper_mgr,
        "get_wrapper_status",
        lambda: {"running": True, "ready": True, "pending_2fa": False},
    )

    status = manager.get_auth_status()

    assert status["logged_in"] is True
    assert status["message"] == "Signed in"


# ---------------------------------------------------------------------------
# Logout must clear the nested session, not fail on the first directory
# ---------------------------------------------------------------------------

def test_logout_removes_the_nested_session(tmp_path, monkeypatch):
    """os.remove raises on a directory, so the session used to survive logout."""
    data_dir = tmp_path / "session"
    database = _session_db(data_dir)
    database.parent.mkdir(parents=True)
    database.write_text("sqlite", encoding="utf-8")
    manager = _mgr(monkeypatch, data_dir)
    monkeypatch.setattr(auth_manager.wrapper_mgr, "stop_wrapper", lambda: True)

    assert manager.logout() is True

    assert not database.exists(), "accounts.sqlitedb survived logout"
    assert manager.is_logged_in() is False


def test_logout_survives_an_empty_directory(tmp_path, monkeypatch):
    data_dir = tmp_path / "empty"
    data_dir.mkdir()
    manager = _mgr(monkeypatch, data_dir)
    monkeypatch.setattr(auth_manager.wrapper_mgr, "stop_wrapper", lambda: True)

    assert manager.logout() is True
