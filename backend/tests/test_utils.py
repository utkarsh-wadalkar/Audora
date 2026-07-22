"""Unit tests for utils.py — URL validation, path conversion, redaction, formatting."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from utils import (  # noqa: E402
    validate_apple_music_url,
    url_kind,
    windows_to_docker_path,
    redact_credentials,
    format_size,
    format_duration,
)


def test_valid_album_url():
    assert validate_apple_music_url(
        "https://music.apple.com/us/album/some-album/1234567890"
    )


def test_valid_playlist_url():
    assert validate_apple_music_url(
        "https://music.apple.com/us/playlist/name/pl.u-abc123"
    )


def test_invalid_urls():
    assert not validate_apple_music_url("https://spotify.com/album/x")
    assert not validate_apple_music_url("not a url")
    assert not validate_apple_music_url("")
    assert not validate_apple_music_url(None)  # type: ignore


def test_url_kind():
    assert url_kind("https://music.apple.com/us/song/x/1") == "song"
    assert url_kind("https://music.apple.com/us/artist/x/1") == "artist"
    assert url_kind("https://example.com/x") == "unknown"


def test_windows_to_docker_path():
    assert windows_to_docker_path("D:\\a\\b") == "D:/a/b"
    assert windows_to_docker_path("") == ""


def test_redact_credentials():
    assert "secret" not in redact_credentials("-L user@x.com:secret -H 0.0.0.0")
    assert "<redacted>" in redact_credentials("-L user@x.com:secret")
    assert "hunter2" not in redact_credentials("password=hunter2")


def test_format_size():
    assert format_size(0) == "0 B"
    assert format_size(2048).endswith("KB")
    assert format_size(5 * 1024 ** 2).endswith("MB")
    assert format_size(3 * 1024 ** 3).endswith("GB")


def test_format_duration():
    assert format_duration(0) == "0:00"
    assert format_duration(65) == "1:05"
    assert format_duration(600) == "10:00"
