# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec — builds backend/app.py into a standalone backend.exe.

Build:  pyinstaller backend.spec  (run from the backend/ directory)
Output: backend/dist/backend.exe

Note: The SQLite DB, settings.json, logs, and album_art are created at
runtime under a writable data/ dir next to the exe — they are NOT bundled.
"""
import os

from PyInstaller.utils.hooks import collect_submodules

# Every top-level backend module must be listed as a hidden import: they are
# bare modules (``from diagnostics import ...``), not a package, and
# PyInstaller's static analysis does not reliably follow those. A hand-written
# list silently drifts the moment a new module is added — that is exactly how
# ``diagnostics`` was left out of the 1.3.1 build, which shipped a backend.exe
# with no ``/setup/diagnostics`` route and made the wizard's "Copy diagnostic
# report" button fall back to its "could not reach the backend" message.
#
# So derive the list from what is actually on disk next to this spec. New
# modules are picked up automatically and can never be forgotten again.
# PyInstaller injects SPECPATH as the DIRECTORY containing this spec file
# (CONF['specpath']), not the path to the file itself — so use it directly.
_SPEC_DIR = os.path.abspath(SPECPATH)

_EXCLUDED_MODULES = {
    "backend",  # the spec itself, if ever imported
}


def _local_modules() -> list:
    """Every ``*.py`` sibling of this spec, as importable module names."""
    names = []
    for entry in sorted(os.listdir(_SPEC_DIR)):
        if not entry.endswith(".py"):
            continue
        name = entry[:-3]
        if name.startswith("_") or name in _EXCLUDED_MODULES:
            continue
        names.append(name)
    return names


hiddenimports = (
    collect_submodules("uvicorn")
    + collect_submodules("docker")
    + _local_modules()
)

a = Analysis(
    ["app.py"],
    pathex=[],
    binaries=[],
    datas=[],
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["tkinter", "matplotlib", "numpy", "pandas"],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="backend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,  # UPX often trips antivirus false positives (SRS Section 30)
    console=True,
    disable_windowed_traceback=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
