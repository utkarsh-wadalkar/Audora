"""Scan the downloads folder, extract FLAC metadata, persist to SQLite,
and cache album art.

FLAC is the canonical playable format. Audora downloads the lossless ALAC
source and converts it to FLAC (see ``flac_converter``) before a track is
reported as ready, because Chromium — and therefore Electron — has no ALAC
decoder: an ``.m4a`` would be listed here and then silently fail to play. So
only ``.flac`` is scanned, and a leftover ``.m4a`` is deliberately ignored
rather than surfaced as a track the player cannot open.
"""
import hashlib
import os
import re
from typing import Dict, List, Optional

import mutagen

from settings import get_settings
from logger import get_logger
from runtime_platform import get_data_dir

logger = get_logger("library")

_ART_DIR = os.path.join(str(get_data_dir()), "album_art")

TRACK_EXTENSION = ".flac"
TRACK_FORMAT = "flac"

# Vorbis-comment keys (FLAC) and their MP4-atom equivalents. Both are read so a
# track keeps its tags if it ever arrives in a different container.
_TITLE_KEYS = ("title", "\xa9nam")
_ARTIST_KEYS = ("artist", "\xa9ART")
_ALBUM_KEYS = ("album", "\xa9alb")


def _natural_name_key(value: str):
    """Case-insensitive filename ordering with numeric chunks as numbers."""
    return tuple(
        (0, int(part)) if part.isdigit() else (1, part.casefold())
        for part in re.split(r"(\d+)", value)
    )


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
            for filename in files:
                if filename.lower().endswith(TRACK_EXTENSION):
                    path = os.path.join(root, filename)
                    try:
                        tracks.append(self._extract_metadata(path))
                    except Exception as metadata_error:
                        logger.warning(f"Failed to read metadata for {path}: {metadata_error}")

        self._tracks = tracks
        self._persist(tracks)
        logger.info(f"Library scan complete: {len(tracks)} tracks")
        return tracks

    def _extract_metadata(self, path: str) -> Dict:
        audio = mutagen.File(path)
        if audio is None:
            raise ValueError(f"Unrecognised audio file: {path}")
        tags = audio.tags or {}

        def first_tag(keys, default: str) -> str:
            """First present value among ``keys``.

            Vorbis comments and MP4 atoms both return lists, but a Vorbis
            value is a plain str while an MP4 atom may be bytes, so the value is
            normalised rather than assumed.
            """
            for key in keys:
                value = tags.get(key)
                if value:
                    entry = value[0] if isinstance(value, list) else value
                    if isinstance(entry, bytes):
                        return entry.decode("utf-8", errors="replace")
                    return str(entry)
            return default

        title = first_tag(_TITLE_KEYS, os.path.splitext(os.path.basename(path))[0])
        artist = first_tag(_ARTIST_KEYS, "Unknown Artist")
        album = first_tag(_ALBUM_KEYS, "Unknown Album")

        duration = int(audio.info.length) if audio.info else 0
        size = os.path.getsize(path)

        art_path = self._cache_art(path, audio)

        return {
            "file_path": path,
            "title": title,
            "artist": artist,
            "album": album,
            "duration": duration,
            "file_size": size,
            "format": TRACK_FORMAT,
            "has_art": bool(art_path),
        }

    def _art_key(self, track_path: str) -> str:
        """Stable hash of the track's directory (survives process restarts)."""
        folder = os.path.dirname(track_path).encode("utf-8", errors="replace")
        return hashlib.md5(folder).hexdigest()

    def _cache_art(self, track_path: str, audio) -> Optional[str]:
        """Cache the track's embedded cover art, one file per album folder.

        FLAC stores artwork in PICTURE metadata blocks (``FLAC.pictures``),
        which is a different API from the MP4 ``covr`` atom — both are handled
        so the art survives whichever container a file arrives in.

        The cached file keeps a ``.png`` extension for compatibility with
        ``get_art_path``, which recomputes the same name. The bytes are usually
        JPEG (the downloader is configured with ``cover-format: jpg``); the art
        endpoint sniffs the real type rather than trusting the extension.
        """
        data = self._extract_cover_bytes(audio)
        if not data:
            return None
        try:
            # Ensure the cache dir here rather than relying on scan_library
            # having made it: _extract_metadata is also called directly, and a
            # missing dir silently cost every track its artwork.
            os.makedirs(_ART_DIR, exist_ok=True)
            # Tracks in the same folder (same album) share one art file.
            key = self._art_key(track_path)
            out = os.path.join(_ART_DIR, f"{key}.png")
            if not os.path.exists(out):
                with open(out, "wb") as handle:
                    handle.write(data)
            return out
        except Exception as art_error:
            logger.debug(f"art cache failed for {track_path}: {art_error}")
            return None

    @staticmethod
    def _extract_cover_bytes(audio) -> Optional[bytes]:
        """Embedded cover bytes from a FLAC PICTURE block or an MP4 covr atom."""
        pictures = getattr(audio, "pictures", None)
        if pictures:
            return bytes(pictures[0].data)

        tags = audio.tags or {}
        covers = tags.get("covr") if hasattr(tags, "get") else None
        if covers:
            return bytes(covers[0])
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
            for track in tracks:
                row = LibraryTrack(
                    file_path=track["file_path"],
                    title=track.get("title"),
                    artist=track.get("artist"),
                    album=track.get("album"),
                    duration=track.get("duration", 0),
                    file_size=track.get("file_size", 0),
                    format=track.get("format", TRACK_FORMAT),
                    last_scanned=now,
                )
                db.add(row)
                # The scan response is used immediately by the UI. Populate
                # the generated ID now so those tracks have valid stream/art
                # URLs without requiring an application restart.
                db.flush()
                track["id"] = row.id
            db.commit()
        except Exception as persist_error:
            db.rollback()
            logger.warning(f"Failed to persist library: {persist_error}")
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
                    "id": row.id,
                    "file_path": row.file_path,
                    "title": row.title,
                    "artist": row.artist,
                    "album": row.album,
                    "duration": row.duration,
                    "file_size": row.file_size,
                    "format": row.format,
                }
                for row in rows
            ]
            return self._tracks
        finally:
            db.close()

    def get_track_by_id(self, track_id: int) -> Optional[Dict]:
        for track in self.get_all_tracks():
            if track.get("id") == track_id:
                return track
        return None

    def get_art_path(self, track: Dict) -> Optional[str]:
        """Return the cached album-art path for a track, if it exists."""
        if not track or not track.get("file_path"):
            return None
        key = self._art_key(track["file_path"])
        candidate = os.path.join(_ART_DIR, f"{key}.png")
        return candidate if os.path.exists(candidate) else None

    def get_artists(self) -> List[str]:
        return sorted({track["artist"] for track in self.get_all_tracks() if track.get("artist")})

    def get_albums(self) -> List[Dict]:
        albums: Dict = {}
        for track in self.get_all_tracks():
            # The downloader stores every album in its own directory. That
            # directory is the stable album identity; per-track ``artist``
            # tags are contributing artists and legitimately vary for
            # collaborations within the same album.
            file_path = os.path.normpath(track.get("file_path") or "")
            folder_path = os.path.dirname(file_path)
            key = os.path.normcase(folder_path)
            album_name = os.path.basename(folder_path) or track.get("album") or "Unknown Album"

            # A malformed path should not collapse every such track into one
            # empty-key group. Metadata is only a last-resort identity here.
            if not key:
                key = f"metadata::{str(album_name).casefold()}"
            if key not in albums:
                albums[key] = {
                    "folder_path": folder_path,
                    "artist": track.get("artist"),
                    "album": album_name,
                    "tracks": [],
                }
            albums[key]["tracks"].append(track)
        return sorted(
            albums.values(),
            key=lambda album: _natural_name_key(str(album.get("album") or "")),
        )

    def search(self, query: str) -> List[Dict]:
        normalised_query = (query or "").lower().strip()
        if not normalised_query:
            return self.get_all_tracks()
        return [
            track
            for track in self.get_all_tracks()
            if normalised_query in (track.get("title") or "").lower()
            or normalised_query in (track.get("artist") or "").lower()
            or normalised_query in (track.get("album") or "").lower()
        ]


lib_mgr = LibraryManager()
