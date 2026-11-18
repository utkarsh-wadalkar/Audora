"""User playlists store stable paths, never copies of downloaded audio."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import create_engine  # noqa: E402
from sqlalchemy.orm import Session  # noqa: E402

from database import Base  # noqa: E402
from models import Playlist, PlaylistEntry  # noqa: E402
from playlists import playlist_data  # noqa: E402


def test_playlist_keeps_file_reference_across_library_rescan(tmp_path):
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    song = tmp_path / "Song.flac"
    song.write_bytes(b"music")
    library = [{"id": 1, "file_path": str(song), "title": "Song"}]
    with Session(engine) as db:
        playlist = Playlist(name="Favorites")
        db.add(playlist)
        db.flush()
        db.add(PlaylistEntry(playlist_id=playlist.id, file_path=str(song), position=1))
        db.commit()
        result = playlist_data(db, playlist, library)
        assert result["tracks"][0]["file_path"] == str(song)
        assert result["tracks"][0]["track"]["id"] == 1
        library[:] = [{"id": 8, "file_path": str(song), "title": "Song"}]
        assert playlist_data(db, playlist, library)["tracks"][0]["track"]["id"] == 8
        assert playlist_data(db, playlist, [])["tracks"][0]["track"] is None

    assert song.read_bytes() == b"music"
    assert list(tmp_path.iterdir()) == [song]
