"""Library-only metadata features keyed by stable on-disk track paths."""

import os
import re

import mutagen


def select_smart_tracks(tracks, rule, favorites):
    artist = rule.artist_contains.casefold().strip()
    album = rule.album_contains.casefold().strip()
    return [track for track in tracks
            if (not artist or artist in (track.get("artist") or "").casefold())
            and (not album or album in (track.get("album") or "").casefold())
            and (not rule.favorites_only or track["file_path"] in favorites)]


def read_lyrics(path):
    """Read lyrics distributed with a local track, without querying third parties."""
    stem, _ = os.path.splitext(path)
    for extension in (".lrc", ".txt"):
        candidate = stem + extension
        if os.path.isfile(candidate):
            with open(candidate, "r", encoding="utf-8-sig", errors="replace") as handle:
                return {"text": handle.read(256_000), "synced": extension == ".lrc"}
    audio = mutagen.File(path)
    tags = getattr(audio, "tags", None)
    if tags:
        for key in ("LYRICS", "UNSYNCEDLYRICS", "lyrics", "unsyncedlyrics", "\xa9lyr"):
            value = tags.get(key)
            if value:
                text = str(value[0] if isinstance(value, list) else value)
                return {"text": text, "synced": bool(re.search(r"\[\d+:\d+(?:\.\d+)?\]", text))}
        # Vorbis comments can carry vendor-specific casing.
        for key in tags:
            if re.fullmatch(r"(?:unsynced)?lyrics", str(key), re.IGNORECASE):
                value = tags[key]
                text = str(value[0] if isinstance(value, list) else value)
                return {"text": text, "synced": bool(re.search(r"\[\d+:\d+(?:\.\d+)?\]", text))}
    return {"text": "", "synced": False}
