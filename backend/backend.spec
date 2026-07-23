# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec — builds backend/app.py into a standalone backend.exe.

Build:  pyinstaller backend.spec  (run from the backend/ directory)
Output: backend/dist/backend.exe

Note: The SQLite DB, settings.json, logs, and album_art are created at
runtime under a writable data/ dir next to the exe — they are NOT bundled.
"""
from PyInstaller.utils.hooks import collect_submodules

hiddenimports = (
    collect_submodules("uvicorn")
    + collect_submodules("docker")
    + [
        "app",
        "auth_manager",
        "download_manager",
        "library_manager",
        "wrapper_manager",
        "docker_manager",
        "queue_processor",
        "setup_manager",
        "progress",
        "database",
        "models",
        "schemas",
        "settings",
        "logger",
        "utils",
    ]
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
