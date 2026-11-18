"""Resolve playlist file references against the current library scan."""
import os

from sqlalchemy.orm import Session

from models import Playlist, PlaylistEntry


def playlist_data(db: Session, playlist: Playlist, library_tracks: list[dict]) -> dict:
    tracks_by_path = {track["file_path"]: track for track in library_tracks}
    entries = db.query(PlaylistEntry).filter_by(playlist_id=playlist.id).order_by(
        PlaylistEntry.position, PlaylistEntry.id
    ).all()
    return {
        "id": playlist.id,
        "name": playlist.name,
        "tracks": [
            {"entry_id": entry.id, "file_path": entry.file_path,
             "track": tracks_by_path.get(entry.file_path) if os.path.isfile(entry.file_path) else None}
            for entry in entries
        ],
    }
