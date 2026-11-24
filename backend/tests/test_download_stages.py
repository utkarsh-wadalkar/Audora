"""Tests for the two-stage download status contract.

The UI's promise is "Ready to play -> Play": when Audora says a download
finished, the track must actually be playable. Since an unconverted ALAC file
cannot be decoded by Electron, a run whose conversion failed must never report
``completed`` — otherwise the user is handed a track that silently refuses to
play, which is the exact bug this rework fixes.

``_final_status`` is the single place that decision is made, so it is tested
directly rather than through a full download.
"""
import os
import sys
import asyncio

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import download_manager  # noqa: E402

_resolve = download_manager.DownloadManager._final_status


def _convert(ok: bool, converted: int, total: int, failed=None):
    return {
        "ok": ok,
        "converted": converted,
        "total": total,
        "failed": failed or [],
        "outputs": [],
    }


def test_a_fully_converted_run_is_completed():
    status = _resolve(False, False, _convert(True, 3, 3))
    assert status == "completed"


def test_a_failed_conversion_is_not_completed():
    """The core guarantee: no success claim without a playable file."""
    status = _resolve(False, False, _convert(False, 2, 3, failed=["Track 3"]))
    assert status == "convert_failed"
    assert status != "completed"


def test_a_wholly_failed_conversion_is_not_completed():
    status = _resolve(False, False, _convert(False, 0, 2, failed=["A", "B"]))
    assert status == "convert_failed"


def test_cancellation_outranks_conversion_state():
    """Stopping the job is the user's action, not a conversion defect."""
    status = _resolve(True, False, _convert(False, 1, 3, failed=["Track 2"]))
    assert status == "cancelled"


def test_a_failed_download_is_reported_as_failed():
    status = _resolve(False, True, None)
    assert status == "failed"


def test_nothing_downloaded_is_still_completed():
    """An album already on disk converts nothing and is not an error."""
    assert _resolve(False, False, None) == "completed"
    assert _resolve(False, False, _convert(False, 0, 0)) == "completed"


def test_container_already_exists_requires_a_verified_host_file(monkeypatch, tmp_path):
    manager = download_manager.DownloadManager()
    manager._downloads_path = str(tmp_path)
    manager._library_path = str(tmp_path)
    collection = tmp_path / "ALAC" / "Apple Music" / "Playlist"
    collection.mkdir(parents=True)
    (collection / "02. Unrelated.flac").write_bytes(b"fLaC" + b"0" * 8192)
    monkeypatch.setattr(download_manager.docker_mgr, "stream_logs", lambda *_a, **_kw: iter([
        "Queue 1 of 1: Playlist", "Apple Music", "Playlist",
        "Track 1 of 1: songs", "01. Missing", "Track already exists locally.",
        "======= Completed: 1/1 | Warnings: 0 | Errors: 0 =======",
    ]))

    def run():
        manager._container_id = "test-container"
        manager._is_running = True
        asyncio.run(manager._stream_output())
        return manager.last_summary

    failed = run()
    assert failed["status"] == "failed"
    assert failed["verified_files"] == []
    assert failed["destination"] == str(tmp_path)

    local = collection / "01. Missing.flac"
    local.write_bytes(b"fLaC" + b"0" * 8192)
    ready = run()
    assert ready["status"] == "completed"
    assert ready["verified_files"] == [str(local)]


def test_staged_outputs_are_published_to_the_library(tmp_path):
    from download_storage import verify_download_files

    working, library = tmp_path / "working", tmp_path / "library"
    staged = working / "ALAC" / "Playlist" / "01. Song.flac"
    staged.parent.mkdir(parents=True)
    library.mkdir()
    audio = b"fLaC" + b"0" * 8192
    staged.write_bytes(audio)

    destination = library / staged.relative_to(working)
    assert verify_download_files(working, library, [], [staged]) == [str(destination)]
    assert destination.read_bytes() == audio
    destination.write_bytes(b"existing data")
    assert verify_download_files(working, library, [], [staged]) == []
    assert destination.read_bytes() == b"existing data"


def test_mount_probe_uses_exit_status_without_reading_docker_logs(monkeypatch, tmp_path):
    from pathlib import Path
    from types import SimpleNamespace

    import download_storage

    removed = []
    exit_status = 0

    def create(_image, **kwargs):
        command = kwargs["command"]
        marker = tmp_path / Path(command[-2]).name
        assert marker.read_text() == command[-1]
        assert kwargs["network_mode"] == "none"
        assert next(iter(kwargs["volumes"].values()))["mode"] == "ro"
        # Deliberately provide no logs(): the check must work with any driver.
        return SimpleNamespace(
            start=lambda: None,
            wait=lambda **_: {"StatusCode": exit_status},
            remove=lambda **flags: removed.append(flags),
        )

    client = SimpleNamespace(containers=SimpleNamespace(create=create))
    monkeypatch.setattr(download_storage.docker_mgr, "get_client", lambda: client)

    assert download_storage.docker_sees_folder(str(tmp_path))
    exit_status = 1
    assert not download_storage.docker_sees_folder(str(tmp_path))
    assert removed == [{"force": True, "v": True}] * 2
    assert list(tmp_path.iterdir()) == []


def test_only_new_covers_beside_completed_tracks_are_removed(tmp_path):
    manager = download_manager.DownloadManager()
    old_folder = tmp_path / "old"
    new_folder = tmp_path / "new"
    failed_folder = tmp_path / "failed"
    for folder in (old_folder, new_folder, failed_folder):
        folder.mkdir()
    old_cover = old_folder / "cover.jpg"
    old_cover.write_bytes(b"existing user image")
    manager._downloads_path = str(tmp_path)
    manager._covers_before = manager._sidecar_covers(str(tmp_path))
    new_cover = new_folder / "cover.jpg"
    failed_cover = failed_folder / "cover.jpg"
    new_cover.write_bytes(b"downloaded image")
    failed_cover.write_bytes(b"needed for retry")

    manager._remove_new_covers([str(new_folder / "song.flac")])

    assert old_cover.read_bytes() == b"existing user image"
    assert not new_cover.exists()
    assert failed_cover.exists()


def test_album_fallback_is_embedded_before_removing_new_cover(monkeypatch, tmp_path):
    manager = download_manager.DownloadManager()
    manager._downloads_path = str(tmp_path)
    manager._covers_before = set()
    manager._current_url = "https://music.apple.com/us/album/freedom/123"
    cover = tmp_path / "cover.jpg"
    cover.write_bytes(b"album art")
    tracks = [str(tmp_path / "one.flac"), str(tmp_path / "two.flac")]
    applied = []
    monkeypatch.setattr(
        download_manager.flac_converter,
        "embed_album_cover_if_missing",
        lambda track, image: applied.append((track, image)) or True,
    )

    manager._remove_new_covers(tracks)

    assert applied == [(track, str(cover)) for track in tracks]
    assert not cover.exists()


def test_playlist_fallback_fills_missing_track_art_before_cover_cleanup(monkeypatch, tmp_path):
    manager = download_manager.DownloadManager()
    manager._downloads_path = str(tmp_path)
    manager._covers_before = set()
    manager._current_url = "https://music.apple.com/us/playlist/essentials/pl.123"
    cover = tmp_path / "cover.jpg"
    cover.write_bytes(b"playlist art")
    track = str(tmp_path / "song.flac")
    applied = []
    monkeypatch.setattr(
        download_manager.flac_converter,
        "embed_album_cover_if_missing",
        lambda output, image: applied.append((output, image)) or True,
    )

    manager._remove_new_covers([track])

    assert applied == [(track, str(cover))]
    assert not cover.exists()


def test_failed_fallback_keeps_cover_for_recovery(monkeypatch, tmp_path):
    manager = download_manager.DownloadManager()
    manager._downloads_path = str(tmp_path)
    manager._covers_before = set()
    manager._current_url = "https://music.apple.com/us/album/freedom/123"
    cover = tmp_path / "cover.jpg"
    cover.write_bytes(b"album art")
    monkeypatch.setattr(
        download_manager.flac_converter,
        "embed_album_cover_if_missing",
        lambda _track, _cover: False,
    )

    manager._remove_new_covers([str(tmp_path / "song.flac")])

    assert cover.exists()


def test_existing_album_cover_can_fill_missing_art_but_is_not_deleted(monkeypatch, tmp_path):
    manager = download_manager.DownloadManager()
    manager._downloads_path = str(tmp_path)
    manager._current_url = "https://music.apple.com/us/album/freedom/123"
    cover = tmp_path / "cover.jpg"
    cover.write_bytes(b"existing album art")
    manager._covers_before = manager._sidecar_covers(str(tmp_path))
    applied = []
    monkeypatch.setattr(
        download_manager.flac_converter,
        "embed_album_cover_if_missing",
        lambda track, image: applied.append((track, image)) or True,
    )

    manager._remove_new_covers([str(tmp_path / "song.flac")])

    assert applied == [(str(tmp_path / "song.flac"), str(cover))]
    assert cover.read_bytes() == b"existing album art"


# ---------------------------------------------------------------------------
# Percentage honesty
# ---------------------------------------------------------------------------

def test_percent_is_zero_when_the_total_is_unknown():
    """No total means no honest percentage — never a fabricated one."""
    assert download_manager._ratio_percent(0, 0) == 0
    assert download_manager._ratio_percent(5, 0) == 0


def test_percent_tracks_the_real_ratio():
    assert download_manager._ratio_percent(1, 4) == 25
    assert download_manager._ratio_percent(3, 3) == 100


def test_percent_is_clamped():
    """A miscounted stream must not render a bar past its own track."""
    assert download_manager._ratio_percent(9, 3) == 100
    assert download_manager._ratio_percent(-1, 3) == 0


def test_terminal_retry_prompt_finishes_run_and_preserves_real_errors(monkeypatch, tmp_path):
    manager = download_manager.DownloadManager()
    manager._downloads_path = str(tmp_path)
    manager._container_id = "test-container"
    manager._is_running = True
    manager._current_url = "https://music.apple.com/us/playlist/example/pl.123"
    completed_events = []
    stopped = []
    manager.register_completion_callback(completed_events.append)
    monkeypatch.setattr(
        download_manager.docker_mgr, "stream_logs",
        lambda *_args, **_kwargs: iter([
            "Queue 1 of 1: Playlist",
            "Apple Music",
            "Example Essentials",
            "Track 1 of 3: songs",
            "======= Completed: 2/3 | Warnings: 0 | Errors: 1 =======",
            "Error detected, press Enter to try again...",
        ]),
    )
    monkeypatch.setattr(
        download_manager.docker_mgr, "stop_container",
        lambda name, timeout=10: stopped.append(name) or True,
    )
    monkeypatch.setattr(download_manager.docker_mgr, "send_container_input", lambda *_args: False)

    async def convert(_name, completed=0, failed=0):
        return {"ok": True, "converted": 2, "failed": [], "total": 2, "outputs": []}

    monkeypatch.setattr(manager, "_convert_to_flac", convert)
    asyncio.run(manager._stream_output())

    assert stopped == [download_manager.DOWNLOADER_CONTAINER_NAME]
    assert completed_events[-1]["completed"] == 2
    assert completed_events[-1]["failed"] == 1
    assert completed_events[-1]["converted"] == 2
    assert completed_events[-1]["retry_prompt"] is True
    assert manager._collection_folders == {
        os.path.abspath(tmp_path / "ALAC" / "Apple Music" / "Example Essentials")
    }


def test_missing_tracks_are_retried_before_conversion(monkeypatch, tmp_path):
    manager = download_manager.DownloadManager()
    manager._downloads_path = str(tmp_path)
    manager._container_id = "test-container"
    manager._is_running = True
    events = []
    summaries = []
    inputs = []
    manager.register_progress_callback(events.append)
    manager.register_completion_callback(summaries.append)
    monkeypatch.setattr(download_manager.docker_mgr, "stream_logs", lambda *_args, **_kw: iter([
        "Track 1 of 3: songs",
        "======= Completed: 1/3 | Warnings: 0 | Errors: 2 =======",
        "Error detected, press Enter to try again...",
        "Track 1 of 3: songs",
        "======= Completed: 2/3 | Warnings: 0 | Errors: 1 =======",
        "Error detected, press Enter to try again...",
        "Track 1 of 3: songs",
        "======= Completed: 3/3 | Warnings: 0 | Errors: 0 =======",
    ]))
    monkeypatch.setattr(download_manager.docker_mgr, "send_container_input", lambda name, value: inputs.append((name, value)) or True)

    async def convert(_name, completed=0, failed=0):
        assert (completed, failed) == (3, 0)
        assert len(inputs) == 2
        return {"ok": True, "converted": 3, "failed": [], "total": 3, "outputs": []}

    monkeypatch.setattr(manager, "_convert_to_flac", convert)
    asyncio.run(manager._stream_output())

    assert inputs == [(download_manager.DOWNLOADER_CONTAINER_NAME, "\n")] * 2
    assert [event["retry_attempt"] for event in events if event.get("status") == "retrying"] == [1, 2]
    assert summaries[-1]["status"] == "completed"
    assert summaries[-1]["retry_attempts"] == 2
    assert summaries[-1]["converted"] == 3


def test_automatic_retry_stops_after_two_failed_passes(monkeypatch):
    manager = download_manager.DownloadManager()
    manager._container_id = "test-container"
    manager._is_running = True
    prompts = ["======= Completed: 1/3 | Warnings: 0 | Errors: 2 =======",
               "Error detected, press Enter to try again..."]
    monkeypatch.setattr(download_manager.docker_mgr, "stream_logs", lambda *_a, **_kw: iter(prompts * 3))
    inputs = []
    stops = []
    summaries = []
    manager.register_completion_callback(summaries.append)
    monkeypatch.setattr(download_manager.docker_mgr, "send_container_input", lambda _name, value: inputs.append(value) or True)
    monkeypatch.setattr(download_manager.docker_mgr, "stop_container", lambda name, timeout=10: stops.append(name) or True)

    async def convert(*_args):
        return {"ok": True, "converted": 1, "failed": [], "total": 1, "outputs": []}

    monkeypatch.setattr(manager, "_convert_to_flac", convert)
    asyncio.run(manager._stream_output())
    assert inputs == ["\n", "\n"]
    assert stops == [download_manager.DOWNLOADER_CONTAINER_NAME]
    assert summaries[-1]["retry_attempts"] == 2
    assert summaries[-1]["failed"] == 2


def test_conversion_recovers_only_existing_alac_in_current_collection(monkeypatch, tmp_path):
    manager = download_manager.DownloadManager()
    manager._downloads_path = str(tmp_path)
    manager._is_running = True
    target = tmp_path / "ALAC" / "Apple Music" / "Example Essentials"
    unrelated = tmp_path / "ALAC" / "Apple Music" / "Unrelated Essentials"
    target.mkdir(parents=True)
    unrelated.mkdir(parents=True)
    track = target / "01. Track.m4a"
    other = unrelated / "02. Other.m4a"
    track.write_bytes(b"m4a")
    other.write_bytes(b"m4a")
    manager._sources_before = download_manager.flac_converter.snapshot_sources(str(tmp_path))
    manager._collection_folders = {str(target)}
    seen = []

    def convert(paths, root, progress, should_continue):
        seen.extend(paths)
        return {"ok": True, "converted": len(paths), "failed": [], "total": len(paths), "outputs": []}

    monkeypatch.setattr(download_manager.flac_converter, "convert_all", convert)
    result = asyncio.run(manager._convert_to_flac("Track", completed=1, failed=0))

    assert seen == [os.path.abspath(track)]
    assert result["total"] == 1
    assert os.path.abspath(other) not in seen


def test_terminal_prompt_does_not_convert_if_container_cannot_stop(monkeypatch):
    manager = download_manager.DownloadManager()
    manager._container_id = "test-container"
    manager._is_running = True
    summaries = []
    manager.register_completion_callback(summaries.append)
    monkeypatch.setattr(
        download_manager.docker_mgr, "stream_logs",
        lambda *_args, **_kwargs: iter(["Error detected, press Enter to try again..."]),
    )
    monkeypatch.setattr(
        download_manager.docker_mgr, "stop_container", lambda *_args, **_kwargs: False,
    )
    monkeypatch.setattr(download_manager.docker_mgr, "send_container_input", lambda *_args: False)

    async def unexpected_conversion(*_args):
        raise AssertionError("conversion started while downloader may still write")

    monkeypatch.setattr(manager, "_convert_to_flac", unexpected_conversion)
    asyncio.run(manager._stream_output())

    assert summaries[-1]["status"] == "failed"


def test_failed_retry_still_converts_existing_collection_sources(monkeypatch, tmp_path):
    manager = download_manager.DownloadManager()
    manager._downloads_path = str(tmp_path)
    manager._container_id = "test-container"
    manager._is_running = True
    summaries = []
    manager.register_completion_callback(summaries.append)
    collection = tmp_path / "ALAC" / "Apple Music" / "Example Essentials"
    collection.mkdir(parents=True)
    source = collection / "01. Track.m4a"
    source.write_bytes(b"m4a")
    manager._sources_before = download_manager.flac_converter.snapshot_sources(str(tmp_path))
    monkeypatch.setattr(
        download_manager.docker_mgr, "stream_logs",
        lambda *_args, **_kwargs: iter([
            "Queue 1 of 1: Playlist", "Apple Music", "Example Essentials",
            "======= Completed: 0/3 | Warnings: 0 | Errors: 3 =======",
            "Error detected, press Enter to try again...",
        ]),
    )
    monkeypatch.setattr(
        download_manager.docker_mgr, "stop_container", lambda *_args, **_kwargs: True,
    )
    monkeypatch.setattr(download_manager.docker_mgr, "send_container_input", lambda *_args: False)
    seen = []

    def convert(paths, *_args):
        seen.extend(paths)
        return {"ok": True, "converted": 1, "failed": [], "total": 1, "outputs": []}

    monkeypatch.setattr(download_manager.flac_converter, "convert_all", convert)
    asyncio.run(manager._stream_output())

    assert seen == [os.path.abspath(source)]
    assert summaries[-1]["status"] == "failed"
    assert summaries[-1]["converted"] == 1
    assert summaries[-1]["failed"] == 3


def test_playlist_title_with_path_punctuation_recovers_sanitized_folder(monkeypatch, tmp_path):
    manager = download_manager.DownloadManager()
    manager._downloads_path = str(tmp_path)
    manager._container_id = "test-container"
    manager._is_running = True
    folder = tmp_path / "ALAC" / "Apple Music" / "A_B Essentials"
    folder.mkdir(parents=True)
    source = folder / "01. Track.m4a"
    source.write_bytes(b"m4a")
    manager._sources_before = download_manager.flac_converter.snapshot_sources(str(tmp_path))
    monkeypatch.setattr(
        download_manager.docker_mgr, "stream_logs",
        lambda *_args, **_kwargs: iter([
            "Queue 1 of 1: Playlist", "Apple Music", "A/B Essentials",
            "======= Completed: 1/1 | Warnings: 0 | Errors: 0 =======",
        ]),
    )
    seen = []
    monkeypatch.setattr(
        download_manager.flac_converter, "convert_all",
        lambda paths, *_args: (
            seen.extend(paths)
            or {"ok": True, "converted": 1, "failed": [], "total": 1, "outputs": []}
        ),
    )

    asyncio.run(manager._stream_output())

    assert seen == [os.path.abspath(source)]


def test_valid_flac_removes_redundant_alac_only_in_current_collection(monkeypatch, tmp_path):
    manager = download_manager.DownloadManager()
    manager._downloads_path = str(tmp_path)
    manager._is_running = True
    current = tmp_path / "ALAC" / "Apple Music" / "Current"
    other = tmp_path / "ALAC" / "Apple Music" / "Other"
    current.mkdir(parents=True)
    other.mkdir(parents=True)
    duplicate = current / "01. Track.m4a"
    duplicate.write_bytes(b"source")
    (current / "01. Track.flac").write_bytes(b"fLaC" + b"\0" * 8192)
    unrelated = other / "01. Track.m4a"
    unrelated.write_bytes(b"keep")
    manager._sources_before = download_manager.flac_converter.snapshot_sources(str(tmp_path))
    manager._collection_folders = {str(current)}

    result = asyncio.run(manager._convert_to_flac("Track"))

    assert result is None
    assert not duplicate.exists()
    assert unrelated.read_bytes() == b"keep"


def test_retry_repairs_existing_flac_art_only_in_current_collection(monkeypatch, tmp_path):
    manager = download_manager.DownloadManager()
    manager._downloads_path = str(tmp_path)
    manager._is_running = True
    current = tmp_path / "ALAC" / "Apple Music" / "Current"
    other = tmp_path / "ALAC" / "Apple Music" / "Other"
    current.mkdir(parents=True)
    other.mkdir(parents=True)
    track = current / "01. Track.flac"
    unrelated = other / "01. Other.flac"
    for path in (track, unrelated):
        path.write_bytes(b"fLaC" + b"\0" * 8192)
    manager._collection_folders = {str(current)}
    repaired = []
    monkeypatch.setattr(
        download_manager.flac_converter,
        "normalize_flac_artwork",
        lambda path: repaired.append(path) or True,
    )

    assert asyncio.run(manager._convert_to_flac("Track")) is None
    assert repaired == [str(track)]
