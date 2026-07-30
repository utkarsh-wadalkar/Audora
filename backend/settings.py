"""Application settings — JSON-backed with sane defaults.

Settings live in ``data/settings.json`` next to the backend. Missing keys
fall back to the defaults below so the app always has a complete config.
"""
import json
import os
import threading
from typing import Any, Dict

_LOCK = threading.Lock()

# Resolve paths relative to this file so it works in dev and when frozen.
_BASE_DIR = os.path.dirname(os.path.abspath(__file__))
_DATA_DIR = os.path.join(_BASE_DIR, "data")
_SETTINGS_PATH = os.path.join(_DATA_DIR, "settings.json")

DEFAULTS: Dict[str, Any] = {
    "downloads_path": "D:\\apple-music-dl\\downloads",
    "wrapper_data_path": "D:\\apple-music-dl\\wrapper\\rootfs\\data",
    "auto_start_wrapper": True,
    "backend_port": 8000,
    "log_level": "INFO",
    "download_format": "alac",  # alac | aac | atmos
    "setup_complete": False,
    # Leave the wrapper container running when Audora exits, so the next start
    # reuses it instead of tearing it down and rebuilding. Removing it on exit
    # is what made the container churn on every app start.
    "keep_wrapper_running": True,
}

_cache: Dict[str, Any] | None = None


def _ensure_data_dir() -> None:
    os.makedirs(_DATA_DIR, exist_ok=True)


def _load_from_disk() -> Dict[str, Any]:
    if not os.path.exists(_SETTINGS_PATH):
        return {}
    try:
        with open(_SETTINGS_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return {}


def get_settings() -> Dict[str, Any]:
    """Return the full settings dict, merging defaults with saved values."""
    global _cache
    with _LOCK:
        if _cache is None:
            merged = dict(DEFAULTS)
            merged.update(_load_from_disk())
            _cache = merged
        return dict(_cache)


def update_settings(patch: Dict[str, Any]) -> Dict[str, Any]:
    """Apply a partial update, persist to disk, and return the new settings."""
    global _cache
    with _LOCK:
        current = dict(DEFAULTS)
        current.update(_load_from_disk())
        # Only accept known keys to avoid junk piling up.
        for key, value in patch.items():
            if key in DEFAULTS:
                current[key] = value
        _ensure_data_dir()
        with open(_SETTINGS_PATH, "w", encoding="utf-8") as f:
            json.dump(current, f, indent=2)
        _cache = current
        return dict(current)
