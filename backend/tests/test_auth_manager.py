"""Unit tests for auth_manager.py — 2FA file write, session detection.

The 2FA path is the important part here. The wrapper polls a file several
levels below the mounted volume root, and Audora used to write it to the volume
root instead, so the wrapper never saw the code, waited its full 60s window,
and exited — leaving the UI on a code-entry screen for a container that no
longer existed.

Container mount:  {wrapper_data_path} -> /app/rootfs/data
Wrapper reports:  rootfs//data/data/com.apple.android.music/files/2fa.txt
                  (relative to its /app workdir)
Absolute:         /app/rootfs/data/data/com.apple.android.music/files/2fa.txt
                   \\_______________/  mount point ends here
Host tail:        data/com.apple.android.music/files/2fa.txt   <- ONE "data"

``wrapper_data_path`` already ends in ``rootfs/data``, so re-appending the whole
logged path would double-count it. These tests pin the arithmetic so a future
wrapper version cannot silently reintroduce the mismatch.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import auth_manager  # noqa: E402
from auth_manager import (  # noqa: E402
    TWOFA_FILENAME,
    WRAPPER_BASE_SUBDIR,
    AuthManager,
)

# The exact tail the wrapper reads, below the mounted volume root.
EXPECTED_TAIL = os.path.join("data", "com.apple.android.music", "files", "2fa.txt")


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

def test_twofa_path_matches_the_wrappers_nested_layout(tmp_path, monkeypatch):
    """Pins the exact nested path, so a version bump cannot break it silently."""
    manager = _mgr(monkeypatch, tmp_path)
    assert manager.twofa_path() == os.path.join(str(tmp_path), EXPECTED_TAIL)


def test_twofa_path_has_exactly_one_data_segment(tmp_path, monkeypatch):
    """Regression guard: the tail must not double-count the mount point.

    wrapper_data_path already ends in rootfs/data, so appending the wrapper's
    full logged path would give /app/rootfs/data/data/data/... in the container.
    """
    manager = _mgr(monkeypatch, tmp_path)
    tail = os.path.relpath(manager.twofa_path(), str(tmp_path))
    segments = tail.replace("\\", "/").split("/")
    assert segments.count("data") == 1, f"expected one 'data' segment, got {tail!r}"
    assert segments == [
        "data",
        "com.apple.android.music",
        "files",
        "2fa.txt",
    ], tail


def test_submit_2fa_writes_to_the_nested_path(tmp_path, monkeypatch):
    data_dir = tmp_path / "rootfs" / "data"
    manager = _mgr(monkeypatch, data_dir)

    assert manager.submit_2fa("123456") is True

    written = data_dir / EXPECTED_TAIL
    assert written.is_file(), f"2FA code not written to {written}"
    assert written.read_text(encoding="utf-8") == "123456"


def test_submit_2fa_does_not_write_to_the_volume_root(tmp_path, monkeypatch):
    """The old location the wrapper never reads must stay empty."""
    data_dir = tmp_path / "rootfs" / "data"
    manager = _mgr(monkeypatch, data_dir)

    manager.submit_2fa("123456")

    assert not (data_dir / TWOFA_FILENAME).exists(), (
        "wrote to the volume root, which the wrapper does not poll"
    )


def test_submit_2fa_creates_missing_intermediate_directories(tmp_path, monkeypatch):
    """The target is several levels down and may not exist yet."""
    data_dir = tmp_path / "fresh"
    manager = _mgr(monkeypatch, data_dir)
    assert not data_dir.exists()

    assert manager.submit_2fa("654321") is True
    assert (data_dir / EXPECTED_TAIL).is_file()


def test_submit_2fa_writes_bare_digits_with_no_newline(tmp_path, monkeypatch):
    """The wrapper's own example is `echo -n 114514 > ...` — no trailing NL."""
    data_dir = tmp_path / "data"
    manager = _mgr(monkeypatch, data_dir)

    manager.submit_2fa("  123456\n")

    raw = (data_dir / EXPECTED_TAIL).read_bytes()
    assert raw == b"123456", f"expected bare digits, got {raw!r}"


def test_submit_2fa_clears_pending_flag(tmp_path, monkeypatch):
    manager = _mgr(monkeypatch, tmp_path / "data")
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
    manager.submit_2fa("000000")
    stale = data_dir / EXPECTED_TAIL
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
    manager.submit_2fa("123456")

    assert manager.is_logged_in() is False


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
