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
# Offline (§Part 3) — its own code, not folded into dns_failure.
#
# DNS can fail while the machine is online (bad resolver, blocked port 53),
# whereas offline means nothing is reachable at all. They need different
# treatment: only offline should raise "Please connect to the internet", and
# it must auto-retry so setup resumes by itself once connectivity returns.
# ---------------------------------------------------------------------------

def test_offline_is_transient_so_setup_retries_when_back_online():
    assert is_transient(ErrorCode.OFFLINE) is True


def test_classify_network_unreachable_as_offline():
    """Previously fell through to UNKNOWN, i.e. permanent and never retried."""
    assert classify_error("[Errno 10051] socket operation to an unreachable network") == (
        ErrorCode.OFFLINE
    )
    assert classify_error("[Errno 101] Network is unreachable") == ErrorCode.OFFLINE


def test_classify_connection_failure_as_offline():
    assert classify_error(
        "Failed to establish a new connection: [Errno 11001]"
    ) == ErrorCode.OFFLINE


def test_offline_has_a_user_facing_message():
    from setup_manager import _CODE_MESSAGES

    message = _CODE_MESSAGES[ErrorCode.OFFLINE]
    assert message, "offline needs its own actionable message"
    assert "internet" in message.lower()


def test_dns_failure_while_online_stays_dns_failure(monkeypatch):
    """No false positives: a resolver problem is not an offline condition."""
    mgr, _dm = _make_mgr(monkeypatch)
    monkeypatch.setattr(setup_manager.docker_mgr, "check_internet", lambda: True)

    code = mgr._refine_network_error(ErrorCode.DNS_FAILURE)
    assert code == ErrorCode.DNS_FAILURE


def test_dns_failure_while_offline_is_reclassified_as_offline(monkeypatch):
    mgr, _dm = _make_mgr(monkeypatch)
    monkeypatch.setattr(setup_manager.docker_mgr, "check_internet", lambda: False)

    code = mgr._refine_network_error(ErrorCode.DNS_FAILURE)
    assert code == ErrorCode.OFFLINE


def test_non_network_errors_are_never_reclassified_as_offline(monkeypatch):
    """Docker down, disk full and auth denied must not raise the banner."""
    mgr, _dm = _make_mgr(monkeypatch)
    # Even with no internet at all, these keep their own codes.
    monkeypatch.setattr(setup_manager.docker_mgr, "check_internet", lambda: False)

    for code in (
        ErrorCode.DOCKER_UNRESPONSIVE,
        ErrorCode.DISK_FULL,
        ErrorCode.AUTH_DENIED,
        ErrorCode.UNKNOWN,
    ):
        assert mgr._refine_network_error(code) == code, (
            f"{code} must not be reclassified as offline"
        )


def test_offline_surfaces_the_offline_code_on_the_wire(monkeypatch):
    """The frontend keys the banner off error.code, so it must arrive."""
    mgr, dm = _make_mgr(monkeypatch)
    events = _collect(mgr)
    monkeypatch.setattr(setup_manager.docker_mgr, "check_internet", lambda: False)

    def offline_attempt():
        raise _StepFailure(
            ErrorCode.DNS_FAILURE, raw="[Errno 11001] getaddrinfo failed"
        )

    ok = mgr._run_step_with_retry(
        "pull_downloader", offline_attempt, "Pulling...", sleep=_NOSLEEP
    )

    assert ok is False
    errors = [event for event in events if event["status"] == "error"]
    assert len(errors) == 1
    assert errors[0]["error"]["code"] == ErrorCode.OFFLINE
    assert errors[0]["error"]["transient"] is True


def test_provisioned_system_never_reports_offline(monkeypatch):
    """No network is needed when both images exist, so no banner."""
    mgr, dm = _make_mgr(monkeypatch)
    events = _collect(mgr)
    monkeypatch.setattr(dm, "image_exists", lambda name: True)
    # Deliberately offline — it must not matter.
    monkeypatch.setattr(setup_manager.docker_mgr, "check_internet", lambda: False)
    monkeypatch.setattr(dm, "check_dns", lambda host: False)

    mgr._run_image_setup_blocking(sleep=_NOSLEEP)

    assert not [event for event in events if event["status"] == "error"], (
        "a fully-provisioned start demanded internet it does not need"
    )
    assert mgr.get_step_state("complete") == StepState.SUCCESS


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

    mgr._run_image_setup_blocking(sleep=_NOSLEEP)

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


# ---------------------------------------------------------------------------
# Automated wrapper build — download + extract + generate + build
#
# The wrapper image is built fully automatically from the upstream
# WorldObservationLog/wrapper release. It must NEVER require a user-supplied
# local Dockerfile or a Settings path: the old behaviour surfaced
# "Wrapper Dockerfile not found; set it in Settings and retry." and dead-ended
# the wizard. All network and Docker calls are mocked here, so these run with
# no daemon and no internet.
# ---------------------------------------------------------------------------

def _stub_wrapper_io(monkeypatch, mgr, *, downloaded=None, extracted=None):
    """Stub the download+extract halves so only orchestration is exercised."""
    calls = {"download": [], "extract": [], "build": []}

    def fake_download(url, dest):
        calls["download"].append((url, dest))
        if downloaded is not None:
            downloaded(url, dest)

    def fake_extract(archive, dest):
        calls["extract"].append((archive, dest))
        if extracted is not None:
            extracted(archive, dest)

    def fake_build(context):
        calls["build"].append(context)

    monkeypatch.setattr(mgr, "_download_file", fake_download)
    monkeypatch.setattr(mgr, "_extract_archive", fake_extract)
    monkeypatch.setattr(mgr, "_docker_build_wrapper", fake_build)
    return calls


def test_wrapper_build_is_idempotent_when_image_present(monkeypatch, tmp_path):
    """Image already present -> straight to success, no download/extract/build."""
    mgr, dm = _make_mgr(monkeypatch)
    monkeypatch.setattr(dm, "image_exists", lambda name: True)
    monkeypatch.setattr(mgr, "_wrapper_work_dir", lambda: str(tmp_path))
    calls = _stub_wrapper_io(monkeypatch, mgr)

    mgr._build_wrapper_step()

    assert calls["download"] == [], "must not re-download an existing image"
    assert calls["extract"] == [], "must not re-extract an existing image"
    assert calls["build"] == [], "must not rebuild an existing image"


def test_wrapper_build_emits_progress_for_each_stage(monkeypatch, tmp_path):
    """Each stage emits a setup_progress event in the canonical schema."""
    mgr, dm = _make_mgr(monkeypatch)
    events = _collect(mgr)
    monkeypatch.setattr(dm, "image_exists", lambda name: False)
    monkeypatch.setattr(mgr, "_wrapper_work_dir", lambda: str(tmp_path))
    _stub_wrapper_io(monkeypatch, mgr)

    mgr._build_wrapper_step()

    wrapper_events = [e for e in events if e["step"] == "build_wrapper"]
    assert wrapper_events, "expected build_wrapper progress events"
    # Same schema as pull_downloader: type/step/status/message on every event.
    for e in wrapper_events:
        assert e["type"] == "setup_progress"
        assert e["step"] == "build_wrapper"
        assert e["status"] in ("pending", "running", "done", "error")
        assert isinstance(e["message"], str)

    blob = " ".join(e["message"].lower() for e in wrapper_events)
    for stage in ("download", "extract", "dockerfile", "build"):
        assert stage in blob, f"no progress event narrating the {stage!r} stage"


def test_wrapper_build_generates_exact_dockerfile(monkeypatch, tmp_path):
    """The generated Dockerfile is written to the build context verbatim."""
    mgr, dm = _make_mgr(monkeypatch)
    monkeypatch.setattr(dm, "image_exists", lambda name: False)
    monkeypatch.setattr(mgr, "_wrapper_work_dir", lambda: str(tmp_path))
    _stub_wrapper_io(monkeypatch, mgr)

    mgr._build_wrapper_step()

    dockerfile = tmp_path / "Dockerfile"
    assert dockerfile.exists(), "Dockerfile was not generated"
    content = dockerfile.read_text(encoding="utf-8")
    assert content == setup_manager.WRAPPER_DOCKERFILE
    # The pinned, known-working content.
    assert "FROM ubuntu:latest" in content
    assert "WORKDIR /app" in content
    assert "COPY . /app" in content
    assert 'CMD ["bash", "-c", "./wrapper ${args}"]' in content
    assert "EXPOSE 10020 20020" in content
    # Windows zip extraction drops the exec bit, so the build must restore it.
    assert "chmod +x" in content


def test_generated_dockerfile_overwrites_the_archives_own(monkeypatch, tmp_path):
    """The release zip ships its own Dockerfile; ours must win."""
    mgr, dm = _make_mgr(monkeypatch)
    monkeypatch.setattr(dm, "image_exists", lambda name: False)
    monkeypatch.setattr(mgr, "_wrapper_work_dir", lambda: str(tmp_path))

    def drop_upstream_dockerfile(archive, dest):
        # Simulate extraction shipping upstream's debian-based Dockerfile.
        (tmp_path / "Dockerfile").write_text("FROM debian:13.2\n", encoding="utf-8")

    _stub_wrapper_io(monkeypatch, mgr, extracted=drop_upstream_dockerfile)

    mgr._build_wrapper_step()

    content = (tmp_path / "Dockerfile").read_text(encoding="utf-8")
    assert "debian" not in content, "upstream Dockerfile was not overwritten"
    assert content == setup_manager.WRAPPER_DOCKERFILE


def test_wrapper_build_ordering_is_download_extract_generate_build(monkeypatch, tmp_path):
    """Dockerfile must be generated AFTER extraction, or the zip overwrites it."""
    mgr, dm = _make_mgr(monkeypatch)
    monkeypatch.setattr(dm, "image_exists", lambda name: False)
    monkeypatch.setattr(mgr, "_wrapper_work_dir", lambda: str(tmp_path))
    order = []

    def note_download(url, dest):
        order.append("download")

    def note_extract(archive, dest):
        order.append("extract")

    monkeypatch.setattr(mgr, "_download_file", note_download)
    monkeypatch.setattr(mgr, "_extract_archive", note_extract)

    def note_build(context):
        # Dockerfile must already be on disk by build time.
        assert (tmp_path / "Dockerfile").exists()
        order.append("build")

    monkeypatch.setattr(mgr, "_docker_build_wrapper", note_build)

    real_write = mgr._write_dockerfile

    def note_write(context):
        order.append("generate")
        return real_write(context)

    monkeypatch.setattr(mgr, "_write_dockerfile", note_write)

    mgr._build_wrapper_step()

    assert order == ["download", "extract", "generate", "build"]


def test_wrapper_download_failure_is_classified_and_retried(monkeypatch, tmp_path):
    """A network failure raises a classified _StepFailure the retry loop sees."""
    mgr, dm = _make_mgr(monkeypatch)
    events = _collect(mgr)
    monkeypatch.setattr(dm, "image_exists", lambda name: False)
    monkeypatch.setattr(mgr, "_wrapper_work_dir", lambda: str(tmp_path))
    calls = _stub_wrapper_io(monkeypatch, mgr)
    attempts = {"n": 0}

    def failing_download(url, dest):
        attempts["n"] += 1
        raise OSError("connection reset by peer")

    monkeypatch.setattr(mgr, "_download_file", failing_download)
    slept = []

    ok = mgr._run_step_with_retry(
        "build_wrapper",
        mgr._build_wrapper_step,
        "Building wrapper image...",
        sleep=slept.append,
    )

    assert ok is False
    # "connection reset" classifies as transient -> auto-retried, then surfaced.
    assert attempts["n"] == 4, "expected 1 attempt + 3 silent retries"
    assert slept == [2, 5, 10]
    errs = [e for e in events if e["status"] == "error"]
    assert len(errs) == 1
    assert errs[0]["error"]["code"] == ErrorCode.REGISTRY_UNAVAILABLE
    assert errs[0]["error"]["transient"] is True


def test_wrapper_build_never_asks_for_a_settings_dockerfile(monkeypatch, tmp_path):
    """Regression: the old dead-end error must never be emitted again."""
    mgr, dm = _make_mgr(monkeypatch)
    events = _collect(mgr)
    monkeypatch.setattr(dm, "image_exists", lambda name: False)
    monkeypatch.setattr(mgr, "_wrapper_work_dir", lambda: str(tmp_path))
    _stub_wrapper_io(monkeypatch, mgr)

    def fake_pull(image, on_progress):
        return True

    monkeypatch.setattr(dm, "pull_image_streaming", fake_pull)

    mgr._run_image_setup_blocking(sleep=_NOSLEEP)

    blob = " ".join(e.get("message", "") for e in events)
    assert "Settings" not in blob
    assert "Dockerfile not found" not in blob
    assert mgr.get_step_state("build_wrapper") == StepState.SUCCESS
    assert mgr.get_step_state("complete") == StepState.SUCCESS


def test_wrapper_archive_is_not_left_in_the_build_context(monkeypatch, tmp_path):
    """The 48MB zip must not survive into `COPY . /app` and bloat the image."""
    mgr, dm = _make_mgr(monkeypatch)
    monkeypatch.setattr(dm, "image_exists", lambda name: False)
    monkeypatch.setattr(mgr, "_wrapper_work_dir", lambda: str(tmp_path))

    archive_name = setup_manager.WRAPPER_ASSET_NAME

    def fake_download(url, dest):
        # Land a stand-in archive exactly where the real download would.
        with open(dest, "wb") as f:
            f.write(b"PK\x03\x04 not-a-real-zip")

    monkeypatch.setattr(mgr, "_download_file", fake_download)
    monkeypatch.setattr(mgr, "_extract_archive", lambda a, d: None)
    monkeypatch.setattr(mgr, "_docker_build_wrapper", lambda c: None)

    mgr._build_wrapper_step()

    assert not (tmp_path / archive_name).exists(), (
        "the downloaded archive was left in the build context"
    )
    # The generated Dockerfile is still there — cleanup is surgical.
    assert (tmp_path / "Dockerfile").exists()


# ---------------------------------------------------------------------------
# Re-running setup must still reach a terminal status (v1.4.0 hang)
#
# The wizard hung forever at "Finishing setup..." on a fully-provisioned
# system. Root cause: ``setup_mgr`` is a module-level singleton whose
# ``_step_states`` was never reset, so on a SECOND run every step was already
# SUCCESS — a terminal state with an empty allowed-transition set. The
# non-changing SUCCESS emits were then suppressed by ``_emit_state``, while
# RUNNING emits are deliberately exempt from that suppression. Net effect: the
# stream announced work starting and never reported it finishing, and the
# frontend (which strictly requires ``status === "done"``) waited forever.
#
# These tests assert on the EMITTED event statuses that actually reach the
# WebSocket, not on internal ``get_step_state()``. That distinction is exactly
# what the pre-existing coverage missed.
# ---------------------------------------------------------------------------

_ALL_SETUP_STEPS = ("pull_downloader", "build_wrapper", "complete")


def _provisioned_mgr(monkeypatch):
    """A manager on a fully-provisioned system: both images already present."""
    mgr, dm = _make_mgr(monkeypatch)
    monkeypatch.setattr(dm, "image_exists", lambda name: True)

    def should_not_pull(image, on_progress):
        raise AssertionError("must not pull when the image is already present")

    monkeypatch.setattr(dm, "pull_image_streaming", should_not_pull)
    return mgr, dm


def test_rerun_on_provisioned_system_still_emits_terminal_statuses(monkeypatch):
    """The regression: a second run must not go terminal-less."""
    mgr, _dm = _provisioned_mgr(monkeypatch)
    events = _collect(mgr)

    # First run — this one always worked.
    mgr._run_image_setup_blocking(sleep=_NOSLEEP)
    first_run_done = [e for e in events if e["status"] == "done"]
    assert len(first_run_done) == 3, "sanity: the first run should emit 3 terminal frames"

    # Second run in the SAME manager — the real-world singleton case.
    events.clear()
    mgr._run_image_setup_blocking(sleep=_NOSLEEP)

    assert events, "the second run emitted nothing at all"
    # Every step must reach a terminal status on the wire, not just internally.
    for step in _ALL_SETUP_STEPS:
        statuses = _statuses(events, step)
        assert statuses, f"no events at all for {step!r} on the re-run"
        assert statuses[-1] == "done", (
            f"{step!r} never reached a terminal status on the re-run "
            f"(got {statuses!r}) — the wizard would spin forever"
        )


def test_rerun_emits_complete_done_so_the_wizard_can_advance(monkeypatch):
    """`complete`/done is the only signal the wizard has that setup finished."""
    mgr, _dm = _provisioned_mgr(monkeypatch)
    events = _collect(mgr)

    mgr._run_image_setup_blocking(sleep=_NOSLEEP)
    events.clear()
    mgr._run_image_setup_blocking(sleep=_NOSLEEP)

    complete_statuses = _statuses(events, "complete")
    assert "done" in complete_statuses, (
        "step 'complete' never reached done on the re-run; the wizard's "
        "Continue button stays disabled forever"
    )


def test_rerun_matches_the_first_runs_emitted_sequence(monkeypatch):
    """A re-run on unchanged inputs should look identical on the wire."""
    mgr, _dm = _provisioned_mgr(monkeypatch)
    events = _collect(mgr)

    mgr._run_image_setup_blocking(sleep=_NOSLEEP)
    first = [(e["step"], e["status"]) for e in events]

    events.clear()
    mgr._run_image_setup_blocking(sleep=_NOSLEEP)
    second = [(e["step"], e["status"]) for e in events]

    assert second == first, (
        "the re-run's event sequence diverged from the first run's:\n"
        f"  first : {first}\n"
        f"  second: {second}"
    )


def test_frontend_advance_predicate_is_satisfied_on_rerun(monkeypatch):
    """Mirror the frontend's actual gate: both image steps must be 'done'.

    SetupWizard.tsx computes
        bothDone = steps['pull_downloader'].status === 'done'
                && steps['build_wrapper'].status === 'done'
    reducing events keyed by step so the LAST frame per step wins. Reproduce
    that reduction here so the backend contract is tested the way the UI
    actually consumes it.
    """
    mgr, _dm = _provisioned_mgr(monkeypatch)
    events = _collect(mgr)

    mgr._run_image_setup_blocking(sleep=_NOSLEEP)
    events.clear()
    mgr._run_image_setup_blocking(sleep=_NOSLEEP)

    # The frontend's reducer: latest frame per step overwrites earlier ones.
    reduced = {}
    for event in events:
        reduced[event["step"]] = event["status"]

    both_done = (
        reduced.get("pull_downloader") == "done"
        and reduced.get("build_wrapper") == "done"
    )
    assert both_done, (
        f"the wizard's advance predicate is still false after a re-run: {reduced}"
    )


def test_repeated_runs_stay_terminal(monkeypatch):
    """Not just the second run — the fifth must work too."""
    mgr, _dm = _provisioned_mgr(monkeypatch)
    events = _collect(mgr)

    for run_index in range(1, 6):
        events.clear()
        mgr._run_image_setup_blocking(sleep=_NOSLEEP)
        for step in _ALL_SETUP_STEPS:
            statuses = _statuses(events, step)
            assert statuses and statuses[-1] == "done", (
                f"run #{run_index}: {step!r} ended at {statuses!r}, not 'done'"
            )


# ---------------------------------------------------------------------------
# The ws/setup message field is rendered verbatim in the UI terminal panel,
# so it must never carry credentials even when the underlying error does.
# ---------------------------------------------------------------------------

def test_emitted_messages_never_carry_credentials(monkeypatch):
    mgr, _dm = _make_mgr(monkeypatch)
    events = _collect(mgr)

    secret_password = "hunter2SuperSecret"
    secret_email = "victim@icloud.com"

    def leaky_attempt():
        # A raw error carrying credentials, as a real docker failure might.
        raise _StepFailure(
            ErrorCode.UNKNOWN,
            raw=f"docker run -L {secret_email}:{secret_password} failed",
        )

    mgr._run_step_with_retry(
        "build_wrapper", leaky_attempt, "Building wrapper image...", sleep=_NOSLEEP
    )

    on_the_wire = " ".join(event.get("message", "") for event in events)
    assert secret_password not in on_the_wire
    assert secret_email not in on_the_wire
    # The user still gets an actionable message, not a blank.
    assert on_the_wire.strip(), "redaction must not blank the narration"


def test_run_image_setup_takes_no_build_context_argument():
    """The Settings-based wrapper_build_context parameter is gone for good."""
    import inspect

    for fn in (SetupManager.run_image_setup, SetupManager._run_image_setup_blocking):
        params = inspect.signature(fn).parameters
        assert "wrapper_build_context" not in params, (
            f"{fn.__name__} still accepts a Settings-supplied build context"
        )

