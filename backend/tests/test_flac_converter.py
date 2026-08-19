"""Tests for the ALAC -> FLAC conversion stage.

Why this stage exists at all: Chromium (and so Electron) has no ALAC decoder,
so the ``.m4a`` files the downloader produces are fetched successfully by the
player and then silently fail to decode — duration stays at zero and playback
never starts. Converting to FLAC, which Chromium does decode, is what makes
Audora's own player work.

The invariants pinned here are the ones that protect the user's data and stop
the UI lying about what happened:

* a source is deleted ONLY after its FLAC validates, so a failed conversion
  never destroys the lossless download,
* a truncated or non-FLAC output is rejected rather than trusted,
* a run with any conversion failure is NOT reported as ``completed``.

No Docker daemon is needed: the container run is faked.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import flac_converter  # noqa: E402

_FLAC_HEADER = b"fLaC"
# Comfortably above the converter's minimum-plausible-size floor.
_PLAUSIBLE_BODY = b"\x00" * 8192


def _write(path, data: bytes) -> str:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as handle:
        handle.write(data)
    return path


def _make_source(tmp_path, name="01. Track.m4a") -> str:
    return _write(str(tmp_path / "Album" / name), b"\x00\x00\x00\x1cftypM4A " + _PLAUSIBLE_BODY)


# ---------------------------------------------------------------------------
# Output validation
# ---------------------------------------------------------------------------

def test_valid_flac_is_accepted(tmp_path):
    path = _write(str(tmp_path / "ok.flac"), _FLAC_HEADER + _PLAUSIBLE_BODY)
    assert flac_converter.is_valid_flac(path) is True


def test_output_without_the_flac_marker_is_rejected(tmp_path):
    """ffmpeg can exit 0 having written something that is not FLAC."""
    path = _write(str(tmp_path / "bad.flac"), b"RIFF" + _PLAUSIBLE_BODY)
    assert flac_converter.is_valid_flac(path) is False


def test_truncated_output_is_rejected(tmp_path):
    """A few bytes with the right marker is still a broken file."""
    path = _write(str(tmp_path / "stub.flac"), _FLAC_HEADER)
    assert flac_converter.is_valid_flac(path) is False


def test_missing_output_is_rejected(tmp_path):
    assert flac_converter.is_valid_flac(str(tmp_path / "nope.flac")) is False


# ---------------------------------------------------------------------------
# Source discovery — by set difference, so unrelated files are never touched
# ---------------------------------------------------------------------------

def test_only_newly_downloaded_sources_are_converted(tmp_path):
    """Pre-existing ALAC must not be swept into a download's conversion."""
    pre_existing = _make_source(tmp_path, "old.m4a")
    before = flac_converter.snapshot_sources(str(tmp_path))

    fresh = _make_source(tmp_path, "new.m4a")
    discovered = flac_converter.find_new_sources(str(tmp_path), before)

    assert discovered == [os.path.abspath(fresh)]
    assert os.path.abspath(pre_existing) not in discovered


def test_target_path_keeps_the_stem_and_folder(tmp_path):
    source = _make_source(tmp_path, "05. Song.m4a")
    target = flac_converter.target_path_for(source)
    assert target.endswith(".flac")
    assert os.path.dirname(target) == os.path.dirname(source)
    assert os.path.basename(target) == "05. Song.flac"


# ---------------------------------------------------------------------------
# The delete-only-after-validation invariant
# ---------------------------------------------------------------------------

class _FakeClient:
    """Stands in for the Docker client, writing whatever ffmpeg 'produced'."""

    def __init__(self, produce):
        self._produce = produce
        self.containers = self

    def run(self, *_args, **kwargs):
        self._produce(kwargs)
        return b""


def _patch_client(monkeypatch, produce):
    monkeypatch.setattr(
        flac_converter.docker_mgr, "get_client", lambda: _FakeClient(produce)
    )


def test_source_is_deleted_after_a_valid_conversion(monkeypatch, tmp_path):
    source = _make_source(tmp_path)
    target = flac_converter.target_path_for(source)

    _patch_client(monkeypatch, lambda _kwargs: _write(target, _FLAC_HEADER + _PLAUSIBLE_BODY))

    assert flac_converter.convert_one(source, str(tmp_path)) is True
    assert os.path.exists(target)
    assert not os.path.exists(source), "lossless source should be reclaimed once FLAC is valid"


def test_source_survives_an_invalid_conversion(monkeypatch, tmp_path):
    """The critical safety property: never destroy the source on failure."""
    source = _make_source(tmp_path)
    target = flac_converter.target_path_for(source)

    _patch_client(monkeypatch, lambda _kwargs: _write(target, b"NOTFLAC" + _PLAUSIBLE_BODY))

    assert flac_converter.convert_one(source, str(tmp_path)) is False
    assert os.path.exists(source), "source must be kept so the user can retry"
    assert not os.path.exists(target), "invalid output should be discarded"


def test_source_survives_an_ffmpeg_crash(monkeypatch, tmp_path):
    source = _make_source(tmp_path)

    def explode(_kwargs):
        raise RuntimeError("ffmpeg exited 1")

    _patch_client(monkeypatch, explode)

    assert flac_converter.convert_one(source, str(tmp_path)) is False
    assert os.path.exists(source)


def test_conversion_runs_without_network_access(monkeypatch, tmp_path):
    """Conversion is local file work; it must not be given the network."""
    source = _make_source(tmp_path)
    target = flac_converter.target_path_for(source)
    seen = {}

    def produce(kwargs):
        seen.update(kwargs)
        _write(target, _FLAC_HEADER + _PLAUSIBLE_BODY)

    _patch_client(monkeypatch, produce)
    flac_converter.convert_one(source, str(tmp_path))

    assert seen["network_mode"] == "none"


def test_ffmpeg_command_preserves_metadata_and_artwork():
    """Tags and embedded cover art must survive, or the library loses them."""
    command = flac_converter._ffmpeg_command("/downloads/in.m4a", "/downloads/out.flac")
    joined = " ".join(command)
    assert "-map_metadata" in command, "tags would be dropped"
    assert "0:v?" in joined, "cover art stream would be dropped"
    assert "attached_pic" in joined, "art would not be stored as a picture"
    assert "flac" in joined


# ---------------------------------------------------------------------------
# Aggregate reporting — the UI's honesty depends on these
# ---------------------------------------------------------------------------

def test_progress_is_reported_per_file_with_a_real_count(monkeypatch, tmp_path):
    sources = [_make_source(tmp_path, f"{index}. Track.m4a") for index in range(3)]

    def produce(kwargs):
        # Derive the output path from the command so every file validates.
        command = kwargs["command"]
        container_target = command[-1]
        relative = container_target.replace(f"{flac_converter.CONTAINER_DOWNLOADS}/", "")
        _write(os.path.join(str(tmp_path), *relative.split("/")), _FLAC_HEADER + _PLAUSIBLE_BODY)

    _patch_client(monkeypatch, produce)

    ticks = []
    result = flac_converter.convert_all(
        sources, str(tmp_path), on_progress=lambda done, total, name: ticks.append((done, total))
    )

    assert result["ok"] is True
    assert result["converted"] == 3
    assert ticks == [(1, 3), (2, 3), (3, 3)], f"progress not a real count: {ticks}"


def test_a_partial_failure_is_not_ok(monkeypatch, tmp_path):
    """One bad track must stop the run being reported as a success."""
    good = _make_source(tmp_path, "good.m4a")
    bad = _make_source(tmp_path, "bad.m4a")

    def produce(kwargs):
        container_target = kwargs["command"][-1]
        if "good" in container_target:
            _write(flac_converter.target_path_for(good), _FLAC_HEADER + _PLAUSIBLE_BODY)
        else:
            _write(flac_converter.target_path_for(bad), b"broken")

    _patch_client(monkeypatch, produce)

    result = flac_converter.convert_all([good, bad], str(tmp_path))

    assert result["ok"] is False
    assert result["converted"] == 1
    assert len(result["failed"]) == 1
    assert os.path.exists(bad), "failed track keeps its source"


def test_cover_art_survives_a_missing_cache_directory(tmp_path, monkeypatch):
    """Artwork must not depend on scan_library having made the cache dir.

    Found in real verification: `_extract_metadata` called outside a scan wrote
    into a nonexistent directory, the OSError was swallowed as a debug log, and
    every track silently reported has_art=False despite carrying a picture.
    """
    import library_manager

    art_dir = str(tmp_path / "never-created" / "album_art")
    monkeypatch.setattr(library_manager, "_ART_DIR", art_dir)
    assert not os.path.exists(art_dir)

    class _AudioWithPicture:
        pictures = [type("Picture", (), {"data": b"\xff\xd8\xff" + b"x" * 64})()]
        tags = {}

    manager = library_manager.LibraryManager()
    cached = manager._cache_art(str(tmp_path / "Album" / "track.flac"), _AudioWithPicture())

    assert cached is not None, "artwork was dropped because the cache dir was missing"
    assert os.path.exists(cached)


def test_cancellation_stops_between_files(monkeypatch, tmp_path):

    sources = [_make_source(tmp_path, f"{index}. Track.m4a") for index in range(3)]

    def produce(kwargs):
        container_target = kwargs["command"][-1]
        relative = container_target.replace(f"{flac_converter.CONTAINER_DOWNLOADS}/", "")
        _write(os.path.join(str(tmp_path), *relative.split("/")), _FLAC_HEADER + _PLAUSIBLE_BODY)

    _patch_client(monkeypatch, produce)

    # Allow exactly one file, then report cancellation.
    calls = {"count": 0}

    def should_continue():
        calls["count"] += 1
        return calls["count"] <= 1

    result = flac_converter.convert_all(
        sources, str(tmp_path), should_continue=should_continue
    )

    assert result["converted"] == 1
    assert result["ok"] is False, "a cancelled run is not a complete one"
