"""Parse apple-music-downloader (Go binary) stdout into progress events.

The downloader's exact format varies by version, so this uses tolerant
regexes and is easy to extend. Each parser returns a partial dict that the
download manager merges into the running progress state.

Observed / expected line shapes:
  "Track 3 of 14"                      -> current/total
  "Downloading: Harvey Two-Face"       -> track_name
  "Completed: Harvey Two-Face"         -> a track finished
  "Failed: Some Song"                  -> a track failed
  "downloading (3/14) Song Name.m4a"   -> current/total + name
"""
import re
from typing import Dict, Optional

_TRACK_OF = re.compile(r"track\s+(\d+)\s+of\s+(\d+)", re.IGNORECASE)
_PAREN_RATIO = re.compile(r"\((\d+)\s*/\s*(\d+)\)")
_DOWNLOADING = re.compile(r"downloading[:\s]+(.+)", re.IGNORECASE)
_COMPLETED = re.compile(r"(?:completed|downloaded|saved)[:\s]+(.+)", re.IGNORECASE)
_FAILED = re.compile(r"(?:failed|error)[:\s]+(.+)", re.IGNORECASE)


def parse_line(line: str) -> Optional[Dict]:
    """Return a partial progress dict for a single log line, or None.

    Keys that may appear: current_track, total_tracks, track_name,
    completed_delta (int), failed_delta (int).
    """
    if not line:
        return None

    result: Dict = {}

    m = _TRACK_OF.search(line)
    if m:
        result["current_track"] = int(m.group(1))
        result["total_tracks"] = int(m.group(2))

    if "current_track" not in result:
        m = _PAREN_RATIO.search(line)
        if m:
            result["current_track"] = int(m.group(1))
            result["total_tracks"] = int(m.group(2))

    m = _FAILED.search(line)
    if m:
        result["failed_delta"] = 1
        result["track_name"] = _clean(m.group(1))
        return result

    m = _COMPLETED.search(line)
    if m:
        result["completed_delta"] = 1
        result["track_name"] = _clean(m.group(1))
        return result

    m = _DOWNLOADING.search(line)
    if m:
        result["track_name"] = _clean(m.group(1))

    return result or None


def _clean(name: str) -> str:
    name = name.strip().strip('"').strip()
    # Drop a trailing extension / percentage noise if present. Both formats are
    # stripped: the downloader reports .m4a while it fetches the lossless
    # source, and .flac once Audora has converted it.
    name = re.sub(r"\s*\d{1,3}%\s*$", "", name)
    name = re.sub(r"\.(m4a|flac)$", "", name, flags=re.IGNORECASE)
    return name.strip()
