"""Index local audio files and enrich each entry with any readable tags."""
import base64
import hashlib
import json
import os
import re
from tempfile import NamedTemporaryFile
from threading import Lock
from typing import Dict, List, Optional

import mutagen
from mutagen.flac import Picture
from mutagen.id3 import PictureType

from settings import get_settings
from logger import get_logger
from runtime_platform import get_data_dir

logger = get_logger("library")

_ART_DIR = os.path.join(str(get_data_dir()), "album_art")

TRACK_FORMAT = "flac"
AUDIO_MIME_TYPES = {
    ".aac": "audio/aac",
    ".ac3": "audio/ac3",
    ".aif": "audio/aiff",
    ".aifc": "audio/aiff",
    ".aiff": "audio/aiff",
    ".alac": "audio/mp4",
    ".ape": "audio/ape",
    ".flac": "audio/flac",
    ".m4a": "audio/mp4",
    ".m4b": "audio/mp4",
    ".mka": "audio/x-matroska",
    ".mp2": "audio/mpeg",
    ".mp3": "audio/mpeg",
    ".oga": "audio/ogg",
    ".ogg": "audio/ogg",
    ".opus": "audio/ogg",
    ".wav": "audio/wav",
    ".wave": "audio/wav",
    ".webm": "audio/webm",
    ".wma": "audio/x-ms-wma",
    ".wv": "audio/wavpack",
}

# Vorbis-comment keys (FLAC) and their MP4-atom equivalents. Both are read so a
# track keeps its tags if it ever arrives in a different container.
_TITLE_KEYS = ("title", "\xa9nam", "TIT2", "Title")
_ARTIST_KEYS = ("artist", "\xa9ART", "TPE1", "Author")
_ALBUM_KEYS = ("album", "\xa9alb", "TALB", "WM/AlbumTitle")
_ALBUM_ARTIST_KEYS = ("albumartist", "album artist", "aART", "TPE2", "WM/AlbumArtist")


def _natural_name_key(value: str):
    """Case-insensitive filename ordering with numeric chunks as numbers."""
    return tuple(
        (0, int(part)) if part.isdigit() else (1, part.casefold())
        for part in re.split(r"(\d+)", value)
    )


class LibraryFolderUnavailable(OSError):
    pass


class LibraryManager:
    def __init__(self) -> None:
        self._tracks: Optional[List[Dict]] = None
        self._scan_lock = Lock()

    # --- Scanning ---
    def scan_library(self, local_folder: Optional[str] = None) -> List[Dict]:
        with self._scan_lock:
            return self._scan_library(local_folder)

    def _scan_library(self, local_folder: Optional[str]) -> List[Dict]:
        settings = get_settings()
        directory = local_folder or settings.get("library_path") or settings.get("downloads_path")
        if not directory:
            raise LibraryFolderUnavailable("Choose a music folder in Settings, then select Rescan.")

        def handle_walk_error(error: OSError) -> None:
            if error.filename == directory:
                raise LibraryFolderUnavailable(
                    f"Audora couldn’t open {directory}. Reconnect the drive or choose another music folder in Settings, then rescan."
                ) from error
            logger.warning("Skipped an unreadable folder during the library scan: %s", error.filename)

        tracks: List[Dict] = []
        without_details = 0
        for root, _dirs, files in os.walk(directory, onerror=handle_walk_error):
            for filename in files:
                if os.path.splitext(filename)[1].lower() not in AUDIO_MIME_TYPES:
                    continue
                path = os.path.join(root, filename)
                try:
                    track = self._extract_metadata(path)
                except FileNotFoundError:
                    continue  # The file was removed after os.walk listed it.
                except Exception as metadata_error:
                    logger.debug(f"Failed to read audio details for {path}: {metadata_error}")
                    track = self._track_from_path(path)
                    without_details += 1
                tracks.append(track)

        self._persist(tracks)
        self._tracks = tracks
        logger.info(f"Library scan complete: {len(tracks)} tracks, {without_details} without readable audio details")
        return tracks

    def _track_from_path(self, path: str, source_stat=None) -> Dict:
        if source_stat is None:
            try:
                source_stat = os.stat(path)
            except OSError:
                pass
        filename, extension = os.path.splitext(os.path.basename(path))
        return {
            "file_path": path,
            "title": filename,
            "artist": "Unknown Artist",
            "album": "Unknown Album",
            "duration": 0,
            "file_size": source_stat.st_size if source_stat else 0,
            "format": extension.lstrip(".").lower(),
            "has_art": False,
            "artwork_revision": None,
        }

    def _extract_metadata(self, path: str) -> Dict:
        source_stat = os.stat(path)
        revision = self.artwork_revision(path, source_stat)
        audio = mutagen.File(path)
        if audio is None:
            raise ValueError(f"Unrecognised audio file: {path}")
        tags = getattr(audio, "tags", None) or {}

        def first_tag(keys, default=None):
            """First present value among ``keys``.

            Vorbis comments and MP4 atoms both return lists, but a Vorbis
            value is a plain str while an MP4 atom may be bytes, so the value is
            normalised rather than assumed.
            """
            for key in keys:
                value = tags.get(key)
                if value:
                    values = getattr(value, "text", value)
                    if not values:
                        continue
                    entry = values[0] if isinstance(values, list) else values
                    if isinstance(entry, bytes):
                        entry = entry.decode("utf-8", errors="replace")
                    if str(entry).strip():
                        return str(entry).strip()
            return default

        track = self._track_from_path(path, source_stat)
        track.update(
            title=first_tag(_TITLE_KEYS, track["title"]),
            artist=first_tag(_ARTIST_KEYS, track["artist"]),
            album=first_tag(_ALBUM_KEYS, track["album"]),
            album_artist=first_tag(_ALBUM_ARTIST_KEYS),
            duration=int(getattr(getattr(audio, "info", None), "length", 0) or 0),
        )
        art_path = self._cache_art(path, audio, revision)
        track.update(has_art=bool(art_path), artwork_revision=revision if art_path else None)
        return track

    @staticmethod
    def artwork_revision(track_path: str, source_stat=None) -> Optional[str]:
        """Bind cover URLs to a file and its revision, independent of SQLite IDs."""
        try:
            info = source_stat if source_stat is not None else os.stat(track_path)
        except OSError:
            return None
        path = os.path.normcase(os.path.abspath(track_path))
        identity = (path, info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
        return hashlib.sha256(repr(identity).encode("utf-8", errors="surrogatepass")).hexdigest()

    def _cache_art(self, track_path: str, audio, revision: Optional[str] = None) -> Optional[str]:
        revision = revision or self.artwork_revision(track_path)
        if not revision:
            return None
        out = os.path.join(_ART_DIR, f"{revision}.cover")
        temporary = None
        try:
            data = self._extract_cover_bytes(audio)
            if not data:
                if os.path.isfile(out):
                    os.remove(out)
                return None
            if os.path.isfile(out):
                with open(out, "rb") as existing:
                    if existing.read() == data:
                        return out
            os.makedirs(_ART_DIR, exist_ok=True)
            with NamedTemporaryFile(dir=_ART_DIR, delete=False) as handle:
                temporary = handle.name
                handle.write(data)
            os.replace(temporary, out)
            return out
        except (OSError, ValueError, TypeError, mutagen.MutagenError) as art_error:
            logger.debug(f"Art cache failed for {track_path}: {art_error}")
            return None
        finally:
            if temporary and os.path.exists(temporary):
                try:
                    os.remove(temporary)
                except OSError:
                    logger.debug("Could not remove temporary artwork cache file")

    @staticmethod
    def _extract_cover_bytes(audio) -> Optional[bytes]:
        """Embedded artwork from FLAC, MP4, ID3, or Vorbis comments."""
        tags = getattr(audio, "tags", None) or {}
        pictures = list(getattr(audio, "pictures", None) or [])
        if hasattr(tags, "getall"):
            pictures.extend(tags.getall("APIC"))
        for image in tags.get("metadata_block_picture", []):
            try:
                pictures.append(Picture(base64.b64decode(image, validate=True)))
            except (ValueError, mutagen.MutagenError):
                continue
        for picture_type in (PictureType.COVER_FRONT, PictureType.OTHER):
            for picture in pictures:
                if getattr(picture, "type", PictureType.OTHER) == picture_type and picture.data:
                    return bytes(picture.data)

        covers = tags.get("covr")
        if covers:
            return bytes(covers[0])
        return None

    # --- Persistence ---
    def _persist(self, tracks: List[Dict]) -> None:
        """Refresh metadata without reassigning an existing track ID to another file."""
        from datetime import datetime

        from sqlalchemy.dialects.sqlite import insert
        from database import SessionLocal
        from models import LibraryTrack, LibraryTrackSequence

        db = SessionLocal()
        try:
            # Acquire the SQLite write lock before reading the allocator and rows.
            # Existing installations seed it from their current track IDs below.
            db.execute(insert(LibraryTrackSequence).values(id=1, last_track_id=0).on_conflict_do_nothing())
            sequence = db.get(LibraryTrackSequence, 1)
            remaining = {row.file_path: row for row in db.query(LibraryTrack)}
            last_track_id = max(sequence.last_track_id, max((row.id for row in remaining.values()), default=0))
            now = datetime.utcnow()
            assignments = []
            for track in tracks:
                path = track["file_path"]
                row = remaining.pop(path, None)
                if row is None:
                    last_track_id += 1
                    row = LibraryTrack(id=last_track_id, file_path=path)
                    db.add(row)
                row.title = track.get("title")
                row.artist = track.get("artist")
                row.album = track.get("album")
                row.album_artist = track.get("album_artist")
                row.duration = track.get("duration", 0)
                row.file_size = track.get("file_size", 0)
                row.format = track.get("format", TRACK_FORMAT)
                row.last_scanned = now
                assignments.append((track, row.id))
            for row in remaining.values():
                db.delete(row)
            sequence.last_track_id = last_track_id
            db.commit()
            for track, track_id in assignments:
                track["id"] = track_id
        except Exception as persist_error:
            db.rollback()
            logger.warning(f"Failed to persist library: {persist_error}")
            raise
        finally:
            db.close()

    # --- Queries ---
    def get_all_tracks(self) -> List[Dict]:
        if self._tracks is not None:
            return self._tracks
        # Fall back to the DB (e.g. after a restart without a rescan yet).
        with self._scan_lock:
            return self._tracks if self._tracks is not None else self._load_from_db()

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
                    "album_artist": row.album_artist,
                    "duration": row.duration,
                    "file_size": row.file_size,
                    "format": row.format,
                    "artwork_revision": self.artwork_revision(row.file_path),
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

    def get_art_path(self, track: Dict, requested_revision: Optional[str] = None) -> Optional[str]:
        """Serve only the requested track revision and rebuild the cache on demand."""
        if not track or not track.get("file_path"):
            return None
        source = track["file_path"]
        revision = self.artwork_revision(source)
        if not revision or (requested_revision is not None and requested_revision != revision):
            return None
        candidate = os.path.join(_ART_DIR, f"{revision}.cover")
        if os.path.isfile(candidate):
            return candidate
        try:
            audio = mutagen.File(source)
            if audio is not None and self.artwork_revision(source) == revision:
                return self._cache_art(source, audio, revision)
        except (mutagen.MutagenError, OSError) as error:
            logger.debug(f"Could not read artwork from {source}: {error}")
        return None

    def get_artists(self) -> List[str]:
        return sorted({track["artist"] for track in self.get_all_tracks() if track.get("artist")})

    def get_albums(self) -> List[Dict]:
        albums: Dict = {}
        for track in self.get_all_tracks():
            album_name = (track.get("album") or "").strip()
            if not album_name or album_name.casefold() == "unknown album":
                continue
            artist = (track.get("album_artist") or track.get("artist") or "Unknown Artist").strip()
            key = json.dumps([album_name.casefold(), artist.casefold()], ensure_ascii=False)
            if key not in albums:
                albums[key] = {
                    "id": key,
                    "folder_path": os.path.dirname(track.get("file_path") or ""),
                    "artist": artist,
                    "album": album_name,
                    "tracks": [],
                }
            albums[key]["tracks"].append(track)
        return sorted(
            albums.values(),
            key=lambda album: (_natural_name_key(album["album"]), _natural_name_key(album["artist"])),
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
            or normalised_query in os.path.basename(track.get("file_path") or "").lower()
        ]


lib_mgr = LibraryManager()
