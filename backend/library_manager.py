"""Scan the downloads folder, extract M4A metadata, persist to SQLite,
and cache album art as PNG.
"""
import hashlib
import os
from typing import Dict, List, Optional

from mutagen.mp4 import MP4

from settings import get_settings
from logger import get_logger

logger = get_logger("library")

_BASE_DIR = os.path.dirname(os.path.abspath(__file__))
_ART_DIR = os.path.join(_BASE_DIR, "data", "album_art")


class LibraryManager:
    def __init__(self) -> None:
        self._tracks: List[Dict] = []

    # --- Scanning ---
    def scan_library(self) -> List[Dict]:
        settings = get_settings()
        downloads = settings.get("downloads_path")
        tracks: List[Dict] = []

        if not downloads or not os.path.isdir(downloads):
            logger.warning(f"Downloads path does not exist: {downloads}")
            self._tracks = []
            self._persist([])
            return []

        os.makedirs(_ART_DIR, exist_ok=True)

        for root, _dirs, files in os.walk(downloads):
            for f in files:
                if f.lower().endswith(".m4a"):
                    path = os.path.join(root, f)
                    try:
                        tracks.append(self._extract_metadata(path))
                    except Exception as e:
                        logger.warning(f"Failed to read metadata for {path}: {e}")

        self._tracks = tracks
        self._persist(tracks)
        logger.info(f"Library scan complete: {len(tracks)} tracks")
        return tracks

    def _extract_metadata(self, path: str) -> Dict:
        audio = MP4(path)
        tags = audio.tags or {}

        def first(key: str, default: str) -> str:
            val = tags.get(key)
            if val and len(val) > 0:
                return str(val[0])
            return default

        title = first("\xa9nam", os.path.splitext(os.path.basename(path))[0])
        artist = first("\xa9ART", "Unknown Artist")
        album = first("\xa9alb", "Unknown Album")

        duration = int(audio.info.length) if audio.info else 0
        size = os.path.getsize(path)

        art_path = self._cache_art(path, tags)

        return {
            "file_path": path,
            "title": title,
            "artist": artist,
            "album": album,
            "duration": duration,
            "file_size": size,
            "format": "m4a",
            "has_art": bool(art_path),
        }

    def _art_key(self, track_path: str) -> str:
        """Stable hash of the track's directory (survives process restarts)."""
        folder = os.path.dirname(track_path).encode("utf-8", errors="replace")
        return hashlib.md5(folder).hexdigest()

    def _cache_art(self, track_path: str, tags) -> Optional[str]:
        covers = tags.get("covr") if tags else None
        if not covers:
            return None
        try:
            data = bytes(covers[0])
            # Tracks in the same folder (same album) share one art file.
            key = self._art_key(track_path)
            out = os.path.join(_ART_DIR, f"{key}.png")
            if not os.path.exists(out):
                with open(out, "wb") as fh:
                    fh.write(data)
            return out
        except Exception as e:
            logger.debug(f"art cache failed for {track_path}: {e}")
            return None

    # --- Persistence ---
    def _persist(self, tracks: List[Dict]) -> None:
        """Replace library_tracks rows with the freshly scanned set."""
        from datetime import datetime

        from database import SessionLocal
        from models import LibraryTrack

        db = SessionLocal()
        try:
            db.query(LibraryTrack).delete()
            now = datetime.utcnow()
            for t in tracks:
                db.add(
                    LibraryTrack(
                        file_path=t["file_path"],
                        title=t.get("title"),
                        artist=t.get("artist"),
                        album=t.get("album"),
                        duration=t.get("duration", 0),
                        file_size=t.get("file_size", 0),
                        format=t.get("format", "m4a"),
                        last_scanned=now,
                    )
                )
            db.commit()
        except Exception as e:
            db.rollback()
            logger.warning(f"Failed to persist library: {e}")
        finally:
            db.close()

    # --- Queries ---
    def get_all_tracks(self) -> List[Dict]:
        if self._tracks:
            return self._tracks
        # Fall back to the DB (e.g. after a restart without a rescan yet).
        return self._load_from_db()

    def _load_from_db(self) -> List[Dict]:
        from database import SessionLocal
        from models import LibraryTrack

        db = SessionLocal()
        try:
            rows = db.query(LibraryTrack).all()
            self._tracks = [
                {
                    "id": r.id,
                    "file_path": r.file_path,
                    "title": r.title,
                    "artist": r.artist,
                    "album": r.album,
                    "duration": r.duration,
                    "file_size": r.file_size,
                    "format": r.format,
                }
                for r in rows
            ]
            return self._tracks
        finally:
            db.close()

    def get_track_by_id(self, track_id: int) -> Optional[Dict]:
        for t in self.get_all_tracks():
            if t.get("id") == track_id:
                return t
        return None

    def get_art_path(self, track: Dict) -> Optional[str]:
        """Return the cached album-art PNG path for a track, if it exists."""
        if not track or not track.get("file_path"):
            return None
        key = self._art_key(track["file_path"])
        candidate = os.path.join(_ART_DIR, f"{key}.png")
        return candidate if os.path.exists(candidate) else None

    def get_artists(self) -> List[str]:
        return sorted({t["artist"] for t in self.get_all_tracks() if t.get("artist")})

    def get_albums(self) -> List[Dict]:
        albums: Dict = {}
        for t in self.get_all_tracks():
            key = (t.get("artist"), t.get("album"))
            if key not in albums:
                albums[key] = {
                    "artist": t.get("artist"),
                    "album": t.get("album"),
                    "tracks": [],
                }
            albums[key]["tracks"].append(t)
        return list(albums.values())

    def search(self, query: str) -> List[Dict]:
        q = (query or "").lower().strip()
        if not q:
            return self.get_all_tracks()
        return [
            t
            for t in self.get_all_tracks()
            if q in (t.get("title") or "").lower()
            or q in (t.get("artist") or "").lower()
            or q in (t.get("album") or "").lower()
        ]


lib_mgr = LibraryManager()
