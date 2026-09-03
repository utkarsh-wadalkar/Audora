# Runtime and API map

## Runtime flow

```text
React renderer (HashRouter)
  ├─ REST + WebSockets to http://127.0.0.1:<backend port>
  └─ context-isolated preload IPC for native folder/notification actions
Electron main process
  └─ starts native PyInstaller backend and owns its process tree
FastAPI backend
  ├─ Docker + wrapper container + Apple Music authentication
  ├─ downloader image/command -> optional FLAC conversion
  ├─ queue/history/settings/library persistence
  └─ WebSocket event streams -> renderer
```

The renderer uses `HashRouter` because packaged Electron loads `file://` URLs.
The preload bridge deliberately exposes only `openFolder`, `showNotification`,
and `selectFolder`; do not enable Node integration in the renderer.

## Backend API groups

The FastAPI app in `backend/app.py` serves these route families. Responses use
the project schemas; inspect that file only when a request needs exact payload
fields.

| Concern | HTTP endpoints |
| --- | --- |
| Health | `GET /health` |
| Docker | `GET /docker/status`, `POST /docker/start` |
| Authentication | `GET /auth/status`, `POST /auth/login`, `/auth/2fa`, `/auth/logout` |
| Wrapper | `GET /wrapper/status`, `POST /wrapper/start`, `/wrapper/stop` |
| Downloads | `POST /download`, `POST /download/cancel` |
| Queue | `GET/POST /queue`, `DELETE /queue/{item_id}`, `POST /queue/clear`, `/queue/start`, `/queue/pause` |
| History | `GET/DELETE /history`, `POST /history/{item_id}/retry` |
| Library | `GET /library`, `/library/artists`, `/library/albums`, `/library/search`, `/library/stream/{track_id}`, `/library/art/{track_id}`; `POST /library/scan` |
| Logs/settings | `GET /logs`; `GET/POST /settings` |
| Setup/diagnostics | `GET /setup/status`, `/setup/diagnostics`; `POST /setup/check`, `/setup/images`, `/setup/wrapper`, `/setup/complete` |

WebSocket consumers in the renderer use `/ws/progress`, `/ws/logs`, `/ws/auth`,
`/ws/wrapper`, and `/ws/setup` for live state. Treat these as event streams,
not persistent history.

## Data and external services

- **Persistent local state:** JSON settings plus SQLAlchemy/SQLite library and
  job data; it is runtime data, not source control.
- **Docker:** required for the wrapper/downloader workflow. The backend first
  connects using the standard Docker environment; platform-specific fallback
  behavior is documented in `platform-policy.md`.
- **Wrapper:** contains session-dependent state. Never print or commit its
  `rootfs/data` content.
- **Download output:** audio is managed as lossless FLAC after the conversion
  stage. Library scanning derives metadata and artwork references from the
  configured download directory.

## High-value change boundaries

- New backend endpoint: update `backend/app.py`, schemas/models as needed,
  the relevant manager, frontend caller, and tests.
- New live event: update `backend/progress.py`, backend broadcaster, and a
  renderer `useWebSocket` consumer.
- New persistent setting: update `settings.DEFAULTS`, UI, and settings tests.
- New platform behavior: update one of the two platform-boundary modules, its
  tests, and the platform policy context—do not scatter `platform` checks.
