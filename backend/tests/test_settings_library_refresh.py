"""Settings changes that alter which filesystem tree backs the library."""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import app as app_module  # noqa: E402
from schemas import SettingsUpdate  # noqa: E402


@pytest.mark.parametrize("key", ["library_path", "downloads_path"])
def test_changing_the_music_folder_updates_both_paths_and_rescans(key, monkeypatch, tmp_path):
    """Saving a new root must not leave the old cached library on screen."""
    old_root = str(tmp_path / "old-library")
    new_root = str(tmp_path / "new-library")
    os.mkdir(new_root)
    scans = []

    monkeypatch.setattr(
        app_module,
        "get_settings",
        lambda: {"downloads_path": old_root},
    )
    monkeypatch.setattr(app_module, "update_settings", dict)
    monkeypatch.setattr(
        app_module.lib_mgr,
        "scan_library",
        lambda: scans.append(new_root) or [],
    )

    settings = app_module.write_settings(SettingsUpdate(**{key: new_root})).data

    assert settings["library_path"] == settings["downloads_path"] == str((tmp_path / "new-library").resolve())
    assert scans == [new_root]
