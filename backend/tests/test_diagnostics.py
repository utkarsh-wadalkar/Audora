"""Redaction / robustness tests for diagnostics.py (Workstream F, §8.2, §12).

The hard requirement (QC_plan.md §8.2, §12): the diagnostic bundle must NEVER
contain secrets. These tests seed the source data (backend logs + the most
recently failed setup step) with a fake Apple ID email, a password, a
``-L user:pass`` arg and a bearer token, then assert none of those literal
values appear ANYWHERE in the returned bundle (structured fields or the
copyable text block).

All Docker / WSL / OS calls are mocked, so this runs with no Docker daemon,
no ``docker`` python lib, and passes cross-platform.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import logging  # noqa: E402

import diagnostics  # noqa: E402
import logger as logger_module  # noqa: E402
import setup_manager  # noqa: E402
from setup_manager import StepState  # noqa: E402


# --- Secret values that must never appear in the bundle ---------------------
SECRET_EMAIL = "victim.appleid@icloud.com"
SECRET_PASSWORD = "SuperSecretHunter2"
SECRET_LOGIN_ARG = f"-L {SECRET_EMAIL}:{SECRET_PASSWORD}"
SECRET_TOKEN = "ghp_ABCDEF1234567890abcdef"
_ALL_SECRETS = [SECRET_EMAIL, SECRET_PASSWORD, SECRET_TOKEN, "SuperSecretHunter2"]


def test_diagnostics_tracks_every_setup_step_in_orchestration_order():
    """Diagnostics must include the FLAC image step, not the old 3-step list."""
    assert tuple(diagnostics._SETUP_STEPS) == setup_manager.SETUP_STEPS


def _flatten(bundle) -> str:
    """Every string in the bundle concatenated, for a single membership check."""
    parts = [str(bundle.get("report", ""))]
    for line in bundle.get("recent_logs") or []:
        parts.append(str(line))
    fs = bundle.get("failed_step")
    if fs:
        parts.append(str(fs.get("step", "")))
        parts.append(str(fs.get("error", "")))
    parts.append(str(bundle.get("docker_version", "")))
    parts.append(str(bundle.get("wsl_status", "")))
    parts.append(str(bundle.get("os_build", "")))
    return "\n".join(parts)


def _mock_external(monkeypatch):
    """No Docker, no WSL, deterministic OS — cross-platform + no daemon."""
    monkeypatch.setattr(diagnostics.docker_mgr, "get_client", lambda: None)
    monkeypatch.setattr(diagnostics, "_wsl_status", lambda: "unavailable")
    monkeypatch.setattr(diagnostics, "_os_build", lambda: "Windows 11 (build 10.0.26200)")


def _seed_failed_step_with_secrets(monkeypatch):
    """Put a failed step in state and a secret-laden failure line in the logs."""
    # get_step_state: only build_wrapper is FAILED (read-only introspection).
    monkeypatch.setattr(
        setup_manager.setup_mgr,
        "get_step_state",
        lambda step: StepState.FAILED if step == "build_wrapper" else StepState.PENDING,
    )
    # Seed the ring buffer as setup_manager would when surfacing a failure,
    # embedding every secret so redaction has something real to strip.
    logger_module._RECENT.clear()
    setup_log = logging.getLogger("setup")
    handler = logger_module._RingBufferHandler()
    setup_log.addHandler(handler)
    try:
        setup_log.error(
            f"[build_wrapper] surfacing failure code=unknown transient=False: "
            f"docker run {SECRET_LOGIN_ARG} failed for {SECRET_EMAIL}"
        )
        setup_log.info(f"password={SECRET_PASSWORD} token={SECRET_TOKEN}")
        setup_log.info(f"Authorization: Bearer {SECRET_TOKEN}")
    finally:
        setup_log.removeHandler(handler)


def test_bundle_contains_no_secrets(monkeypatch):
    _mock_external(monkeypatch)
    _seed_failed_step_with_secrets(monkeypatch)

    bundle = diagnostics.collect_diagnostics()
    blob = _flatten(bundle)

    for secret in _ALL_SECRETS:
        assert secret not in blob, f"secret leaked into diagnostic bundle: {secret!r}"


def test_bundle_still_reports_the_failed_step(monkeypatch):
    """Redaction must not blank the report — the failed step is still named."""
    _mock_external(monkeypatch)
    _seed_failed_step_with_secrets(monkeypatch)

    bundle = diagnostics.collect_diagnostics()

    assert bundle["failed_step"] is not None
    assert bundle["failed_step"]["step"] == "build_wrapper"
    # Redaction markers prove the secret text was present and got stripped.
    assert "<redacted" in bundle["failed_step"]["error"]
    assert "=== Audora Diagnostic Report ===" in bundle["report"]


def test_never_a_dead_end_with_no_docker_no_wsl(monkeypatch):
    """No Docker / WSL / failed step still yields a complete, copyable report."""
    monkeypatch.setattr(diagnostics.docker_mgr, "get_client", lambda: None)
    monkeypatch.setattr(diagnostics, "_wsl_status", lambda: "unavailable")
    monkeypatch.setattr(diagnostics, "_os_build", lambda: "unavailable")
    monkeypatch.setattr(
        setup_manager.setup_mgr, "get_step_state", lambda step: StepState.PENDING
    )
    logger_module._RECENT.clear()

    bundle = diagnostics.collect_diagnostics()

    assert bundle["docker_version"] == "unavailable"
    assert bundle["failed_step"] is None
    assert "=== Audora Diagnostic Report ===" in bundle["report"]
    assert "end of report" in bundle["report"]


def test_docker_version_via_sdk(monkeypatch):
    """Docker version is read from the SDK client.version() when available."""
    class _FakeClient:
        def version(self):
            return {"Version": "27.1.1", "ApiVersion": "1.46"}

    monkeypatch.setattr(diagnostics.docker_mgr, "get_client", lambda: _FakeClient())
    monkeypatch.setattr(diagnostics, "_wsl_status", lambda: "unavailable")
    monkeypatch.setattr(diagnostics, "_os_build", lambda: "unavailable")
    monkeypatch.setattr(
        setup_manager.setup_mgr, "get_step_state", lambda step: StepState.PENDING
    )

    bundle = diagnostics.collect_diagnostics()
    assert "27.1.1" in bundle["docker_version"]
    assert "1.46" in bundle["docker_version"]


# ---------------------------------------------------------------------------
# Session data from rootfs/data must not leak either
#
# The wrapper persists an authenticated session under rootfs/data (a
# kvs.sqlitedb token store, plus MUSIC_TOKEN / STOREFRONT_ID / dsid values).
# Those are not "passwords", so they need their own coverage: a bundle that
# strips the Apple ID but echoes a media-user-token is still a leak.
# ---------------------------------------------------------------------------

SESSION_SECRETS = {
    "music_token": "eyJhbGciOiJFUzI1NiJ9.SESSIONTOKENVALUE.sig",
    "media_user_token": "AwQAAAABDDDDwSESSIONMEDIATOKEN",
    "dsid": "1234567890123456",
    "bearer": "BEARERTOKENabcdef123456",
}


def _seed_session_data_in_logs():
    """Log lines shaped like the wrapper's real session/token output."""
    logger_module._RECENT.clear()
    wrapper_log = logging.getLogger("wrapper")
    handler = logger_module._RingBufferHandler()
    wrapper_log.addHandler(handler)
    try:
        wrapper_log.info(f"MUSIC_TOKEN={SESSION_SECRETS['music_token']}")
        wrapper_log.info(f"media-user-token: {SESSION_SECRETS['media_user_token']}")
        wrapper_log.info(f"loaded account dsid={SESSION_SECRETS['dsid']}")
        wrapper_log.info(f"Authorization: Bearer {SESSION_SECRETS['bearer']}")
    finally:
        wrapper_log.removeHandler(handler)


def test_session_data_from_rootfs_does_not_leak(monkeypatch):
    _mock_external(monkeypatch)
    monkeypatch.setattr(
        setup_manager.setup_mgr, "get_step_state", lambda step: StepState.PENDING
    )
    _seed_session_data_in_logs()

    blob = _flatten(diagnostics.collect_diagnostics())

    for label, secret in SESSION_SECRETS.items():
        assert secret not in blob, f"session secret leaked ({label}): {secret!r}"


# ---------------------------------------------------------------------------
# HTTP boundary — the guarantee must hold on the real endpoint response,
# not merely on collect_diagnostics() in isolation.
# ---------------------------------------------------------------------------

def test_endpoint_returns_all_expected_fields(monkeypatch):
    from fastapi.testclient import TestClient

    import app as app_module

    _mock_external(monkeypatch)
    monkeypatch.setattr(
        setup_manager.setup_mgr, "get_step_state", lambda step: StepState.PENDING
    )

    with TestClient(app_module.app) as client:
        response = client.get("/setup/diagnostics")

    assert response.status_code == 200, "the route must be registered (was a 404)"
    payload = response.json()
    assert payload["success"] is True
    data = payload["data"]
    for field in (
        "docker_version",
        "wsl_status",
        "os_build",
        "recent_logs",
        "failed_step",
        "report",
    ):
        assert field in data, f"missing diagnostic field: {field}"
    assert isinstance(data["recent_logs"], list)
    assert "=== Audora Diagnostic Report ===" in data["report"]


def test_endpoint_response_contains_no_secrets(monkeypatch):
    """The hard requirement, asserted on the serialised HTTP response body."""
    from fastapi.testclient import TestClient

    import app as app_module

    _mock_external(monkeypatch)
    _seed_failed_step_with_secrets(monkeypatch)
    _seed_session_data_in_logs()
    # Re-seed the credential secrets after the session seeding cleared the ring.
    setup_log = logging.getLogger("setup")
    handler = logger_module._RingBufferHandler()
    setup_log.addHandler(handler)
    try:
        setup_log.error(
            f"[build_wrapper] surfacing failure code=unknown transient=False: "
            f"docker run {SECRET_LOGIN_ARG} failed for {SECRET_EMAIL}"
        )
        setup_log.info(f"password={SECRET_PASSWORD} token={SECRET_TOKEN}")
    finally:
        setup_log.removeHandler(handler)

    with TestClient(app_module.app) as client:
        response = client.get("/setup/diagnostics")

    assert response.status_code == 200
    # Scan the RAW serialised body — nothing can hide in a nested field.
    raw_body = response.text
    for secret in _ALL_SECRETS + list(SESSION_SECRETS.values()):
        assert secret not in raw_body, f"secret leaked over HTTP: {secret!r}"

