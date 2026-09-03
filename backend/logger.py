"""Central logging setup.

Provides a rotating file logger plus console output. An in-memory ring
buffer lets the API expose recent logs without re-reading the file, and
registered callbacks let the app broadcast each record over a WebSocket.
"""
import datetime
import logging
import os
from collections import deque
from logging.handlers import RotatingFileHandler
from typing import Callable, Deque, Dict, List

from runtime_platform import get_data_dir

_BASE_DIR = os.path.dirname(os.path.abspath(__file__))
_LOG_DIR = os.path.join(str(get_data_dir()), "logs")
_LOG_PATH = os.path.join(_LOG_DIR, "audora.log")

# Ring buffer of recent structured log records for the /logs endpoint.
_RECENT: Deque[Dict[str, str]] = deque(maxlen=500)

# Callbacks invoked with each structured record (used for WebSocket fan-out).
_CALLBACKS: List[Callable[[Dict[str, str]], None]] = []


def _make_entry(record: logging.LogRecord) -> Dict[str, str]:
    return {
        "type": "log",
        "timestamp": datetime.datetime.fromtimestamp(record.created).isoformat(
            timespec="seconds"
        ),
        "level": record.levelname,
        "logger": record.name,
        "message": record.getMessage(),
    }


class _RingBufferHandler(logging.Handler):
    def emit(self, record: logging.LogRecord) -> None:
        try:
            entry = _make_entry(record)
        except Exception:
            return
        _RECENT.append(entry)
        for cb in list(_CALLBACKS):
            try:
                cb(entry)
            except Exception:
                # A broken callback must never break logging.
                pass


_configured = False


def setup_logger(level: str = "INFO") -> logging.Logger:
    """Configure root logging once; safe to call repeatedly.

    Returns the root logger so callers can use ``logger = setup_logger()``.
    """
    global _configured
    root = logging.getLogger()
    if _configured:
        root.setLevel(getattr(logging, level.upper(), logging.INFO))
        return root

    os.makedirs(_LOG_DIR, exist_ok=True)
    root.setLevel(getattr(logging, level.upper(), logging.INFO))

    fmt = logging.Formatter(
        "%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    file_handler = RotatingFileHandler(
        _LOG_PATH, maxBytes=5 * 1024 * 1024, backupCount=3, encoding="utf-8"
    )
    file_handler.setFormatter(fmt)

    console = logging.StreamHandler()
    console.setFormatter(fmt)

    root.addHandler(file_handler)
    root.addHandler(console)
    root.addHandler(_RingBufferHandler())

    _configured = True
    return root


def get_logger(name: str = "audora") -> logging.Logger:
    return logging.getLogger(name)


def get_recent_logs(limit: int = 200) -> List[Dict[str, str]]:
    return list(_RECENT)[-limit:]


def register_log_callback(cb: Callable[[Dict[str, str]], None]) -> None:
    if cb not in _CALLBACKS:
        _CALLBACKS.append(cb)


def unregister_log_callback(cb: Callable[[Dict[str, str]], None]) -> None:
    if cb in _CALLBACKS:
        _CALLBACKS.remove(cb)
