# Audora agent context

This directory is the fast, maintained orientation layer for agents working in
Audora. Read it before searching the repository or running commands. It
describes architecture, operational boundaries, known verification evidence,
and the current release work without exposing runtime data or credentials.

## Start here

| If your task concerns… | Read this first |
| --- | --- |
| Finding the right code owner | `project.json`, then `inventory/modules.json` |
| UI, API, Docker, downloads, or persistence | `architecture/runtime-and-api.md` |
| Tests, builds, packages, CI, or releases | `operations/commands.yml` and `operations/release-contract.md` |
| Windows/Linux behavior | `architecture/platform-policy.md` |
| Existing release implementation decisions | `docs/superpowers/specs/2026-08-29-windows-linux-desktop-release-design.md` |
| Marketing website, music showcase, screenshots, or Vercel deployment | `../marketing/README.md`, `../marketing/ASSETS.md`, and `../marketing/lib/songs.generated.ts` |

## Product profile and maintenance contract

- **Release profile:** Audora 2.0.0 — native Windows x64 and Linux x64 desktop
  product.
- **Supported desktop targets:** Windows x64 and Linux x64 only. macOS is
  explicitly out of scope for this release line.
- **Release contract:** `operations/release-contract.md` defines the native
  packaging, validation, and artifact model.
- **Truth hierarchy:** source code and a current test/build result override this
  context if they conflict. Update the relevant `.context` file in the same
  change whenever an architectural boundary, command, platform policy, or
  verification result changes.

## Do not read or commit these for orientation

Do not inspect or add runtime data just to understand the project:

- SQLite databases, settings files, logs, downloaded music, or generated album
  art;
- Apple Music/wrapper session data under `rootfs/data`;
- `backend/dist`, `backend/build`, `frontend/dist`,
  `frontend/dist-electron`, virtual environments, or `node_modules`.

Those paths are generated, may contain private data, and are already excluded
by `.gitignore`.

## Repository shape

```text
backend/                 FastAPI service, Docker/wrapper/download pipeline
backend/tests/           Python unit and endpoint tests
frontend/src/            React/Vite renderer
frontend/electron/       Electron main process, platform policy, smoke helper
frontend/assets/         Packaged application assets
marketing/               Standalone Next.js static marketing site (Vercel root)
.github/workflows/       Native Windows/Linux release automation
docs/superpowers/        Release design and implementation plan
.context/                This agent-oriented, low-token knowledge base
```

## Working rules distilled

1. Keep desktop operating-system choices centralized in
   `backend/runtime_platform.py` and `frontend/electron/platform.js`.
2. Preserve established Windows defaults and behavior unless a request clearly
   changes them.
3. Build the PyInstaller backend on the same OS that packages it; never place
   a Windows backend in a Linux package or the reverse.
4. The native CI workflow is the delivery contract for Windows and Linux
   packages; keep its two independent build paths intact.
5. Keep sensitive values out of source, logs, tests, and this directory.
6. Backend tests run on both native OSes. Use native temporary paths for
   filesystem assertions and inject a runtime when testing OS-specific behavior.
