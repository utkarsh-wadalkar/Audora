"""Favorites, rules, and lyric files follow library paths across rescans."""
import os
import sys
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from library_features import read_lyrics, select_smart_tracks  # noqa: E402
import library_features  # noqa: E402


def test_smart_playlist_uses_live_track_metadata_and_stable_favorites():
    tracks = [
        {"id": 1, "file_path": "A.flac", "artist": "The Weeknd", "album": "After Hours"},
        {"id": 2, "file_path": "B.flac", "artist": "The Weeknd", "album": "Dawn FM"},
    ]
    rule = SimpleNamespace(artist_contains="week", album_contains="after", favorites_only=True)
    assert select_smart_tracks(tracks, rule, {"A.flac"}) == tracks[:1]
    tracks[0]["id"] = 15  # scan changed the stream ID but not the file identity
    assert select_smart_tracks(tracks, rule, {"A.flac"})[0]["id"] == 15
    assert select_smart_tracks(tracks, rule, set()) == []


def test_lyrics_prefers_matching_lrc_and_does_not_modify_track(tmp_path):
    track = tmp_path / "Song.flac"
    track.write_bytes(b"not audio")
    (tmp_path / "Song.lrc").write_text("[00:01.00] First line", encoding="utf-8")
    (tmp_path / "Song.txt").write_text("Other lyrics", encoding="utf-8")
    assert read_lyrics(str(track)) == {"text": "[00:01.00] First line", "synced": True}
    assert track.read_bytes() == b"not audio"


def test_embedded_lyrics_are_available_without_sidecar(monkeypatch, tmp_path):
    track = tmp_path / "Embedded.flac"
    track.write_bytes(b"not audio")
    monkeypatch.setattr(library_features.mutagen, "File", lambda _: SimpleNamespace(tags={"LYRICS": ["First line\nSecond line"]}))
    assert read_lyrics(str(track)) == {"text": "First line\nSecond line", "synced": False}
    monkeypatch.setattr(library_features.mutagen, "File", lambda _: SimpleNamespace(tags={"LYRICS": ["[00:01.00]First line"]}))
    assert read_lyrics(str(track)) == {"text": "[00:01.00]First line", "synced": True}
