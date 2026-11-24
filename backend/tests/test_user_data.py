"""Upgrading preserves the user's SQLite data and setup state."""
from contextlib import closing
from pathlib import Path
import json
import sqlite3
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from user_data import migrate_user_data


def test_migration_preserves_committed_wal_and_settings(tmp_path):
    profile = tmp_path / "profile"
    destination = profile / "backend"
    legacy = profile / "legacy-install-backup"
    legacy.mkdir(parents=True)
    settings = {"setup_complete": True, "downloads_path": "existing-library"}
    (legacy / "settings.json").write_text(json.dumps(settings), encoding="utf-8")
    source = legacy / "audora.db"
    with closing(sqlite3.connect(source)) as old:
        old.execute("PRAGMA journal_mode = WAL")
        for table in ("favorites", "playlists", "smart_playlists"):
            old.execute(f"CREATE TABLE {table} (name TEXT)")
            old.execute(f"INSERT INTO {table} VALUES (?)", (f"old {table}",))
        old.commit()
        assert source.with_suffix(".db-wal").is_file()

        migrate_user_data(destination)
        assert json.loads((destination / "settings.json").read_text(encoding="utf-8")) == settings
        with closing(sqlite3.connect(destination / "audora.db")) as updated:
            for table in ("favorites", "playlists", "smart_playlists"):
                assert updated.execute(f"SELECT name FROM {table}").fetchall() == [(f"old {table}",)]
            updated.execute("INSERT INTO playlists VALUES ('new playlist')")
            updated.commit()
        migrate_user_data(destination)
        with closing(sqlite3.connect(destination / "audora.db")) as updated:
            assert updated.execute("SELECT name FROM playlists").fetchall() == [
                ("old playlists",), ("new playlist",),
            ]


def test_first_launch_in_place_can_read_legacy_resources(tmp_path):
    legacy = tmp_path / "old-resources"
    legacy.mkdir()
    (legacy / "settings.json").write_text('{"setup_complete": true}', encoding="utf-8")
    destination = tmp_path / "profile" / "backend"
    migrate_user_data(destination, legacy)
    assert (destination / "settings.json").read_text(encoding="utf-8") == '{"setup_complete": true}'
