"""Tests for the downloader container config and launch.

Three real bugs are pinned here, all found by tracing a failing download:

1. ``working_dir`` was overridden to ``/downloads``. The downloader binary
   opens ``config.yaml`` by *relative* path, so it resolved against the music
   folder instead of the image's WORKDIR (``/app``), producing
   ``open config.yaml: no such file or directory``.

2. The published image ships a **malformed** ``/app/config.yaml``: its build
   appended save-folder overrides with ``>>`` onto a file lacking a trailing
   newline, fusing ``proxy: ""`` and ``alac-save-folder:`` onto one line. The
   binary rejects it with ``yaml: line 97: did not find expected key``. The
   image also contains no ``config.yaml.example`` to copy from, so Audora
   generates a valid config and mounts it over the broken one.

3. Docker Desktop was only looked for under ``Program Files``, so the
   "Start Docker & Retry" recovery was dead on a per-user install.

No Docker daemon is needed: the container config is inspected as a dict.
"""
import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest  # noqa: E402

import download_manager  # noqa: E402
import downloader_config  # noqa: E402
import downloader_image  # noqa: E402


def _run(coroutine):
    """Drive a coroutine to completion.

    ``asyncio.run`` rather than a pytest-asyncio marker: the rest of this suite
    needs no async plugin, and one is not worth adding for a handful of tests.
    """
    return asyncio.run(coroutine)


async def _noop_stream():
    """Stand-in for ``_stream_output``.

    Must be a coroutine: ``start_download`` hands it to ``asyncio.create_task``,
    which rejects a plain ``None``.
    """
    return None


# ---------------------------------------------------------------------------
# The generated config itself
# ---------------------------------------------------------------------------

def test_generated_config_is_valid_yaml():
    """The whole point: the image's copy is unparseable, ours must not be."""
    yaml = pytest.importorskip("yaml")
    parsed = yaml.safe_load(downloader_config.build_config())
    assert isinstance(parsed, dict)
    assert parsed, "config parsed to an empty document"


def test_config_never_fuses_keys_onto_one_line():
    """Reproduces the exact upstream defect: `proxy: ""alac-save-folder: ...`."""
    text = downloader_config.build_config()
    assert 'proxy: ""alac-save-folder' not in text
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("#") or not stripped:
            continue
        # Two top-level `key: value` pairs on one physical line is the bug.
        assert stripped.count(": ") <= 1, f"two keys fused onto one line: {line!r}"


def test_config_ends_with_a_newline():
    """The missing trailing newline is what caused the fusion upstream."""
    assert downloader_config.build_config().endswith("\n")


def test_save_folders_are_absolute_paths_inside_the_mount():
    """Relative save folders would write inside the container and be lost."""
    yaml = pytest.importorskip("yaml")
    parsed = yaml.safe_load(downloader_config.build_config())
    for key in (
        "alac-save-folder",
        "atmos-save-folder",
        "aac-save-folder",
        "mv-save-folder",
    ):
        value = parsed[key]
        assert value.startswith(downloader_config.CONTAINER_DOWNLOADS + "/"), (
            f"{key}={value!r} is outside the {downloader_config.CONTAINER_DOWNLOADS} mount"
        )


def test_music_video_folder_is_set():
    """Upstream's appended block omitted mv-save-folder, losing music videos."""
    yaml = pytest.importorskip("yaml")
    parsed = yaml.safe_load(downloader_config.build_config())
    assert parsed.get("mv-save-folder"), "mv-save-folder missing"


def test_wrapper_ports_match_the_wrapper_manager():
    """A port mismatch would silently break decryption."""
    yaml = pytest.importorskip("yaml")
    import wrapper_manager

    parsed = yaml.safe_load(downloader_config.build_config())
    assert parsed["decrypt-m3u8-port"].endswith(
        f":{wrapper_manager.WRAPPER_DECRYPT_PORT}"
    )
    assert parsed["get-m3u8-port"].endswith(f":{wrapper_manager.WRAPPER_M3U8_PORT}")


def test_config_carries_no_credentials():
    """The downloader authenticates through the wrapper; nothing secret here."""
    text = downloader_config.build_config().lower()
    for marker in ("@icloud.com", "@gmail.com", "password:", "-l "):
        assert marker not in text, f"possible credential in generated config: {marker!r}"


def test_write_config_creates_the_file(tmp_path):
    path = downloader_config.write_config(str(tmp_path))
    assert os.path.isfile(path)
    assert os.path.basename(path) == "config.yaml"
    # LF endings: the container reads this as Linux text.
    with open(path, "rb") as handle:
        assert b"\r\n" not in handle.read()


# ---------------------------------------------------------------------------
# Quality ceilings — they live only in the config, so it must be regenerated
# per download rather than reused from a previous run. There is no longer a
# user-facing format choice: Audora always fetches the lossless ALAC source and
# converts it to FLAC afterwards (see flac_converter).
# ---------------------------------------------------------------------------

def test_config_is_valid_yaml_with_quality_ceilings():
    yaml = pytest.importorskip("yaml")
    parsed = yaml.safe_load(downloader_config.build_config())
    assert parsed["alac-max"], "no alac-max"
    assert parsed["atmos-max"], "no atmos-max"
    assert parsed["aac-type"], "no aac-type"


def test_build_config_takes_no_format_argument():
    """The format parameter is gone; passing one must be a hard error.

    Guards against a caller silently keeping a stale ``build_config("aac")``
    that would otherwise look like it still selected a codec.
    """
    with pytest.raises(TypeError):
        downloader_config.build_config("aac")  # type: ignore[call-arg]


def test_resolve_format_always_reports_flac():
    """The compatibility shim must never resurrect a codec choice."""
    for requested in ("alac", "aac", "atmos", "nonsense", ""):
        assert downloader_config.resolve_format(requested) == "flac"


def test_conversion_is_left_to_audora():
    """The downloader's own conversion must stay off.

    Audora converts in flac_converter so every output is validated before its
    lossless source is deleted; enabling upstream's pass (which defaults to
    convert-keep-original:false) could destroy the source on failure.
    """
    yaml = pytest.importorskip("yaml")
    parsed = yaml.safe_load(downloader_config.build_config())
    assert parsed["convert-after-download"] is False


def test_quality_values_are_ones_the_binary_accepts():
    """Values are constrained by the image's own documented choices."""
    yaml = pytest.importorskip("yaml")
    parsed = yaml.safe_load(downloader_config.build_config())
    assert parsed["alac-max"] in (192000, 96000, 48000, 44100)
    assert parsed["atmos-max"] in (2768, 2448)
    assert parsed["aac-type"] in ("aac-lc", "aac", "aac-binaural", "aac-downmix")


def test_rewriting_replaces_the_old_file(tmp_path):
    """A stale config from a previous run must never be reused."""
    first = downloader_config.write_config(str(tmp_path))
    original = open(first, encoding="utf-8").read()
    second = downloader_config.write_config(str(tmp_path))
    assert first == second, "should overwrite in place, not accumulate files"
    rewritten = open(second, encoding="utf-8").read()
    yaml = pytest.importorskip("yaml")
    assert yaml.safe_load(rewritten)
    assert len(os.listdir(tmp_path)) == 1, "left a stale config behind"
    assert original is not None


# ---------------------------------------------------------------------------
# The container launch config
# ---------------------------------------------------------------------------

def _capture_container_config(monkeypatch, tmp_path):
    """Run start_download far enough to capture the dict passed to Docker."""
    captured = {}

    class _FakeContainer:
        id = "fake123"

    def fake_start(config):
        captured.update(config)
        return _FakeContainer()

    monkeypatch.setattr(download_manager.docker_mgr, "start_container", fake_start)
    monkeypatch.setattr(
        download_manager,
        "get_settings",
        lambda: {"downloads_path": str(tmp_path)},
    )
    monkeypatch.setattr(download_manager, "CONFIG_DIR", str(tmp_path / "cfg"))
    return captured


def test_launch_does_not_override_working_dir(monkeypatch, tmp_path):
    """Bug 1: the override moved the binary away from its config.yaml."""
    captured = _capture_container_config(monkeypatch, tmp_path)
    manager = download_manager.DownloadManager()
    monkeypatch.setattr(manager, "_stream_output", _noop_stream)

    started = _run(manager.start_download("https://music.apple.com/us/album/x/123"))
    assert started is True
    assert "working_dir" not in captured, (
        "working_dir must not be set: the binary opens config.yaml relative to "
        "the image's own WORKDIR (/app)"
    )


def test_launch_mounts_a_config_over_the_broken_one(monkeypatch, tmp_path):
    """Bug 2: the image's config.yaml is unparseable, so we supply our own."""
    captured = _capture_container_config(monkeypatch, tmp_path)
    manager = download_manager.DownloadManager()
    monkeypatch.setattr(manager, "_stream_output", _noop_stream)

    _run(manager.start_download("https://music.apple.com/us/album/x/123"))

    binds = {spec["bind"]: spec for spec in captured["volumes"].values()}
    assert downloader_config.CONTAINER_CONFIG_PATH in binds, (
        "no config.yaml mounted; the container would read the broken copy"
    )
    assert binds[downloader_config.CONTAINER_CONFIG_PATH]["mode"] == "ro"
    # The downloads mount must survive alongside it.
    assert "/downloads" in binds
    assert binds["/downloads"]["mode"] == "rw"


def test_launch_writes_the_config_before_starting(monkeypatch, tmp_path):
    """The file must exist on disk at mount time.

    Upstream's README warns that bind-mounting a nonexistent config makes
    Docker create a *directory* at that path, which fails the container.
    """
    config_dir = tmp_path / "cfg"
    captured = _capture_container_config(monkeypatch, tmp_path)
    manager = download_manager.DownloadManager()
    monkeypatch.setattr(manager, "_stream_output", _noop_stream)

    _run(manager.start_download("https://music.apple.com/us/album/x/123"))

    assert (config_dir / "config.yaml").is_file()
    assert captured  # container really was started


def test_launch_regenerates_the_config_every_download(monkeypatch, tmp_path):
    """Point 5: fresh per download, never stale from a previous run."""
    written = []
    real_write = downloader_config.write_config

    def spy_write(directory):
        written.append(directory)
        return real_write(directory)

    monkeypatch.setattr(downloader_config, "write_config", spy_write)
    _capture_container_config(monkeypatch, tmp_path)
    manager = download_manager.DownloadManager()
    monkeypatch.setattr(manager, "_stream_output", _noop_stream)

    _run(manager.start_download("https://music.apple.com/us/album/x/123"))
    manager._is_running = False
    _run(manager.start_download("https://music.apple.com/us/album/x/123"))

    assert len(written) == 2, f"config not regenerated per download: {written}"


def test_launch_uses_audoras_own_downloader_image(monkeypatch, tmp_path):
    """Downloads must run the image that carries ffmpeg.

    The upstream image alone cannot convert to FLAC, and an unconverted ALAC
    download is exactly the file Electron cannot play.
    """
    captured = _capture_container_config(monkeypatch, tmp_path)
    manager = download_manager.DownloadManager()
    monkeypatch.setattr(manager, "_stream_output", _noop_stream)

    _run(manager.start_download("https://music.apple.com/us/album/x/123"))

    assert captured["image"] == downloader_image.AUDORA_DOWNLOADER_IMAGE


def test_launch_passes_no_codec_flag(monkeypatch, tmp_path):
    """--aac / --atmos would fetch a lossy or spatial mix, not the lossless source."""
    captured = _capture_container_config(monkeypatch, tmp_path)
    manager = download_manager.DownloadManager()
    monkeypatch.setattr(manager, "_stream_output", _noop_stream)

    _run(manager.start_download("https://music.apple.com/us/album/x/123"))

    assert "--aac" not in captured["command"]
    assert "--atmos" not in captured["command"]


def test_launch_keeps_host_networking(monkeypatch, tmp_path):
    """Host networking is how the downloader reaches the wrapper ports."""
    captured = _capture_container_config(monkeypatch, tmp_path)
    manager = download_manager.DownloadManager()
    monkeypatch.setattr(manager, "_stream_output", _noop_stream)

    _run(manager.start_download("https://music.apple.com/us/album/x/123"))

    assert captured["network_mode"] == "host"
    assert "ports" not in captured, "ports + host networking is rejected by Docker"


# Docker Desktop discovery is covered in depth by test_docker_discovery.py,
# which simulates per-user, all-users and custom install locations rather than
# asserting against whatever layout this machine happens to have.
