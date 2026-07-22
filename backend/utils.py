"""Small helpers: URL validation, path conversion, formatting, redaction."""
import re

# Apple Music URLs look like:
#   https://music.apple.com/us/album/name/12345
#   https://music.apple.com/us/playlist/name/pl.abc
#   https://music.apple.com/us/song/name/12345
#   https://music.apple.com/us/artist/name/12345
_APPLE_MUSIC_RE = re.compile(
    r"^https?://music\.apple\.com/[a-z]{2}/"
    r"(album|playlist|song|artist|music-video)/[^/]+/[A-Za-z0-9.\-_]+",
    re.IGNORECASE,
)

# Also accept the short/localized forms without an explicit region segment.
_APPLE_MUSIC_LOOSE_RE = re.compile(
    r"^https?://music\.apple\.com/.+/(album|playlist|song|artist|music-video)/",
    re.IGNORECASE,
)


def validate_apple_music_url(url: str) -> bool:
    if not url or not isinstance(url, str):
        return False
    url = url.strip()
    return bool(_APPLE_MUSIC_RE.match(url) or _APPLE_MUSIC_LOOSE_RE.match(url))


def url_kind(url: str) -> str:
    """Return album/playlist/song/artist/music-video, or 'unknown'."""
    m = re.search(
        r"/(album|playlist|song|artist|music-video)/", url or "", re.IGNORECASE
    )
    return m.group(1).lower() if m else "unknown"


def windows_to_docker_path(path: str) -> str:
    """Convert a Windows path to the form Docker Desktop bind mounts accept.

    ``D:\\apple-music-dl\\downloads`` -> ``/d/apple-music-dl/downloads`` is not
    needed for Docker Desktop on Windows (it accepts native paths), but the
    forward-slash form is safer for the SDK. We normalise backslashes and,
    for drive-letter paths, keep the native form which the Windows engine
    understands.
    """
    if not path:
        return path
    # Docker Desktop (WSL2 backend) accepts native Windows paths for -v.
    # Normalise separators to forward slashes; the engine handles the drive.
    return path.replace("\\", "/")


def redact_credentials(text: str) -> str:
    """Remove ``-L email:password`` style secrets before logging."""
    if not text:
        return text
    # -L user:pass  /  --login user:pass
    text = re.sub(
        r"(-L|--login)\s+\S+:\S+",
        r"\1 <redacted>",
        text,
    )
    # password=... in any form
    text = re.sub(
        r"(password[=:]\s*)\S+",
        r"\1<redacted>",
        text,
        flags=re.IGNORECASE,
    )
    return text


def format_size(num_bytes: int) -> str:
    if num_bytes < 1024:
        return f"{num_bytes} B"
    if num_bytes < 1024 ** 2:
        return f"{num_bytes / 1024:.1f} KB"
    if num_bytes < 1024 ** 3:
        return f"{num_bytes / 1024 ** 2:.1f} MB"
    return f"{num_bytes / 1024 ** 3:.2f} GB"


def format_duration(seconds: int) -> str:
    seconds = int(seconds or 0)
    minutes = seconds // 60
    secs = seconds % 60
    return f"{minutes}:{secs:02d}"
