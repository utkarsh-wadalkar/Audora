"""ORM models — mirrors the schema in Audora.md Section 8."""
from datetime import datetime

from sqlalchemy import Column, DateTime, ForeignKey, Integer, String, UniqueConstraint, Boolean

from database import Base


class DownloadHistory(Base):
    __tablename__ = "download_history"

    id = Column(Integer, primary_key=True, autoincrement=True)
    url = Column(String, nullable=False)
    title = Column(String, nullable=True)
    status = Column(String, nullable=False, default="completed")  # completed/failed/cancelled
    track_count = Column(Integer, default=0)
    error_count = Column(Integer, default=0)
    created_at = Column(DateTime, default=datetime.utcnow)
    completed_at = Column(DateTime, nullable=True)


class QueueItem(Base):
    __tablename__ = "queue_items"

    id = Column(Integer, primary_key=True, autoincrement=True)
    url = Column(String, nullable=False)
    title = Column(String, nullable=True)
    status = Column(String, nullable=False, default="pending")  # pending/downloading/completed/failed
    position = Column(Integer, default=0)
    created_at = Column(DateTime, default=datetime.utcnow)


class LibraryTrack(Base):
    __tablename__ = "library_tracks"

    id = Column(Integer, primary_key=True, autoincrement=True)
    file_path = Column(String, nullable=False, unique=True)
    title = Column(String, nullable=True)
    artist = Column(String, nullable=True)
    album = Column(String, nullable=True)
    duration = Column(Integer, default=0)
    file_size = Column(Integer, default=0)
    format = Column(String, nullable=True)
    last_scanned = Column(DateTime, default=datetime.utcnow)


class Playlist(Base):
    __tablename__ = "playlists"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String, nullable=False, unique=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class PlaylistEntry(Base):
    __tablename__ = "playlist_entries"
    __table_args__ = (UniqueConstraint("playlist_id", "file_path"),)

    id = Column(Integer, primary_key=True, autoincrement=True)
    playlist_id = Column(Integer, ForeignKey("playlists.id", ondelete="CASCADE"), nullable=False, index=True)
    file_path = Column(String, nullable=False)
    position = Column(Integer, nullable=False)


class Favorite(Base):
    __tablename__ = "favorites"

    file_path = Column(String, primary_key=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class SmartPlaylist(Base):
    __tablename__ = "smart_playlists"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String, nullable=False, unique=True)
    artist_contains = Column(String, nullable=False, default="")
    album_contains = Column(String, nullable=False, default="")
    favorites_only = Column(Boolean, nullable=False, default=False)
    created_at = Column(DateTime, default=datetime.utcnow)
