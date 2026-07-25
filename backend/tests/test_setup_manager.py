"""Unit tests for setup_manager.py — state machine, auto-retry, taxonomy.

All Docker interaction is mocked, so these pass with no Docker daemon and no
``docker`` python lib installed. Backoff ``sleep`` is injected/patched so the
retry tests run instantly.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import setup_manager  # noqa: E402
from setup_manager import (  # noqa: E402
    SetupManager,
    StepState,
    ErrorCode,
    classify_error,
    is_transient,
    _StepFailure,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_mgr(monkeypatch, *, docker_ok=True, dns_ok=True, disk_ok=True):
    """A SetupManager with docker_mgr preflight helpers stubbed to pass."""
    mgr = SetupManager()
    dm = setup_manager.docker_mgr
    monkeypatch.setattr(dm, "is_docker_api_responsive", lambda: docker_ok)
    monkeypatch.setattr(dm, "check_dns", lambda host: dns_ok)
    monkeypatch.setattr(dm, "check_disk_space", lambda path, need: disk_ok)
    # Default: images absent, disk target is cwd (exists).
    monkeypatch.setattr(dm, "image_exists", lambda name: False)
    monkeypatch.setattr(mgr, "_disk_target", lambda: os.getcwd())
    return mgr, dm


def _collect(mgr):
    events = []
    mgr.register_progress_callback(events.append)
    return events


def _statuses(events, step):
    return [e["status"] for e in events if e["step"] == step]


_NOSLEEP = lambda _s: None  # injected backoff sleep — never actually waits


# ---------------------------------------------------------------------------
# Error taxonomy (§7.1) + transient/permanent classification (§6.3)
# ---------------------------------------------------------------------------

def test_classify_rate_limit_is_transient():
    assert classify_error("toomanyrequests: 429 rate limit") == ErrorCode.REGISTRY_RATE_LIMIT
    assert is_transient(ErrorCode.REGISTRY_RATE_LIMIT) is True


def test_classify_dns_is_transient():
    assert classify_error("failed to resolve ghcr.io: getaddrinfo") == ErrorCode.DNS_FAILURE
    assert is_transient(ErrorCode.DNS_FAILURE) is True


def test_classify_disk_full_is_permanent():
    assert classify_error("write /layer: no space left on device") == ErrorCode.DISK_FULL
    assert is_transient(ErrorCode.DISK_FULL) is False


def test_classify_auth_is_permanent():
    assert classify_error("unauthorized: authentication required (401)") == ErrorCode.AUTH_DENIED
    assert is_transient(ErrorCode.AUTH_DENIED) is False


def test_classify_registry_5xx_is_transient():
    assert classify_error("received unexpected HTTP 503 from registry") == ErrorCode.REGISTRY_UNAVAILABLE
    assert is_transient(ErrorCode.REGISTRY_UNAVAILABLE) is True


def test_classify_docker_unresponsive_is_transient():
    assert classify_error("cannot connect to the Docker daemon via pipe") == ErrorCode.DOCKER_UNRESPONSIVE
    assert is_transient(ErrorCode.DOCKER_UNRESPONSIVE) is True


def test_classify_unknown_is_permanent():
    assert classify_error("something weird happened") == ErrorCode.UNKNOWN
    assert is_transient(ErrorCode.UNKNOWN) is False


# ---------------------------------------------------------------------------
# State machine (§6.1)
# ---------------------------------------------------------------------------

def test_happy_path_pending_running_success(monkeypatch):
    mgr, dm = _make_mgr(monkeypatch)
    events = _collect(mgr)

    # A pull that succeeds immediately via a no-error stream.
    def fake_stream(image, on_progress):
        on_progress({"status": "Downloading", "progressDetail": {"current": 100, "total": 100}, "id": "L1"})
        return True

    monkeypatch.setattr(dm, "pull_image_streaming", fake_stream)

    assert mgr.get_step_state("pull_downloader") == StepState.PENDING
    ok = mgr._run_step_with_retry(
        "pull_downloader",
        lambda: mgr._pull_image_step("pull_downloader", "img", os.getcwd()),
        "Pulling...",
        sleep=_NOSLEEP,
    )
    mgr._emit_state("pull_downloader", StepState.SUCCESS, "Pulled")

    assert ok is True
    assert mgr.get_step_state("pull_downloader") == StepState.SUCCESS
    # Emitted statuses map SUCCESS -> "done", RUNNING -> "running".
    statuses = _statuses(events, "pull_downloader")
    assert statuses[0] == "running"
    assert statuses[-1] == "done"


def test_failed_then_running_then_success_on_retry(monkeypatch):
    mgr, dm = _make_mgr(monkeypatch)
    _collect(mgr)

    attempts = {"n": 0}

    def flaky_stream(image, on_progress):
        attempts["n"] += 1
        if attempts["n"] == 1:
            on_progress({"error": "HTTP 503 from registry"})
            return False
        return True

    monkeypatch.setattr(dm, "pull_image_streaming", flaky_stream)

    ok = mgr._run_step_with_retry(
        "pull_downloader",
        lambda: mgr._pull_image_step("pull_downloader", "img", os.getcwd()),
        "Pulling...",
        sleep=_NOSLEEP,
    )
    assert ok is True  # recovered on 2nd attempt
    assert attempts["n"] == 2
    # State machine returned to RUNNING (never emitted a FAILED to the user).
    assert mgr.get_step_state("pull_downloader") == StepState.RUNNING


# ---------------------------------------------------------------------------
# Auto-retry with backoff (§6.2)
# ---------------------------------------------------------------------------

def test_transient_recovers_on_third_attempt(monkeypatch):
    mgr, dm = _make_mgr(monkeypatch)
    events = _collect(mgr)
    slept = []
    attempts = {"n": 0}

    def flaky_stream(image, on_progress):
        attempts["n"] += 1
        if attempts["n"] < 3:
            on_progress({"error": "toomanyrequests 429"})
            return False
        return True

    monkeypatch.setattr(dm, "pull_image_streaming", flaky_stream)

    ok = mgr._run_step_with_retry(
        "pull_downloader",
        lambda: mgr._pull_image_step("pull_downloader", "img", os.getcwd()),
        "Pulling...",
        sleep=slept.append,
    )
    assert ok is True
    assert attempts["n"] == 3
    # Backoff invoked twice (before attempt 2 and 3), in schedule order.
    assert slept == [2, 5]
    # No error event ever surfaced to the user.
    assert all("error" not in e for e in events)


def test_transient_surfaces_after_exactly_three_retries(monkeypatch):
    mgr, dm = _make_mgr(monkeypatch)
    events = _collect(mgr)
    slept = []
    attempts = {"n": 0}

    def always_transient(image, on_progress):
        attempts["n"] += 1
        on_progress({"error": "toomanyrequests 429"})
        return False

    monkeypatch.setattr(dm, "pull_image_streaming", always_transient)

    ok = mgr._run_step_with_retry(
        "pull_downloader",
        lambda: mgr._pull_image_step("pull_downloader", "img", os.getcwd()),
        "Pulling...",
        sleep=slept.append,
    )
    assert ok is False
    # 1 initial attempt + exactly 3 retries.
    assert attempts["n"] == 4
    assert slept == [2, 5, 10]
    # Surfaced a classified error exactly once.
    errs = [e for e in events if e["status"] == "error"]
    assert len(errs) == 1
    assert errs[0]["error"]["code"] == ErrorCode.REGISTRY_RATE_LIMIT
    assert errs[0]["error"]["transient"] is True
    assert mgr.get_step_state("pull_downloader") == StepState.FAILED


def test_permanent_failure_surfaces_immediately_no_retry(monkeypatch):
    mgr, dm = _make_mgr(monkeypatch)
    events = _collect(mgr)
    slept = []
    attempts = {"n": 0}

    def disk_full(image, on_progress):
        attempts["n"] += 1
        on_progress({"error": "no space left on device"})
        return False

    monkeypatch.setattr(dm, "pull_image_streaming", disk_full)

    ok = mgr._run_step_with_retry(
        "pull_downloader",
        lambda: mgr._pull_image_step("pull_downloader", "img", os.getcwd()),
        "Pulling...",
        sleep=slept.append,
    )
    assert ok is False
    assert attempts["n"] == 1  # no retries
    assert slept == []  # backoff never invoked
    errs = [e for e in events if e["status"] == "error"]
    assert len(errs) == 1
    assert errs[0]["error"]["code"] == ErrorCode.DISK_FULL
    assert errs[0]["error"]["transient"] is False


# ---------------------------------------------------------------------------
# Real streaming progress (§3.3, §5.4) — never fabricated
# ---------------------------------------------------------------------------

def test_emitted_percent_reflects_aggregated_real_bytes(monkeypatch):
    mgr, dm = _make_mgr(monkeypatch)
    events = _collect(mgr)

    # Two layers: A total 200, B total 200. Aggregate total 400.
    def multilayer(image, on_progress):
        on_progress({"status": "Downloading", "progressDetail": {"current": 100, "total": 200}, "id": "A"})
        # A=100/200, no B yet -> 100/200 = 50%
        on_progress({"status": "Downloading", "progressDetail": {"current": 100, "total": 200}, "id": "B"})
        # A=100,B=100 of 400 -> 50%
        on_progress({"status": "Downloading", "progressDetail": {"current": 200, "total": 200}, "id": "A"})
        # A=200,B=100 of 400 -> 75%
        on_progress({"status": "Downloading", "progressDetail": {"current": 200, "total": 200}, "id": "B"})
        # A=200,B=200 of 400 -> 100%
        return True

    monkeypatch.setattr(dm, "pull_image_streaming", multilayer)

    mgr._pull_image_step("pull_downloader", "img", os.getcwd())

    prog_events = [e for e in events if "progress" in e]
    assert prog_events, "expected progress events with real byte counts"
    percents = [e["percent"] for e in prog_events]
    # Real aggregation: 50, 50, 75, 100 — driven purely by streamed bytes.
    assert percents == [50, 50, 75, 100]
    last = prog_events[-1]
    assert last["progress"] == {"current": 400, "total": 400}
    assert last["percent"] == 100


def test_progress_ignores_events_without_byte_detail(monkeypatch):
    mgr, dm = _make_mgr(monkeypatch)
    events = _collect(mgr)

    def stream(image, on_progress):
        on_progress({"status": "Pulling from library/img", "id": "latest"})  # no detail
        on_progress({"status": "Pull complete", "id": "A"})  # no detail
        on_progress({"status": "Downloading", "progressDetail": {"current": 5, "total": 10}, "id": "A"})
        return True

    monkeypatch.setattr(dm, "pull_image_streaming", stream)
    mgr._pull_image_step("pull_downloader", "img", os.getcwd())

    prog_events = [e for e in events if "progress" in e]
    # Only the one event carrying real byte detail produced a progress emit.
    assert len(prog_events) == 1
    assert prog_events[0]["percent"] == 50


# ---------------------------------------------------------------------------
# Idempotency (§6.4)
# ---------------------------------------------------------------------------

def test_pull_step_noop_success_when_image_present(monkeypatch):
    mgr, dm = _make_mgr(monkeypatch)
    events = _collect(mgr)
    monkeypatch.setattr(dm, "image_exists", lambda name: True)

    called = {"streamed": False, "preflight": False}

    def should_not_stream(image, on_progress):
        called["streamed"] = True
        return True

    monkeypatch.setattr(dm, "pull_image_streaming", should_not_stream)
    monkeypatch.setattr(mgr, "_preflight", lambda t: called.__setitem__("preflight", True))

    # No exception -> caller treats as success; no pull, no preflight.
    mgr._pull_image_step("pull_downloader", "img", os.getcwd())
    assert called["streamed"] is False
    assert called["preflight"] is False


def test_run_image_setup_all_present_is_noop_success(monkeypatch):
    mgr, dm = _make_mgr(monkeypatch)
    events = _collect(mgr)
    monkeypatch.setattr(dm, "image_exists", lambda name: True)

    def should_not_stream(image, on_progress):
        raise AssertionError("pull should not run when image present")

    monkeypatch.setattr(dm, "pull_image_streaming", should_not_stream)

    mgr._run_image_setup_blocking(wrapper_build_context=None, sleep=_NOSLEEP)

    # Reached completion via no-op successes for both images.
    assert mgr.get_step_state("pull_downloader") == StepState.SUCCESS
    assert mgr.get_step_state("build_wrapper") == StepState.SUCCESS
    assert mgr.get_step_state("complete") == StepState.SUCCESS
    assert _statuses(events, "complete")[-1] == "done"


def test_recompleting_done_step_is_noop(monkeypatch):
    mgr, _dm = _make_mgr(monkeypatch)
    events = _collect(mgr)
    # Drive to SUCCESS.
    mgr._set_state("pull_downloader", StepState.RUNNING)
    mgr._emit_state("pull_downloader", StepState.SUCCESS, "Pulled")
    n_before = len(events)
    # Re-completing an already-complete step is a no-op transition.
    mgr._emit_state("pull_downloader", StepState.SUCCESS, "Pulled again")
    assert mgr.get_step_state("pull_downloader") == StepState.SUCCESS
    # No duplicate event for the redundant same-state transition.
    assert len(events) == n_before


# ---------------------------------------------------------------------------
# Preflight failures (§7.2) — each emits the correct taxonomy code
# ---------------------------------------------------------------------------

def test_preflight_docker_down_emits_code(monkeypatch):
    mgr, dm = _make_mgr(monkeypatch, docker_ok=False)
    events = _collect(mgr)
    monkeypatch.setattr(dm, "pull_image_streaming", lambda i, p: True)

    # Docker down is transient -> surfaces only after retries exhausted.
    ok = mgr._run_step_with_retry(
        "pull_downloader",
        lambda: mgr._pull_image_step("pull_downloader", "img", os.getcwd()),
        "Pulling...",
        sleep=_NOSLEEP,
    )
    assert ok is False
    errs = [e for e in events if e["status"] == "error"]
    assert errs[-1]["error"]["code"] == ErrorCode.DOCKER_UNRESPONSIVE


def test_preflight_dns_fail_emits_code(monkeypatch):
    mgr, dm = _make_mgr(monkeypatch, dns_ok=False)
    events = _collect(mgr)
    monkeypatch.setattr(dm, "pull_image_streaming", lambda i, p: True)

    ok = mgr._run_step_with_retry(
        "pull_downloader",
        lambda: mgr._pull_image_step("pull_downloader", "img", os.getcwd()),
        "Pulling...",
        sleep=_NOSLEEP,
    )
    assert ok is False
    errs = [e for e in events if e["status"] == "error"]
    assert errs[-1]["error"]["code"] == ErrorCode.DNS_FAILURE


def test_preflight_disk_full_emits_code_immediately(monkeypatch):
    mgr, dm = _make_mgr(monkeypatch, disk_ok=False)
    events = _collect(mgr)
    monkeypatch.setattr(dm, "pull_image_streaming", lambda i, p: True)
    slept = []

    ok = mgr._run_step_with_retry(
        "pull_downloader",
        lambda: mgr._pull_image_step("pull_downloader", "img", os.getcwd()),
        "Pulling...",
        sleep=slept.append,
    )
    assert ok is False
    assert slept == []  # disk full is permanent -> no retry
    errs = [e for e in events if e["status"] == "error"]
    assert errs[-1]["error"]["code"] == ErrorCode.DISK_FULL
    assert errs[-1]["error"]["transient"] is False


# ---------------------------------------------------------------------------
# Event-shape preservation (existing keys/status values intact)
# ---------------------------------------------------------------------------

def test_emit_preserves_existing_event_shape(monkeypatch):
    mgr, _dm = _make_mgr(monkeypatch)
    events = _collect(mgr)
    mgr._emit("pull_downloader", "running", "hi", percent=42)
    e = events[-1]
    assert e["type"] == "setup_progress"
    assert e["step"] == "pull_downloader"
    assert e["status"] == "running"
    assert e["message"] == "hi"
    assert e["percent"] == 42
    # Additive keys absent when not provided.
    assert "progress" not in e
    assert "error" not in e


def test_emit_state_maps_states_to_existing_status_values():
    mgr = SetupManager()
    events = _collect(mgr)
    mgr._emit_state("s", StepState.RUNNING, "")
    mgr._emit_state("s", StepState.SUCCESS, "")
    statuses = [e["status"] for e in events]
    assert statuses == ["running", "done"]  # never "success"/"failed" on the wire
