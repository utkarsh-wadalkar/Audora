"""Readable, complete diagnostic reports without a Docker daemon or WSL."""
import json
import os
import subprocess
import sys
from types import SimpleNamespace

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import diagnostics
from setup_manager import StepState


def _mock_sources(monkeypatch, *, failed_step=None, error=""):
    monkeypatch.setattr(diagnostics.docker_mgr, "get_client", lambda: None)
    monkeypatch.setattr(diagnostics, "_os_build", lambda: "Windows 11")
    monkeypatch.setattr(
        diagnostics.setup_mgr,
        "get_step_state",
        lambda step: StepState.FAILED if step == failed_step else StepState.PENDING,
    )
    logs = [{"message": error, "level": "ERROR", "logger": "setup"}] if error else []
    monkeypatch.setattr(diagnostics, "get_recent_logs", lambda limit: logs[-limit:])


@pytest.mark.parametrize("encoding", ["utf-16-le", "utf-16", "utf-8"])
def test_wsl_output_is_readable_and_report_is_complete(monkeypatch, encoding):
    _mock_sources(monkeypatch)
    monkeypatch.setattr(diagnostics.platform, "system", lambda: "Windows")
    status = "Default Distribution: Ubuntu\r\nDefault Version: 2"

    def run_wsl(*args, **kwargs):
        raw = status.encode(encoding)
        # Reproduce the old locale decoding, which leaves UTF-16 NULs intact.
        stdout = raw.decode("cp1252") if kwargs.get("text") else raw
        return SimpleNamespace(stdout=stdout, stderr=b"", returncode=0)

    monkeypatch.setattr(diagnostics.subprocess, "run", run_wsl)
    bundle = diagnostics.collect_diagnostics()

    assert bundle["wsl_status"] == status
    assert "\x00" not in bundle["report"]
    assert "--- Last 50 backend log lines ---" in bundle["report"]
    assert bundle["report"].endswith("=== end of report ===")


def test_report_explains_failed_flac_check_and_preserves_actual_error(monkeypatch):
    raw = (
        "[build_downloader] surfacing failure code=unknown transient=False: "
        'Docker API error (400): OCI runtime create failed: exec: "ffmpeg": '
        "executable file not found in $PATH"
    )
    _mock_sources(monkeypatch, failed_step="build_downloader", error=raw)
    monkeypatch.setattr(diagnostics, "_wsl_status", lambda: "unavailable")

    bundle = diagnostics.collect_diagnostics()

    assert "FLAC" in bundle["failed_step"]["label"]
    assert "FFmpeg" in bundle["failed_step"]["label"]
    assert bundle["failed_step"]["error"] == raw
    assert bundle["failed_step"]["code"] == "unknown"
    assert "failed" in bundle["summary"].lower()
    assert "Retry" in bundle["recovery"]
    assert "report" in bundle["recovery"].lower()
    assert raw in bundle["report"]
    assert bundle["report"].index("--- Summary ---") < bundle["report"].index("--- WSL status ---")


def test_recovery_uses_captured_error_code(monkeypatch):
    _mock_sources(
        monkeypatch,
        failed_step="pull_downloader",
        error="[pull_downloader] surfacing failure code=disk_full transient=False: no space left on device",
    )
    monkeypatch.setattr(diagnostics, "_wsl_status", lambda: "unavailable")

    bundle = diagnostics.collect_diagnostics()

    assert bundle["failed_step"]["code"] == "disk_full"
    assert "6 GB" in bundle["recovery"]
    assert "Retry" in bundle["recovery"]


def test_every_structured_field_is_redacted(monkeypatch):
    _mock_sources(monkeypatch)
    secret = "private.user@icloud.com"
    monkeypatch.setattr(diagnostics, "_docker_version", lambda: secret)
    monkeypatch.setattr(diagnostics, "_wsl_status", lambda: secret)
    monkeypatch.setattr(diagnostics, "_os_build", lambda: secret)
    monkeypatch.setattr(
        diagnostics,
        "get_recent_logs",
        lambda limit: [{"timestamp": secret, "level": "ERROR", "logger": secret, "message": "failure"}],
    )

    assert secret not in json.dumps(diagnostics.collect_diagnostics())


def test_missing_failure_text_is_explicit_and_has_recovery(monkeypatch):
    _mock_sources(monkeypatch, failed_step="build_wrapper")
    monkeypatch.setattr(diagnostics, "_wsl_status", lambda: "unavailable")

    bundle = diagnostics.collect_diagnostics()

    assert bundle["failed_step"]["error"] == "(no captured error text)"
    assert "not captured" in bundle["summary"]
    assert "Retry" in bundle["recovery"]


def test_no_failed_step_does_not_claim_setup_succeeded(monkeypatch):
    _mock_sources(monkeypatch)
    monkeypatch.setattr(diagnostics, "_wsl_status", lambda: "unavailable")

    bundle = diagnostics.collect_diagnostics()

    assert bundle["failed_step"] is None
    assert "does not confirm setup has completed" in bundle["summary"]
    assert "report" in bundle["recovery"]
    assert "(no logs captured)" in bundle["report"]


def test_wsl_stderr_is_decoded_when_stdout_is_empty(monkeypatch):
    monkeypatch.setattr(diagnostics.platform, "system", lambda: "Windows")
    monkeypatch.setattr(
        diagnostics.subprocess,
        "run",
        lambda *args, **kwargs: SimpleNamespace(
            stdout=b"", stderr="WSL is not installed".encode("utf-16-le"), returncode=1
        ),
    )

    assert diagnostics._wsl_status() == "WSL is not installed"


def test_wsl_timeout_still_returns_unavailable(monkeypatch):
    monkeypatch.setattr(diagnostics.platform, "system", lambda: "Windows")

    def timeout(*args, **kwargs):
        raise subprocess.TimeoutExpired("wsl", 10)

    monkeypatch.setattr(diagnostics.subprocess, "run", timeout)

    assert diagnostics._wsl_status() == "unavailable"


def test_report_includes_engine_architecture_and_logging_driver(monkeypatch):
    _mock_sources(monkeypatch)
    monkeypatch.setattr(diagnostics, "_wsl_status", lambda: "unavailable")
    client = SimpleNamespace(
        version=lambda: {"Version": "29.9.2", "ApiVersion": "1.56"},
        info=lambda: {"OSType": "linux", "Architecture": "x86_64", "LoggingDriver": "local"},
    )
    monkeypatch.setattr(diagnostics.docker_mgr, "get_client", lambda: client)

    report = diagnostics.collect_diagnostics()

    assert report["docker_environment"]["logging_driver"] == "local"
    assert "Docker engine  : linux / x86_64" in report["report"]
    assert "Docker logging : local" in report["report"]


def test_engine_metadata_is_redacted(monkeypatch):
    _mock_sources(monkeypatch)
    monkeypatch.setattr(diagnostics, "_wsl_status", lambda: "unavailable")
    secret = "user.private@icloud.com"
    client = SimpleNamespace(
        version=lambda: {},
        info=lambda: {"OSType": secret, "Architecture": secret, "LoggingDriver": secret},
    )
    monkeypatch.setattr(diagnostics.docker_mgr, "get_client", lambda: client)

    assert secret not in json.dumps(diagnostics.collect_diagnostics())
