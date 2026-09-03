# Audora 2.0.0 desktop release contract

Audora 2.0.0 is the native x64 desktop product for **Windows** and **Linux**.
The release system produces independent artifacts for each platform and keeps
all operating-system decisions inside the explicit platform boundaries.

## Product targets and artifacts

| Platform | Native runner | Backend inside package | User-facing artifacts |
| --- | --- | --- | --- |
| Windows x64 | `windows-latest` | `backend.exe` built by Windows PyInstaller | NSIS `.exe`, `.blockmap` |
| Linux x64 | `ubuntu-latest` | `backend` built by Linux PyInstaller | `.AppImage`, `.deb`, `.blockmap` |

The release includes `SHA256SUMS.txt` for the Windows and Linux packages.
Windows keeps `frontend/assets/audoralogo.ico`; Linux uses the same logo as
`frontend/assets/audoralogo.png`. Linux packaging metadata (including the deb
maintainer) is declared in `frontend/package.json`, with the repository as its
homepage.
macOS is not a target of Audora 2.0.0: there is no macOS runner, package target,
signing, notarization, or platform implementation.

## Native build sequence

Every platform executes the same high-level sequence on its own host:

1. Install Python and Node dependencies.
2. Run the backend test suite.
3. Freeze `backend/app.py` using `backend/backend.spec`.
4. Run Electron policy tests, TypeScript validation, and the Vite production
   build.
5. Package Electron with the backend generated in step 3.
6. Launch the unpacked package in smoke mode and require the packaged backend's
   own `/health` token response.
7. Upload only that platform's release artifacts.

The publish job combines the two independent artifact sets, creates checksums,
and attaches the allowed files to the GitHub Release. No backend binary crosses
from one build host into the other platform's package.

## Quality gates

- Backend tests cover downloader, wrapper, Docker, settings, library, auth,
  diagnostics, progress, and Windows/Linux platform behavior.
- Electron tests cover process-tree lifecycle, development/packaged launch
  policy, Windows/Linux paths, and smoke-probe token isolation.
- The packaged smoke probe assigns a fresh local port and a random backend
  token, which prevents a different process from satisfying the check.
- Linux smoke runs under Xvfb so it verifies the real Linux package without a
  physical display.

Exact commands and expected results are in `commands.yml`. Platform decisions
are documented in `../architecture/platform-policy.md`.
