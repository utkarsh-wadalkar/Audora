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
import library_manager  # noqa: E402
from fastapi import HTTPException  # noqa: E402
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


def test_artwork_request_cannot_follow_a_recycled_track_id(monkeypatch, tmp_path):
    from types import SimpleNamespace

    manager = library_manager.LibraryManager()
    monkeypatch.setattr(library_manager, "_ART_DIR", str(tmp_path / "cache"))
    monkeypatch.setattr(app, "lib_mgr", manager)
    before = tmp_path / "old.flac"
    after = tmp_path / "new.flac"
    before.touch()
    after.touch()
    old_revision = manager.artwork_revision(str(before))
    new_revision = manager.artwork_revision(str(after))
    manager._tracks = [{"id": 1, "file_path": str(after)}]
    manager._cache_art(str(after), SimpleNamespace(pictures=[
        SimpleNamespace(type=3, data=b"\xff\xd8\xffnew cover"),
    ]))

    with pytest.raises(HTTPException) as rejected:
        app.track_art(1, old_revision)
    assert rejected.value.status_code == 404
    result = app.track_art(1, new_revision)
    assert result.media_type == "image/jpeg"
    assert result.headers["cache-control"] == "no-store"


@pytest.mark.parametrize(("extension", "media_type"), [(".opus", "audio/ogg"), (".M4A", "audio/mp4"), (".wav", "audio/wav")])
def test_streaming_uses_the_indexed_audio_file_type_and_supports_ranges(monkeypatch, tmp_path, extension, media_type):
    from fastapi.testclient import TestClient

    source = tmp_path / f"Untagged{extension}"
    source.write_bytes(b"0123456789")
    monkeypatch.setattr(app.lib_mgr, "get_track_by_id", lambda track_id: {"file_path": str(source)} if track_id == 1 else None)

    response = TestClient(app.app).get("/library/stream/1", headers={"Range": "bytes=2-5"})
    assert response.status_code == 206
    assert response.headers["content-type"] == media_type
    assert response.content == b"2345"


def test_local_setup_uses_the_selected_music_folder_for_downloads(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient
    from sqlalchemy.orm import sessionmaker
    import database
    import setup_manager

    music, downloads = tmp_path / "Existing Music", tmp_path / "Downloads"
    music.mkdir()
    downloads.mkdir()
    existing_track = music / "Existing.flac"
    existing_track.write_bytes(b"unreadable audio")
    (downloads / "Download.m4a").write_bytes(b"other audio")
    wrapper = tmp_path / "Wrapper data"
    settings = {"downloads_path": str(downloads), "wrapper_data_path": str(wrapper), "setup_complete": False}

    def save_settings(patch):
        settings.update(patch)
        return dict(settings)

    for module in (app, library_manager, setup_manager):
        monkeypatch.setattr(module, "get_settings", lambda: dict(settings))
    monkeypatch.setattr(app, "update_settings", save_settings)
    monkeypatch.setattr(setup_manager, "update_settings", save_settings)
    monkeypatch.setattr(app.setup_mgr, "check_system", lambda: pytest.fail("Probed Docker during local setup"))
    monkeypatch.setattr(app, "lib_mgr", library_manager.LibraryManager())
    monkeypatch.setattr(library_manager, "_ART_DIR", str(tmp_path / "art"))
    engine = create_engine(f"sqlite:///{tmp_path / 'library.db'}")
    monkeypatch.setattr(database, "SessionLocal", sessionmaker(bind=engine))
    try:
        database.Base.metadata.create_all(engine)
        client = TestClient(app.app)
        initial = "/setup/status?include_system=false"
        assert client.get(initial).json()["data"] == {"complete": False, "library_only": False}
        for invalid in ("relative/path", str(tmp_path / "Missing"), str(existing_track)):
            assert client.post("/setup/local-library", json={"folder": invalid}).status_code == 400
        assert "library_path" not in settings
        assert client.post("/setup/local-library", json={"folder": str(music)}).json()["data"] == {"track_count": 1}
        assert settings["downloads_path"] == str(music.resolve())
        assert settings["library_path"] == str(music.resolve())
        assert settings["wrapper_data_path"] == str(wrapper)
        assert client.get(initial).json()["data"] == {"complete": False, "library_only": True}
        assert client.post("/library/scan").json()["data"] == {"track_count": 1}
        original_id = client.get("/library").json()["data"][0]["id"]

        assert client.post("/setup/complete").json()["data"] == {"complete": True}
        assert client.get(initial).json()["data"] == {"complete": True, "library_only": False}
        new_downloads = music / "ALAC" / "Album"
        new_downloads.mkdir(parents=True)
        (new_downloads / "New download.flac").write_bytes(b"new audio")
        assert client.post("/library/scan").json()["data"] == {"track_count": 2}
        assert (downloads / "Download.m4a").read_bytes() == b"other audio"
        assert next(track["id"] for track in client.get("/library").json()["data"] if track["title"] == "Existing") == original_id
        assert existing_track.read_bytes() == b"unreadable audio"
    finally:
        engine.dispose()
