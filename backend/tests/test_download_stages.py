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
