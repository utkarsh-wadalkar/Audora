# Windows and Linux platform policy

The current desktop release scope is **Windows x64 and Linux x64 only**.
macOS support, CI runners, targets, signing, and notarization are intentionally
absent. This is a project decision, not an accidental gap.

## Central owners

| Boundary | Owns | Consumers must do |
| --- | --- | --- |
| `backend/runtime_platform.py` | Writable data paths, defaults, backend executable name, Docker instructions/capabilities, WSL applicability, backend port | Call its API instead of checking `platform.system()` elsewhere. |
| `frontend/electron/platform.js` | Development Python path, packaged backend command, Linux environment overrides, icon policy | Call `createBackendLaunchSpec`; do not branch on `process.platform` in launcher code. |

## Exact policy

| Item | Windows x64 | Linux x64 |
| --- | --- | --- |
| Frozen backend command | `backend.exe` | `backend` |
| Dev Python | `.venv\\Scripts\\python.exe`, fallback `python` | `.venv/bin/python`, fallback `python3` |
| Backend state | Existing legacy `backend/data` directory | `AUDORA_DATA_DIR`, otherwise XDG `~/.local/share/Audora/backend` |
| Default downloads | Existing `D:\\apple-music-dl\\downloads` | `AUDORA_DOWNLOADS_DIR`, otherwise `~/Music/Audora` |
| Docker guidance | Docker Desktop; may start it using existing logic | Docker Engine; must already be installed/running |
| WSL readiness check | Applicable | Not applicable |
| Window icon | Existing `.ico` | Leave to Linux package integration |

Electron passes `AUDORA_DATA_DIR` and `AUDORA_DOWNLOADS_DIR` only for a
packaged Linux backend. This prevents a Linux package from writing into its
read-only resource directory. Windows deliberately receives no new overrides,
preserving its legacy behavior.

## 2FA file placement

`wrapper_data_path` is the configurable host mount root (`.../rootfs/data`),
not the Apple Music `files` directory. `wrapper_manager.resolve_twofa_host_path`
maps the current wrapper prompt beneath `/app/rootfs/data` onto this root using
native `os.path` operations; `AuthManager.submit_2fa` creates parents and writes
the code without a newline. No host drive, username, or OS-specific separator
is hardcoded into the 2FA resolver.

The current Apple Music layout resolves to
`<wrapper_data_path>/data/com.apple.android.music/files/2fa.txt`.
Both `data` segments are intentional: one belongs to the mount root, the other
to the container's application-data suffix. Windows uses backslashes; Linux
uses slashes. The wrapper's current prompt remains authoritative if its layout
changes. Tests exercise the real parser-to-writer flow with native temporary
mounts, including relocated paths containing spaces.

## Packaging invariant

Each CI matrix job first runs PyInstaller on its own host, then Electron Builder
copies that job's `backend/dist/backend` output into `extraResources`. Never
download or share the resulting executable across operating systems. The Linux
unpacked backend must retain executable permissions; the native Ubuntu package
and smoke test are the proof point.

## Fast diagnostic checks

- Wrong packaged backend name/path: inspect `frontend/electron/platform.js`.
- Settings/logs created under package resources on Linux: inspect environment
  propagation in Electron and `runtime_platform.py`.
- Docker startup/WSL attempted on Linux: inspect `RuntimePlatform` capability
  fields and `setup_manager.py`/`docker_manager.py` consumers.
- New macOS logic appearing: reject it for this release scope unless the user
  explicitly changes the platform requirement.
