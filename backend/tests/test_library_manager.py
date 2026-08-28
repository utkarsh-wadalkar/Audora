"""Regression tests for filesystem-backed library grouping."""
import os
import sys

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


def test_album_folder_is_one_group_even_with_multiple_contributing_artists():
    """Changing a track artist must not split its filesystem album folder."""
    manager = LibraryManager()
    manager._tracks = [
        _track(
            r"D:\Music\Post Malone Essentials\01. Circles.flac",
            "Circles",
            "Post Malone",
            "Post Malone Essentials",
        ),
        _track(
            r"D:\Music\Post Malone Essentials\02. Sunflower.flac",
            "Sunflower",
            "Post Malone & Swae Lee",
            "Post Malone Essentials",
        ),
        _track(
            r"D:\Music\Selena Gomez Essentials\01. Lose You to Love Me.flac",
            "Lose You to Love Me",
            "Selena Gomez",
            "Selena Gomez Essentials",
        ),
        _track(
            r"D:\Music\Selena Gomez Essentials\02. Calm Down.flac",
            "Calm Down",
            "Rema & Selena Gomez",
            "Selena Gomez Essentials",
        ),
    ]

    albums = manager.get_albums()

    assert [album["album"] for album in albums] == [
        "Post Malone Essentials",
        "Selena Gomez Essentials",
    ]
    assert [len(album["tracks"]) for album in albums] == [2, 2]


def test_album_folders_use_natural_filesystem_name_order():
    """A lexical sort must not place a folder named Album 10 before Album 2."""
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

    configured["downloads_path"] = str(second_root)

    assert [track["file_path"] for track in manager.scan_library()] == [
        str(second_track)
    ]
    assert manager.get_albums()[0]["album"] == "Album B"
