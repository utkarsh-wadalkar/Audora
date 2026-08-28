"""Settings changes that alter which filesystem tree backs the library."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import app as app_module  # noqa: E402
from schemas import SettingsUpdate  # noqa: E402


def test_changing_downloads_path_rescans_the_new_library(monkeypatch, tmp_path):
    """Saving a new root must not leave the old cached library on screen."""
    old_root = str(tmp_path / "old-library")
    new_root = str(tmp_path / "new-library")
    scans = []

    monkeypatch.setattr(
        app_module,
        "get_settings",
        lambda: {"downloads_path": old_root},
    )
    monkeypatch.setattr(
        app_module,
        "update_settings",
        lambda patch: {"downloads_path": patch["downloads_path"]},
    )
    monkeypatch.setattr(
        app_module.lib_mgr,
        "scan_library",
        lambda: scans.append(new_root) or [],
    )

    app_module.write_settings(SettingsUpdate(downloads_path=new_root))

    assert scans == [new_root]
