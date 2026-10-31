"""One-click diagnostic bundle (QC_plan.md §8.2, Workstream F).

Gathers everything a support engineer would otherwise have to ask a
non-technical user to run terminal commands for — Docker version, WSL status,
the last 50 backend log lines, the raw error from the most recently failed
setup step, and the OS build number — into a single copyable block.

Hard rules (QC_plan.md §1, §8.2, §12):

- **No secrets ever leave here.** Every string field (log messages, the
  failed-step raw error, and the assembled text block) is passed through
  ``utils.redact_credentials`` so an Apple ID, password, ``-L user:pass`` arg
  or auth token can never appear in the report.
- **No terminal for the user.** The WSL capture runs ``wsl --status`` as an
  internal, hidden subprocess (no console window). The user only ever sees a
  button and a "Copied" confirmation.
- **Never a dead end.** Every collector degrades to ``"unavailable"`` on any
  error and never raises, so the bundle is always produced even with no
  Docker, no WSL, and on a non-Windows OS.

This module is a pure read: calling it repeatedly has no side effects.
"""
import platform
import re
import subprocess
import sys
from typing import Dict, List, Optional

from docker_manager import docker_mgr
from logger import get_logger, get_recent_logs
from setup_manager import SETUP_STEPS, StepState, classify_error, setup_mgr
from utils import redact_credentials

logger = get_logger("diagnostics")

_UNAVAILABLE = "unavailable"

# Setup steps in orchestration order (setup_manager._run_image_setup_blocking).
# Keep this alias for callers/tests while deriving it from the canonical source.
# Read-only: we only ever call setup_mgr.get_step_state() on these.
_SETUP_STEPS: List[str] = list(SETUP_STEPS)

_STEP_LABELS = {
    "pull_downloader": "Download the music downloader",
    "build_downloader": "Prepare FLAC conversion (FFmpeg)",
    "build_wrapper": "Prepare the Apple Music authentication service",
    "complete": "Finish setup",
}

_DEFAULT_RECOVERY = (
    "Click Retry in setup. If it fails again, copy this report and include it "
    "when reporting the issue."
)
_RECOVERY = {
    "docker_unresponsive": "Open Docker Desktop and wait until its engine is running, then click Retry.",
    "dns_failure": "Check your connection and DNS or VPN settings, then click Retry.",
    "offline": "Reconnect to the internet, then click Retry if setup has not resumed.",
    "disk_full": "Free at least 6 GB on the drive used by Docker Desktop, then click Retry.",
    "registry_rate_limit": "Wait a few minutes for the download server's rate limit to clear, then click Retry.",
    "registry_unavailable": "Check your internet connection and try again later with Retry.",
    "auth_denied": "Check whether your VPN, proxy, or network blocks the download server, then click Retry.",
}

# Windows creation flag to run a subprocess with no console window. Absent on
# non-Windows platforms, so guard the lookup.
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def _docker_version() -> str:
    """Docker engine version via the SDK, or ``"unavailable"``.

    Never raises: a missing docker lib / stopped engine degrades to
    ``"unavailable"`` rather than crashing the bundle.
    """
    try:
        client = docker_mgr.get_client()
        if client is None:
            return _UNAVAILABLE
        info = client.version()
        if isinstance(info, dict):
            ver = info.get("Version")
            api = info.get("ApiVersion")
            if ver:
                return f"{ver} (API {api})" if api else str(ver)
        return _UNAVAILABLE
    except Exception as e:  # noqa: BLE001 - diagnostics must never crash
        logger.warning(f"docker version unavailable: {e}")
        return _UNAVAILABLE


def _wsl_status() -> str:
    """Capture ``wsl --status`` internally (no visible terminal for the user).

    This is a backend-internal capture, NOT a user-facing terminal: stdout and
    stderr are captured, a short timeout applies, and any failure (WSL absent,
    non-Windows, timeout) degrades to ``"unavailable"``.
    """
    if platform.system() != "Windows":
        return _UNAVAILABLE
    try:
        result = subprocess.run(
            ["wsl", "--status"],
            capture_output=True,
            timeout=10,
            creationflags=_NO_WINDOW,  # no console window ever surfaces
        )
        # Locale text decoding leaves embedded NULs in WSL's UTF-16 output.
        # Clipboard consumers can then stop copying at the first character.
        def decode(output) -> str:
            if isinstance(output, bytes):
                if output.startswith((b"\xff\xfe", b"\xfe\xff")):
                    output = output.decode("utf-16", errors="replace")
                elif b"\x00" in output:
                    output = output.decode("utf-16-le", errors="replace")
                else:
                    output = output.decode("utf-8-sig", errors="replace")
            return (output or "").replace("\x00", "").strip()

        return decode(result.stdout) or decode(result.stderr) or _UNAVAILABLE
    except (OSError, subprocess.SubprocessError) as e:
        logger.warning(f"wsl status unavailable: {e}")
        return _UNAVAILABLE
    except Exception as e:  # noqa: BLE001 - never crash the bundle
        logger.warning(f"wsl status unavailable: {e}")
        return _UNAVAILABLE


def _docker_environment() -> Dict[str, str]:
    details = {"os": _UNAVAILABLE, "architecture": _UNAVAILABLE, "logging_driver": _UNAVAILABLE}
    try:
        client = docker_mgr.get_client()
        if client is not None:
            info = client.info()
            for field, key in (("os", "OSType"), ("architecture", "Architecture"), ("logging_driver", "LoggingDriver")):
                if info.get(key):
                    details[field] = redact_credentials(str(info[key]))
    except Exception as error:
        logger.warning(f"Docker environment unavailable: {error}")
    return details


def _os_build() -> str:
    """OS build/version string, reliable on Windows, degrades cross-platform."""
    try:
        system = platform.system()
        if system == "Windows":
            # win32_ver() -> (release, version, csd, ptype); version is the
            # build string like "10.0.26200".
            release, version, _csd, _ptype = platform.win32_ver()
            build = version or platform.version()
            return f"Windows {release} (build {build})".strip()
        return f"{system} {platform.release()} ({platform.version()})".strip()
    except Exception as e:  # noqa: BLE001
        logger.warning(f"os build unavailable: {e}")
        return _UNAVAILABLE


def _last_failed_step() -> Optional[Dict[str, str]]:
    """Read-only introspection of the most recently failed setup step.

    Uses ``setup_mgr.get_step_state`` (B's step-state introspection) — never
    mutates setup_manager. Returns the step, label, code and error for the last
    step in orchestration order that is in the FAILED state, or ``None`` if no
    step has failed. The raw error text is reconstructed from the backend logs
    (setup_manager logs each surfaced failure), so it is redaction-safe by
    construction; the value is redacted again defensively before return.
    """
    failed_step: Optional[str] = None
    try:
        for step in _SETUP_STEPS:
            if setup_mgr.get_step_state(step) == StepState.FAILED:
                failed_step = step  # keep the last failed one in run order
    except Exception as e:  # noqa: BLE001
        logger.warning(f"could not read setup step state: {e}")
        return None

    if failed_step is None:
        return None

    # Recover the raw error/message from the log ring buffer. setup_manager
    # logs "[<step>] surfacing failure ...: <raw>" at ERROR when a step fails.
    raw = ""
    try:
        for entry in reversed(get_recent_logs(500)):
            msg = entry.get("message", "")
            if f"[{failed_step}]" in msg and "failure" in msg.lower():
                raw = msg
                break
    except Exception as e:  # noqa: BLE001
        logger.warning(f"could not read setup error log: {e}")

    code_match = re.search(r"\bsurfacing failure code=([a-z_]+)\b", raw)
    code = code_match.group(1) if code_match else classify_error(raw)
    return {
        "step": failed_step,
        "label": _STEP_LABELS.get(failed_step, failed_step),
        "code": code if code in _RECOVERY else "unknown",
        "error": redact_credentials(raw) if raw else "(no captured error text)",
    }


def _recent_logs(limit: int = 50) -> List[str]:
    """Last ``limit`` backend log lines, each fully redacted."""
    lines: List[str] = []
    try:
        for entry in get_recent_logs(limit):
            ts = entry.get("timestamp", "")
            level = entry.get("level", "")
            name = entry.get("logger", "")
            msg = entry.get("message", "")
            lines.append(redact_credentials(f"{ts} [{level}] {name}: {msg}"))
    except Exception as e:  # noqa: BLE001
        logger.warning(f"could not read recent logs: {e}")
    return lines


def collect_diagnostics() -> Dict[str, object]:
    """Assemble the full diagnostic bundle (structured + a copyable text block).

    Pure read, re-callable safely. Every collector degrades to
    ``"unavailable"`` on error so this never raises and never returns a blank
    report. The ``report`` field is a single formatted, copy-paste-ready block;
    the other fields are the same data structured for programmatic use.
    """
    docker_version = redact_credentials(_docker_version())
    docker_environment = _docker_environment()
    wsl_status = redact_credentials(_wsl_status())
    os_build = redact_credentials(_os_build())
    logs = _recent_logs(50)
    failed_step = _last_failed_step()
    if failed_step:
        summary = f"Setup failed at this step: {failed_step['label']}."
        if failed_step["error"] == "(no captured error text)":
            summary += " The underlying error was not captured in the recent logs."
        recovery = _RECOVERY.get(failed_step["code"], _DEFAULT_RECOVERY)
    else:
        summary = "No failed setup step is currently recorded. This does not confirm setup has completed."
        recovery = "If setup is stuck or a download fails, copy this report and include it when reporting the issue."

    structured: Dict[str, object] = {
        "docker_version": docker_version,
        "docker_environment": docker_environment,
        "wsl_status": wsl_status,
        "os_build": os_build,
        "python_version": sys.version.split()[0],
        "failed_step": failed_step,
        "summary": redact_credentials(summary),
        "recovery": redact_credentials(recovery),
        "recent_logs": logs,         # already redacted
    }

    # Build the copyable text block. Redact the WHOLE thing once more as a
    # final belt-and-suspenders guard — cheaper than trusting every field.
    parts: List[str] = []
    parts.append("=== Audora Diagnostic Report ===")
    parts.append("")
    parts.append("--- Summary ---")
    parts.append(summary)
    parts.append(f"Recovery: {structured['recovery']}")
    parts.append("")
    parts.append(f"Docker version : {docker_version}")
    parts.append(f"Docker engine  : {docker_environment['os']} / {docker_environment['architecture']}")
    parts.append(f"Docker logging : {docker_environment['logging_driver']}")
    parts.append(f"OS build       : {os_build}")
    parts.append(f"Python         : {structured['python_version']}")
    parts.append("")
    parts.append("--- WSL status ---")
    parts.append(wsl_status)
    parts.append("")
    parts.append("--- Most recent failed setup step ---")
    if failed_step:
        parts.append(f"Step : {failed_step['label']} ({failed_step['step']})")
        parts.append(f"Code : {failed_step['code']}")
        parts.append(f"Error: {failed_step['error']}")
    else:
        parts.append("(no failed setup step)")
    parts.append("")
    parts.append("--- Last 50 backend log lines ---")
    parts.extend(logs or ["(no logs captured)"])
    parts.append("=== end of report ===")

    report_text = redact_credentials("\n".join(parts))
    structured["report"] = report_text
    return structured
