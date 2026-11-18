"""Playlist HTTP operations must preserve library files and stable paths."""
import os
import sys

import pytest

pytest.importorskip("PIL")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import create_engine  # noqa: E402
from sqlalchemy.orm import Session  # noqa: E402
from sqlalchemy.pool import StaticPool  # noqa: E402

import app  # noqa: E402
from database import Base  # noqa: E402


def test_playlist_api_uses_paths_and_does_not_copy_or_delete_music(monkeypatch, tmp_path):
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(engine)
    song = tmp_path / "Song.flac"
    song.write_bytes(b"music")
    second_song = tmp_path / "Second.flac"
    second_song.write_bytes(b"music too")
    library = [
        {"id": 1, "file_path": str(song), "title": "Song"},
        {"id": 2, "file_path": str(second_song), "title": "Second"},
    ]
    monkeypatch.setattr(app.lib_mgr, "get_all_tracks", lambda: library)

    def test_db():
        with Session(engine) as session:
            yield session

    app.app.dependency_overrides[app.get_db] = test_db
    try:
        client = TestClient(app.app)
        created = client.post("/playlists", json={"name": "Favorites"})
        assert created.status_code == 200
        playlist_id = created.json()["data"]["id"]
        assert client.post("/playlists", json={"name": "favorites"}).status_code == 409
        assert client.post(f"/playlists/{playlist_id}/tracks", json={"file_path": "missing.flac"}).status_code == 404
        route = f"/playlists/{playlist_id}/tracks"
        assert client.post(route, json={"file_path": str(song)}).status_code == 200
        assert client.post(route, json={"file_path": str(song)}).status_code == 200
        assert len(client.get("/playlists").json()["data"][0]["tracks"]) == 1
        assert client.patch(f"/playlists/{playlist_id}", json={"name": "Evening"}).status_code == 200
        assert client.post(route, json={"file_path": str(second_song)}).status_code == 200
        entries = client.get("/playlists").json()["data"][0]["tracks"]
        assert client.patch(
            f"/playlists/{playlist_id}/tracks/{entries[1]['entry_id']}", json={"position": 0}
        ).status_code == 200
        assert [entry["file_path"] for entry in client.get("/playlists").json()["data"][0]["tracks"]] == [str(second_song), str(song)]
        library[0]["id"] = 8  # library rescan assigned a new database ID
        assert client.get("/playlists").json()["data"][0]["tracks"][1]["track"]["id"] == 8
        assert client.delete(f"/playlists/{playlist_id}").status_code == 200
    finally:
        app.app.dependency_overrides.clear()
        engine.dispose()

    assert song.read_bytes() == b"music"
    assert second_song.read_bytes() == b"music too"
    assert set(tmp_path.iterdir()) == {song, second_song}
