"""Unit tests for progress.py — downloader log line parsing."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from progress import parse_line  # noqa: E402


def test_track_of():
    r = parse_line("Track 3 of 14")
    assert r["current_track"] == 3
    assert r["total_tracks"] == 14


def test_paren_ratio():
    r = parse_line("downloading (2/10) Some Song.m4a")
    assert r["current_track"] == 2
    assert r["total_tracks"] == 10
    assert "Some Song" in r["track_name"]


def test_downloading_name():
    r = parse_line("Downloading: Harvey Two-Face")
    assert r["track_name"] == "Harvey Two-Face"


def test_completed():
    r = parse_line("Completed: My Song")
    assert r["completed_delta"] == 1


def test_failed():
    r = parse_line("Failed: Broken Track")
    assert r["failed_delta"] == 1


def test_noise_returns_none():
    assert parse_line("random unrelated log line") is None
    assert parse_line("") is None
