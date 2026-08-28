"""Regression tests for mapping Apple Music URLs to downloader arguments."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from download_manager import DownloadManager  # noqa: E402


TRACK_URL = (
    "https://music.apple.com/in/album/right-now-na-na-na/1440742168?i=1440742169"
)
ALBUM_URL = "https://music.apple.com/in/album/freedom/1440742168"


def test_track_share_url_builds_single_song_command():
    """Missing --song is the exact regression that starts the whole album."""
    assert DownloadManager()._build_command(TRACK_URL) == ["--song", TRACK_URL]


def test_album_share_url_builds_album_command():
    assert DownloadManager()._build_command(ALBUM_URL) == [ALBUM_URL]


def test_download_command_trims_pasted_url_whitespace():
    assert DownloadManager()._build_command(f"  {TRACK_URL} \n") == [
        "--song",
        TRACK_URL,
    ]
