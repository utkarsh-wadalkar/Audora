"""Docker-dependent verification for the setup-wizard fixes.

These are the checks that could NOT run when the fixes were written, because
Docker Desktop was not installed on the machine. Everything here needs a live
Docker engine; everything that does not is already covered by ``pytest tests/``.

Run (from the backend/ directory, with Docker Desktop running):

    ..\\..\\..\\..\\backend\\.venv\\Scripts\\python.exe verify_docker.py

or with whichever interpreter has the ``docker`` package installed:

    python verify_docker.py

Exits 0 if every check passes, 1 otherwise. Safe to re-run: it is idempotent
by design, since idempotency is one of the things it verifies.

What it checks
--------------
1. The Docker engine is actually reachable.
2. The real wrapper image builds from the upstream release, end to end
   (download -> extract -> generate Dockerfile -> docker build), with no
   Settings/Dockerfile prompt anywhere in the flow.
3. Every ws/setup progress event is emitted, in the canonical schema.
4. The build is idempotent: a second run is a no-op that does not re-download.
5. The built image is sane: ``wrapper`` is executable inside it (the chmod
   that Windows zip extraction makes necessary) and ``rootfs`` is present.
6. The archive was not left behind to bloat the image.

Pass ``--keep`` to leave the built image in place, or ``--clean`` to remove it
afterwards (default: keep, since the wizard wants it).
"""
import os
import shutil
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import setup_manager  # noqa: E402
from setup_manager import SetupManager, StepState  # noqa: E402
from docker_manager import docker_mgr  # noqa: E402

_PASS = "[ PASS ]"
_FAIL = "[ FAIL ]"
_INFO = "[ .... ]"
_SKIP = "[ SKIP ]"

_results = []


def _check(label: str, ok: bool, detail: str = "") -> bool:
    print(f"{_PASS if ok else _FAIL} {label}" + (f" - {detail}" if detail else ""))
    _results.append((label, ok))
    return ok


def _info(msg: str) -> None:
    print(f"{_INFO} {msg}")


# ---------------------------------------------------------------------------
# 1. Engine reachable
# ---------------------------------------------------------------------------
def check_engine() -> bool:
    client = docker_mgr.get_client()
    if client is None:
        _check("Docker engine reachable", False, "no client - is Docker Desktop running?")
        return False
    try:
        version = client.version().get("Version", "?")
    except Exception as e:
        _check("Docker engine reachable", False, str(e)[:80])
        return False
    return _check("Docker engine reachable", True, f"engine {version}")


# ---------------------------------------------------------------------------
# 2-4. The real build, its progress events, and idempotency
# ---------------------------------------------------------------------------
def check_build() -> bool:
    mgr = SetupManager()
    events = []
    mgr.register_progress_callback(events.append)

    work = os.path.join(tempfile.gettempdir(), "audora_wrapper_verify_build")
    shutil.rmtree(work, ignore_errors=True)
    mgr._wrapper_work_dir = lambda: work  # type: ignore[method-assign]

    # Start from a clean slate so we exercise the real download+build path.
    if docker_mgr.image_exists(setup_manager.WRAPPER_IMAGE):
        _info(f"removing existing {setup_manager.WRAPPER_IMAGE} image to force a real build")
        try:
            docker_mgr.get_client().images.remove(setup_manager.WRAPPER_IMAGE, force=True)
        except Exception as e:
            _info(f"could not remove image ({str(e)[:60]}) - continuing")

    _info("building wrapper image from the upstream release (downloads ~48MB, takes a while)...")
    started = time.time()
    ok = mgr._run_step_with_retry(
        "build_wrapper",
        mgr._build_wrapper_step,
        "Building wrapper image...",
    )
    elapsed = int(time.time() - started)

    if not ok:
        errs = [e for e in events if e.get("status") == "error"]
        detail = errs[-1].get("message", "?") if errs else "no error event captured"
        _check("wrapper image builds from source", False, detail)
        return False
    mgr._emit_state("build_wrapper", StepState.SUCCESS, "Built")
    _check("wrapper image builds from source", True, f"{elapsed}s")

    # The image really exists now.
    _check(
        "image is present after build",
        docker_mgr.image_exists(setup_manager.WRAPPER_IMAGE),
        setup_manager.WRAPPER_IMAGE,
    )

    # --- progress events: every stage, canonical schema ---
    wrapper_events = [e for e in events if e.get("step") == "build_wrapper"]
    schema_ok = all(
        e.get("type") == "setup_progress"
        and e.get("status") in ("pending", "running", "done", "error")
        and isinstance(e.get("message"), str)
        for e in wrapper_events
    )
    _check("progress events use the canonical schema", schema_ok, f"{len(wrapper_events)} events")

    blob = " ".join(e.get("message", "").lower() for e in wrapper_events)
    for stage in ("download", "extract", "dockerfile", "build"):
        _check(f"progress event for the {stage!r} stage", stage in blob)

    # --- no Settings/Dockerfile prompt anywhere ---
    all_messages = " ".join(e.get("message", "") for e in events)
    _check(
        "never asks for a Settings Dockerfile",
        "Settings" not in all_messages and "Dockerfile not found" not in all_messages,
    )

    # --- the archive was not left in the build context ---
    _check(
        "archive removed from the build context",
        not os.path.exists(os.path.join(work, setup_manager.WRAPPER_ASSET_NAME)),
    )

    # --- idempotency: a second run must be a cheap no-op ---
    mgr2 = SetupManager()
    downloads = []
    mgr2._wrapper_work_dir = lambda: work  # type: ignore[method-assign]
    mgr2._download_file = lambda url, dest: downloads.append(url)  # type: ignore[method-assign]
    started = time.time()
    mgr2._build_wrapper_step()
    second = time.time() - started
    _check(
        "second run is an idempotent no-op",
        downloads == [] and second < 5,
        f"no re-download, {second:.2f}s",
    )
    return True


# ---------------------------------------------------------------------------
# 5. The built image is actually usable
# ---------------------------------------------------------------------------
def check_image_contents() -> bool:
    client = docker_mgr.get_client()
    if client is None:
        return False
    if not docker_mgr.image_exists(setup_manager.WRAPPER_IMAGE):
        _check("image contents", False, "image missing")
        return False

    def _run(cmd: str) -> str:
        try:
            out = client.containers.run(
                setup_manager.WRAPPER_IMAGE,
                command=["bash", "-c", cmd],
                entrypoint="",
                remove=True,
            )
            return out.decode("utf-8", errors="replace").strip()
        except Exception as e:
            return f"__ERROR__ {e}"

    # The chmod matters: Windows zip extraction drops the exec bit, so without
    # `RUN chmod +x` in the Dockerfile the wrapper cannot start at all.
    exec_bit = _run("test -x /app/wrapper && echo EXECUTABLE || echo NOT_EXECUTABLE")
    _check("wrapper is executable inside the image", exec_bit == "EXECUTABLE", exec_bit[:60])

    rootfs = _run("test -d /app/rootfs && echo PRESENT || echo MISSING")
    _check("rootfs/ present inside the image", rootfs == "PRESENT", rootfs[:60])

    linker = _run(
        "test -f /app/rootfs/system/bin/linker64 && echo PRESENT || echo MISSING"
    )
    _check("android linker present inside the image", linker == "PRESENT", linker[:60])

    listing = _run("ls /app | tr '\\n' ' '")
    _info(f"/app contains: {listing[:120]}")
    _check(
        "release archive not baked into the image",
        setup_manager.WRAPPER_ASSET_NAME not in listing,
    )
    return True


def main() -> int:
    print("=" * 72)
    print("Audora setup-wizard verification - Docker-dependent checks")
    print("=" * 72)
    print()

    if not check_engine():
        print()
        print("Docker engine is not reachable. Start Docker Desktop, wait for it to")
        print("report 'Engine running', then re-run this script.")
        return 1

    print()
    check_build()
    print()
    check_image_contents()

    print()
    print("=" * 72)
    failed = [label for label, ok in _results if not ok]
    passed = len(_results) - len(failed)
    print(f"{passed}/{len(_results)} checks passed")
    if failed:
        print()
        print("FAILED:")
        for label in failed:
            print(f"  - {label}")
        return 1
    print("All Docker-dependent checks passed.")

    if "--clean" in sys.argv:
        try:
            docker_mgr.get_client().images.remove(setup_manager.WRAPPER_IMAGE, force=True)
            print(f"Removed the {setup_manager.WRAPPER_IMAGE} image (--clean).")
        except Exception as e:
            print(f"Could not remove image: {e}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
