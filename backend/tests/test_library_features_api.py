"""Library metadata APIs retain on-disk paths and never alter music files."""
import os
import sys

import pytest

pytest.importorskip("PIL")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import create_engine  # noqa: E402
from sqlalchemy.orm import Session  # noqa: E402
from sqlalchemy.pool import StaticPool  # noqa: E402

import app  # noqa: E402
from database import Base  # noqa: E402


def test_favorites_smart_rules_and_lyrics_follow_track_path(monkeypatch, tmp_path):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    song = tmp_path / "Song.flac"
    song.write_bytes(b"original music")
    (tmp_path / "Song.lrc").write_text("[00:01.00]Hello", encoding="utf-8")
    library = [{"id": 1, "file_path": str(song), "title": "Song", "artist": "Artist", "album": "Album"}]
    monkeypatch.setattr(app.lib_mgr, "get_all_tracks", lambda: library)
    monkeypatch.setattr(app.lib_mgr, "get_track_by_id", lambda track_id: next((item for item in library if item["id"] == track_id), None))

    try:
        with Session(engine) as db:
            assert app.add_favorite(1, db).success
            assert app.add_favorite(1, db).success
            assert app.list_favorites(db).data == [str(song)]
            created = app.create_smart_playlist(app.SmartPlaylistInput(
                name="Loved Artist", artist_contains="artist", favorites_only=True,
            ), db)
            assert created.data[0]["tracks"][0]["id"] == 1
            playlist_id = created.data[0]["id"]
            edited = app.update_smart_playlist(playlist_id, app.SmartPlaylistInput(
                name="Favorite Album", album_contains="album", favorites_only=True,
            ), db)
            assert edited.data[0]["name"] == "Favorite Album"
            library[0]["id"] = 8
            assert app.list_smart_playlists(db).data[0]["tracks"][0]["id"] == 8
            assert app.get_track_lyrics(8).data == {"text": "[00:01.00]Hello", "synced": True}
            assert app.remove_favorite(8, db).success
            assert app.list_smart_playlists(db).data[0]["tracks"] == []
            assert app.delete_smart_playlist(playlist_id, db).success
    finally:
        engine.dispose()

    assert song.read_bytes() == b"original music"
