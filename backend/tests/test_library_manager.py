"""Regression tests for filesystem-backed library grouping."""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import library_manager  # noqa: E402
from library_manager import LibraryManager  # noqa: E402


def _track(file_path: str, title: str, artist: str, album: str) -> dict:
    return {
        "file_path": file_path,
        "title": title,
        "artist": artist,
        "album": album,
        "duration": 180,
        "file_size": 1,
        "format": "flac",
    }


def test_album_artist_keeps_collaborations_together_in_a_flat_folder():
    manager = LibraryManager()
    manager._tracks = [
        _track(
            r"C:\Imported music\01. Circles.flac",
            "Circles",
            "Post Malone",
            "Post Malone Essentials",
        ),
        _track(
            r"C:\Imported music\02. Sunflower.flac",
            "Sunflower",
            "Post Malone & Swae Lee",
            "Post Malone Essentials",
        ),
        _track(
            r"C:\Imported music\01. Lose You to Love Me.flac",
            "Lose You to Love Me",
            "Selena Gomez",
            "Selena Gomez Essentials",
        ),
        _track(
            r"C:\Imported music\02. Calm Down.flac",
            "Calm Down",
            "Rema & Selena Gomez",
            "Selena Gomez Essentials",
        ),
    ]
    for track, album_artist in zip(manager._tracks, ("Post Malone", "Post Malone", "Selena Gomez", "Selena Gomez")):
        track["album_artist"] = album_artist
    manager._tracks.append(_track(r"C:\Imported music\Untagged.flac", "Untagged", "Unknown Artist", "Unknown Album"))

    albums = manager.get_albums()

    assert [album["album"] for album in albums] == [
        "Post Malone Essentials",
        "Selena Gomez Essentials",
    ]
    assert [len(album["tracks"]) for album in albums] == [2, 2]
    assert len(manager.get_all_tracks()) == 5
    assert len({album["id"] for album in albums}) == 2


def test_album_titles_use_natural_name_order():
    manager = LibraryManager()
    manager._tracks = [
        _track(
            r"D:\Music\Album 10\01. Later.flac",
            "Later",
            "Artist",
            "Album 10",
        ),
        _track(
            r"D:\Music\Album 2\01. Earlier.flac",
            "Earlier",
            "Artist",
            "Album 2",
        ),
    ]

    albums = manager.get_albums()

    assert [album["album"] for album in albums] == ["Album 2", "Album 10"]


def test_same_album_title_by_different_artists_creates_distinct_albums():
    manager = LibraryManager()
    manager._tracks = [
        _track("Music/First.flac", "First", "First Artist", "Greatest Hits"),
        _track("Music/Second.flac", "Second", "Second Artist", "Greatest Hits"),
    ]
    albums = manager.get_albums()
    assert [album["artist"] for album in albums] == ["First Artist", "Second Artist"]
    assert len({album["id"] for album in albums}) == 2


def test_album_artist_is_read_from_a_tagged_file_and_survives_restart(monkeypatch, tmp_path):
    import wave

    from mutagen.id3 import TALB, TPE1, TPE2
    from mutagen.wave import WAVE
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    import database

    music = tmp_path / "Mixed music"
    music.mkdir()
    for name, artist in (("One", "Artist One"), ("Two", "Artist Two")):
        path = music / f"{name}.wav"
        with wave.open(str(path), "wb") as audio:
            audio.setparams((1, 2, 8000, 0, "NONE", "not compressed"))
            audio.writeframes(b"\x00\x00" * 8000)
        tagged = WAVE(path)
        tagged.add_tags()
        tagged.tags.add(TALB(encoding=3, text=["Compilation"]))
        tagged.tags.add(TPE1(encoding=3, text=[artist]))
        tagged.tags.add(TPE2(encoding=3, text=["Various Artists"]))
        tagged.save()

    engine = create_engine(f"sqlite:///{tmp_path / 'library.db'}")
    monkeypatch.setattr(database, "engine", engine)
    monkeypatch.setattr(database, "SessionLocal", sessionmaker(bind=engine))
    monkeypatch.setattr(database, "migrate_user_data", lambda _: None)
    monkeypatch.setattr(library_manager, "get_settings", lambda: {"library_path": str(music)})
    try:
        database.Base.metadata.create_all(engine)
        with engine.begin() as connection:
            connection.exec_driver_sql("ALTER TABLE library_tracks DROP COLUMN album_artist")
        database.init_db()
        original_files = {path.name: path.read_bytes() for path in music.iterdir()}
        LibraryManager().scan_library()
        albums = LibraryManager().get_albums()
        assert [(album["album"], album["artist"], len(album["tracks"])) for album in albums] == [
            ("Compilation", "Various Artists", 2),
        ]
        assert {path.name: path.read_bytes() for path in music.iterdir()} == original_files
    finally:
        engine.dispose()


def test_scan_follows_the_current_configured_download_root(monkeypatch, tmp_path):
    """Changing Settings must work for arbitrary roots, not one fixed drive."""
    first_root = tmp_path / "first-library"
    second_root = tmp_path / "second-library"
    first_track = first_root / "Artist A" / "Album A" / "01 First.flac"
    second_track = second_root / "Artist B" / "Album B" / "01 Second.flac"
    first_track.parent.mkdir(parents=True)
    second_track.parent.mkdir(parents=True)
    first_track.touch()
    second_track.touch()

    configured = {"downloads_path": str(first_root)}
    monkeypatch.setattr(library_manager, "get_settings", lambda: dict(configured))

    manager = LibraryManager()
    monkeypatch.setattr(manager, "_persist", lambda tracks: None)
    monkeypatch.setattr(
        manager,
        "_extract_metadata",
        lambda path: _track(path, os.path.basename(path), "Artist", "Metadata Album"),
    )

    assert [track["file_path"] for track in manager.scan_library()] == [
        str(first_track)
    ]

    configured["library_path"] = str(second_root)

    assert [track["file_path"] for track in manager.scan_library()] == [
        str(second_track)
    ]
    assert manager.get_albums()[0]["album"] == "Metadata Album"
    assert configured["library_path"] == str(second_root)

    configured["library_path"] = str(tmp_path / "disconnected")
    with pytest.raises(library_manager.LibraryFolderUnavailable, match="Reconnect the drive"):
        manager.scan_library()
    assert [track["file_path"] for track in manager.get_all_tracks()] == [str(second_track)]


def test_rescan_keeps_track_ids_and_does_not_recycle_removed_ids(monkeypatch, tmp_path):
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    import database
    from models import LibraryTrack

    engine = create_engine(f"sqlite:///{tmp_path / 'library.db'}")
    sessions = sessionmaker(bind=engine)
    monkeypatch.setattr(database, "SessionLocal", sessions)
    monkeypatch.setattr(library_manager, "_ART_DIR", str(tmp_path / "art"))
    downloads = tmp_path / "downloads"
    downloads.mkdir()
    retained = downloads / "06 Retained.flac"
    removed = downloads / "02 Removed.flac"
    replacement = downloads / "01 Replacement.flac"
    retained.touch()
    removed.touch()
    monkeypatch.setattr(library_manager, "get_settings", lambda: {"downloads_path": str(downloads)})
    monkeypatch.setattr(
        LibraryManager,
        "_extract_metadata",
        lambda self, path: _track(path, os.path.basename(path), "Artist", "Album"),
    )

    try:
        # Installations before the allocator was introduced only have track rows.
        LibraryTrack.__table__.create(engine)
        with sessions() as session:
            session.add_all([
                LibraryTrack(id=5, file_path=str(retained)),
                LibraryTrack(id=9, file_path=str(removed)),
            ])
            session.commit()
        database.Base.metadata.create_all(engine)

        manager = LibraryManager()
        first = manager.scan_library()
        assert {track["file_path"]: track["id"] for track in first} == {str(retained): 5, str(removed): 9}
        removed.unlink()
        assert [track["id"] for track in manager.scan_library()] == [5]
        assert manager.get_track_by_id(9) is None

        replacement.touch()
        restarted = LibraryManager()
        assert {track["file_path"]: track["id"] for track in restarted.scan_library()} == {
            str(retained): 5,
            str(replacement): 10,
        }
        assert restarted.get_track_by_id(9) is None
    finally:
        engine.dispose()


def test_library_indexes_untagged_and_unreadable_audio_without_touching_the_files(monkeypatch, tmp_path):
    import wave
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    import database

    music = tmp_path / "music"
    music.mkdir()
    untagged = music / "Untagged recording.WAV"
    with wave.open(str(untagged), "wb") as audio:
        audio.setparams((1, 2, 8000, 0, "NONE", "not compressed"))
        audio.writeframes(b"\x00\x00" * 16_000)
    (music / "Missing audio.flac").write_bytes(b"invalid FLAC")
    (music / "Leftover.m4a").write_bytes(b"invalid MP4")
    (music / "Unidentified.opus").write_bytes(b"invalid Opus")
    (music / "cover.jpg").write_bytes(b"sidecar cover")
    original = {file.name: file.read_bytes() for file in music.iterdir()}
    monkeypatch.setattr(library_manager, "get_settings", lambda: {"downloads_path": str(music)})
    monkeypatch.setattr(library_manager, "_ART_DIR", str(tmp_path / "cache"))
    engine = create_engine(f"sqlite:///{tmp_path / 'index.db'}")
    monkeypatch.setattr(database, "SessionLocal", sessionmaker(bind=engine))
    try:
        database.Base.metadata.create_all(engine)
        scanned = {track["title"]: track for track in LibraryManager().scan_library()}
        assert set(scanned) == {"Untagged recording", "Missing audio", "Leftover", "Unidentified"}
        assert scanned["Untagged recording"]["format"] == "wav"
        assert scanned["Untagged recording"]["duration"] == 2
        assert scanned["Missing audio"]["duration"] == 0
        assert scanned["Missing audio"]["artist"] == "Unknown Artist"
        assert scanned["Missing audio"]["artwork_revision"] is None
        assert not scanned["Untagged recording"]["has_art"]
        reloaded = LibraryManager()
        assert {track["id"] for track in reloaded.get_all_tracks()} == {track["id"] for track in scanned.values()}
        assert reloaded.search("Missing audio.flac")[0]["title"] == "Missing audio"
    finally:
        engine.dispose()
    assert original == {file.name: file.read_bytes() for file in music.iterdir()}


def test_track_art_cache_keeps_distinct_covers_in_one_folder(monkeypatch, tmp_path):
    monkeypatch.setattr(library_manager, "_ART_DIR", str(tmp_path / "art"))
    manager = LibraryManager()

    class Audio:
        def __init__(self, cover):
            self.pictures = [type("Picture", (), {"data": cover})()]

    folder = tmp_path / "Essentials"
    folder.mkdir()
    first_file = folder / "01. Cornfield Chase.flac"
    second_file = folder / "02. F1.flac"
    first_file.touch()
    second_file.touch()
    first, second = str(first_file), str(second_file)
    first_art = manager._cache_art(first, Audio(b"cornfield-cover"))
    second_art = manager._cache_art(second, Audio(b"f1-cover"))

    assert first_art != second_art
    assert manager.get_art_path({"file_path": first}) == first_art
    assert manager.get_art_path({"file_path": second}) == second_art
    assert open(first_art, "rb").read() == b"cornfield-cover"
    assert open(second_art, "rb").read() == b"f1-cover"


def test_replacing_track_at_same_path_never_reuses_its_old_cover(monkeypatch, tmp_path):
    from types import SimpleNamespace

    monkeypatch.setattr(library_manager, "_ART_DIR", str(tmp_path / "art"))
    manager = LibraryManager()
    source = tmp_path / "Track.flac"
    source.write_bytes(b"previous audio")
    track = {"file_path": str(source)}
    previous_revision = manager.artwork_revision(str(source))
    manager._cache_art(str(source), SimpleNamespace(pictures=[SimpleNamespace(type=3, data=b"old cover")]))

    source.write_bytes(b"replacement audio with artwork")
    monkeypatch.setattr(library_manager.mutagen, "File", lambda _: SimpleNamespace(pictures=[
        SimpleNamespace(type=4, data=b"back cover"),
        SimpleNamespace(type=3, data=b"current front cover"),
    ]))
    assert manager.get_art_path(track, previous_revision) is None
    current = manager.get_art_path(track, manager.artwork_revision(str(source)))
    assert current is not None
    with open(current, "rb") as cover:
        assert cover.read() == b"current front cover"

    source.write_bytes(b"new audio without any artwork")
    monkeypatch.setattr(library_manager.mutagen, "File", lambda _: SimpleNamespace(pictures=[], tags={}))
    assert manager.get_art_path(track) is None
