"""FastAPI application entry point for the Audora backend."""
import asyncio
import os
from contextlib import asynccontextmanager
from typing import List

from fastapi import Depends, FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from sqlalchemy.orm import Session

from database import get_db, init_db
from logger import (
    setup_logger,
    get_logger,
    get_recent_logs,
    register_log_callback,
)
from settings import get_settings, update_settings
from docker_manager import docker_mgr
from wrapper_manager import wrapper_mgr
from auth_manager import auth_mgr
from download_manager import dl_mgr
from library_manager import lib_mgr
from queue_processor import queue_processor
from setup_manager import setup_mgr
from diagnostics import collect_diagnostics
from models import DownloadHistory, QueueItem
from schemas import (
    ApiResponse,
    LoginRequest,
    TwoFARequest,
    DownloadRequest,
    QueueItemCreate,
    QueueItemOut,
    HistoryItemOut,
    SettingsUpdate,
    DockerStatus,
)
from runtime_platform import get_backend_port

logger = get_logger("app")


# --- WebSocket connection manager ---
class ConnectionManager:
    def __init__(self) -> None:
        self.active: List[WebSocket] = []

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        self.active.append(websocket)

    def disconnect(self, websocket: WebSocket) -> None:
        if websocket in self.active:
            self.active.remove(websocket)

    async def broadcast(self, message: dict) -> None:
        dead = []
        for ws in list(self.active):
            try:
                await ws.send_json(message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws)


log_manager = ConnectionManager()
progress_manager = ConnectionManager()
auth_ws_manager = ConnectionManager()
setup_ws_manager = ConnectionManager()
wrapper_log_ws_manager = ConnectionManager()

# The event loop captured at startup so thread callbacks can schedule onto it.
_loop: asyncio.AbstractEventLoop | None = None


def _broadcast_from_thread(manager: ConnectionManager, message: dict) -> None:
    """Safely schedule a broadcast from any thread onto the main loop."""
    if _loop is None or _loop.is_closed():
        return
    try:
        asyncio.run_coroutine_threadsafe(manager.broadcast(message), _loop)
    except Exception:
        pass


def log_callback(entry: dict) -> None:
    _broadcast_from_thread(log_manager, entry)


def progress_callback(data: dict) -> None:
    _broadcast_from_thread(progress_manager, data)


def auth_callback(event: dict) -> None:
    _broadcast_from_thread(auth_ws_manager, event)


def wrapper_log_callback(event: dict) -> None:
    """Forward each raw wrapper line without summarizing or reshaping it."""
    _broadcast_from_thread(
        wrapper_log_ws_manager,
        {"type": "wrapper_log", **event},
    )


# =============================================================================
# CANONICAL `/ws/setup` EVENT SCHEMA  (Workstream C — reference for E/frontend)
# =============================================================================
# `setup_callback` is registered on `setup_mgr.register_progress_callback` and
# forwards every `setup_progress` event VERBATIM to all connected `/ws/setup`
# clients. It never reshapes, drops, or synthesizes keys — the exact dict
# emitted by `setup_manager.SetupManager._emit` is what the client receives.
# There is NO fake/synthetic progress: `percent` and `progress` are driven by
# real aggregated per-layer byte counts from the streamed Docker pull.
#
# Event shape (JSON object sent per `ws.send_json`):
#
#   {
#     "type":    "setup_progress",   # constant discriminator; always this value
#     "step":    <str>,              # step id — see STEP IDS below
#     "status":  <str>,              # "pending" | "running" | "done" | "error"
#     "message": <str>,              # plain-language narration for the UI
#     "percent": <int>,              # OPTIONAL 0..100, present on streamed pull
#                                    #   progress ticks (running); clamped 0..100
#     "progress": {                  # OPTIONAL, present alongside `percent` on
#       "current": <int>,            #   pull ticks — REAL aggregated byte counts
#       "total":   <int>             #   across all layers (bytes, not MB)
#     },
#     "error": {                     # OPTIONAL, present ONLY on status=="error"
#       "code":      <str>,          #   taxonomy code — see ERROR CODES below
#       "transient": <bool>          #   True => was auto-retried before surfacing
#     }
#   }
#
# `percent`, `progress`, and `error` are ADDITIVE and may be absent; consumers
# must treat missing keys as "not applicable" and never assume presence.
#
# ---------------------------------------------------------------------------
# STEP IDS (`step`) — emitted by setup_manager in order:
#   "pull_downloader"  Pull the ghcr.io apple-music-downloader image (streamed,
#                      preflighted, auto-retried). Emits `percent`/`progress`.
#   "build_downloader" Build Audora's derived downloader image with static
#                      ffmpeg, then verify the ffmpeg probe before downloads.
#   "build_wrapper"    Build (or detect already-built) the local wrapper image.
#   "complete"         Terminal bookkeeping step; done => whole setup succeeded.
#
# STATUS (`status`) — mapped from setup_manager's internal StepState:
#   "pending"  Step known but not started (StepState.PENDING).
#   "running"  Step in progress (StepState.RUNNING). Pull ticks carry
#              `percent` + `progress`. Re-emitted on each (auto/manual) retry.
#   "done"     Step succeeded (StepState.SUCCESS). Terminal for that step.
#   "error"    Step failed and was SURFACED to the user (StepState.FAILED) —
#              i.e. transient auto-retries (if any) were already exhausted.
#              ALWAYS carries `error.code` so the frontend can render exactly
#              one recovery button (never a dead end).
#
# ERROR CODES (`error.code`) — full taxonomy from setup_manager.ErrorCode,
# with transient (auto-retried) vs permanent (surfaces immediately):
#   "docker_unresponsive"   TRANSIENT  Docker API unreachable despite "running".
#   "dns_failure"           TRANSIENT  Cannot resolve the registry host.
#   "registry_rate_limit"   TRANSIENT  HTTP 429 from ghcr.io.
#   "registry_unavailable"  TRANSIENT  Registry 5xx / connection reset.
#   "disk_full"             PERMANENT  Insufficient free disk (< required+buffer).
#   "auth_denied"           PERMANENT  Auth / permission / access denied.
#   "unknown"               PERMANENT  Unclassified — generic recovery path.
# `error.transient` reflects this classification for the specific failure; a
# surfaced transient error means its silent-retry budget was exhausted.
# =============================================================================
def setup_callback(event: dict) -> None:
    # Forward the complete event dict unchanged to every `/ws/setup` client.
    _broadcast_from_thread(setup_ws_manager, event)


def rescan_library_after_download(summary: dict) -> None:
    """Refresh the library as soon as a download's FLAC files are ready.

    Without this the user must press Rescan before a finished track appears,
    which contradicts the "Ready to play -> Play" flow. Only a fully successful
    run is scanned: a ``convert_failed`` run has no playable output to add.
    """
    if summary.get("status") != "completed":
        return
    try:
        lib_mgr.scan_library()
    except Exception as scan_error:
        # A failed rescan must never turn a good download into a failure; the
        # user can still refresh manually.
        logger.warning(f"Post-download library scan failed: {scan_error}")


# Register callbacks once at import time.
register_log_callback(log_callback)
wrapper_mgr.register_auth_callback(auth_callback)
wrapper_mgr.register_log_callback(wrapper_log_callback)
dl_mgr.register_progress_callback(progress_callback)
dl_mgr.register_completion_callback(queue_processor.on_download_complete)
dl_mgr.register_completion_callback(rescan_library_after_download)
setup_mgr.register_progress_callback(setup_callback)


def should_auto_start_wrapper(settings: dict, setup_complete: bool) -> bool:
    """Auto-start only after the first-run wizard owns its required start."""
    return bool(settings.get("auto_start_wrapper", True) and setup_complete)


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _loop
    _loop = asyncio.get_running_loop()

    settings = get_settings()
    setup_logger(settings.get("log_level", "INFO"))
    init_db()
    logger.info("Audora backend starting...")

    # Load any previously-scanned library into memory.
    try:
        lib_mgr.get_all_tracks()
    except Exception:
        pass

    # During first-run setup the images-step Continue action owns the first
    # wrapper start. Completed installations auto-start and wait for the
    # wrapper's real log-detected state so cached credentials are reused.
    if should_auto_start_wrapper(settings, setup_mgr.is_complete()):
        if docker_mgr.is_docker_running():
            if wrapper_mgr.is_wrapper_ready():
                # Already up and serving from a previous run — reuse it rather
                # than tearing it down, which would kill any live download.
                logger.info("Wrapper already running; reusing it")
            else:
                logger.info("Auto-starting wrapper and checking cached authentication")
                if wrapper_mgr.start_wrapper():
                    state = await asyncio.get_running_loop().run_in_executor(
                        None, wrapper_mgr.wait_for_setup_state, 60
                    )
                    logger.info(f"Wrapper startup state: {state}")
        else:
            logger.info("Docker not running; skipping wrapper auto-start")

    # Start the sequential queue processor.
    queue_processor.start()

    yield

    # --- Shutdown ---
    logger.info("Audora backend shutting down...")
    await queue_processor.stop()
    await dl_mgr.cancel_download()
    # Leave the wrapper up by default so the next start reuses it instead of
    # force-removing and rebuilding the container. Tearing it down here is what
    # made the container churn on every app start.
    if get_settings().get("keep_wrapper_running", True):
        logger.info("Leaving wrapper running for the next start")
    else:
        wrapper_mgr.stop_wrapper()


app = FastAPI(title="Audora Backend", version="1.5.2", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    # Local desktop app: allow any origin (Electron file:// sends a null
    # origin). We don't use cookie auth, so credentials must be False for the
    # "*" wildcard to be honoured by browsers (CORS spec forbids "*" + creds).
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# --- Health & Docker ---
@app.get("/health")
def health():
    data = {"status": "ok"}
    smoke_token = os.environ.get("AUDORA_SMOKE_TOKEN")
    if smoke_token:
        data["smoke_token"] = smoke_token
    return ApiResponse(success=True, data=data)


@app.get("/docker/status", response_model=ApiResponse)
def docker_status():
    running = docker_mgr.is_docker_running()
    return ApiResponse(
        success=True,
        data=DockerStatus(
            running=running, message="Running" if running else "Not running"
        ).model_dump(),
    )


@app.post("/docker/start", response_model=ApiResponse)
async def start_docker():
    loop = asyncio.get_running_loop()
    success = await loop.run_in_executor(None, docker_mgr.start_docker_desktop)
    return ApiResponse(success=success, data={"started": success})


# --- Auth ---
@app.get("/auth/status", response_model=ApiResponse)
def auth_status():
    return ApiResponse(success=True, data=auth_mgr.get_auth_status())


@app.post("/auth/login", response_model=ApiResponse)
async def login(req: LoginRequest):
    success = await auth_mgr.login(req.email, req.password)
    return ApiResponse(
        success=success,
        data={"started": success},
        error=None if success else "Failed to start login process",
    )


@app.post("/auth/2fa", response_model=ApiResponse)
def submit_2fa(req: TwoFARequest):
    success = auth_mgr.submit_2fa(req.code)
    return ApiResponse(success=success, data={"submitted": success})


@app.post("/auth/logout", response_model=ApiResponse)
def logout():
    success = auth_mgr.logout()
    return ApiResponse(success=success, data={"logged_out": success})


# --- Wrapper ---
@app.get("/wrapper/status", response_model=ApiResponse)
def wrapper_status():
    return ApiResponse(success=True, data=wrapper_mgr.get_wrapper_status())


@app.post("/wrapper/start", response_model=ApiResponse)
def start_wrapper():
    success = wrapper_mgr.start_wrapper()
    return ApiResponse(success=success, data={"started": success})


@app.post("/wrapper/stop", response_model=ApiResponse)
def stop_wrapper():
    success = wrapper_mgr.stop_wrapper()
    return ApiResponse(success=success, data={"stopped": success})


# --- Download (immediate) ---
@app.post("/download", response_model=ApiResponse)
async def start_download(req: DownloadRequest):
    if not docker_mgr.is_docker_running():
        return ApiResponse(success=False, error="Docker Desktop is not running")
    if not wrapper_mgr.is_wrapper_ready():
        wrapper_mgr.start_wrapper()
    success = await dl_mgr.start_download(req.url)
    return ApiResponse(
        success=success,
        data={"started": success},
        error=None if success else "Failed to start download",
    )


@app.post("/download/cancel", response_model=ApiResponse)
async def cancel_download():
    success = await dl_mgr.cancel_download()
    return ApiResponse(success=success, data={"cancelled": success})


# --- Queue ---
@app.get("/queue", response_model=ApiResponse)
def get_queue(db: Session = Depends(get_db)):
    items = db.query(QueueItem).order_by(QueueItem.position).all()
    return ApiResponse(
        success=True,
        data=[QueueItemOut.model_validate(i).model_dump(mode="json") for i in items],
    )


@app.post("/queue", response_model=ApiResponse)
def add_queue(req: QueueItemCreate, db: Session = Depends(get_db)):
    count = db.query(QueueItem).count()
    item = QueueItem(url=req.url, position=count + 1)
    db.add(item)
    db.commit()
    db.refresh(item)
    return ApiResponse(success=True, data={"id": item.id})


@app.delete("/queue/{item_id}", response_model=ApiResponse)
def delete_queue(item_id: int, db: Session = Depends(get_db)):
    item = db.query(QueueItem).filter(QueueItem.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Queue item not found")
    db.delete(item)
    db.commit()
    return ApiResponse(success=True)


@app.post("/queue/clear", response_model=ApiResponse)
def clear_queue(db: Session = Depends(get_db)):
    db.query(QueueItem).delete()
    db.commit()
    return ApiResponse(success=True)


@app.post("/queue/start", response_model=ApiResponse)
def start_queue():
    queue_processor.resume()
    return ApiResponse(success=True, data={"paused": False})


@app.post("/queue/pause", response_model=ApiResponse)
def pause_queue():
    queue_processor.pause()
    return ApiResponse(success=True, data={"paused": True})


# --- History ---
@app.get("/history", response_model=ApiResponse)
def get_history(db: Session = Depends(get_db)):
    items = db.query(DownloadHistory).order_by(DownloadHistory.created_at.desc()).all()
    return ApiResponse(
        success=True,
        data=[HistoryItemOut.model_validate(i).model_dump(mode="json") for i in items],
    )


@app.delete("/history", response_model=ApiResponse)
def clear_history(db: Session = Depends(get_db)):
    db.query(DownloadHistory).delete()
    db.commit()
    return ApiResponse(success=True)


@app.post("/history/{item_id}/retry", response_model=ApiResponse)
def retry_history(item_id: int, db: Session = Depends(get_db)):
    item = db.query(DownloadHistory).filter(DownloadHistory.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="History item not found")
    count = db.query(QueueItem).count()
    qi = QueueItem(url=item.url, title=item.title, position=count + 1)
    db.add(qi)
    db.commit()
    db.refresh(qi)
    return ApiResponse(success=True, data={"queued_id": qi.id})


# --- Library ---
@app.get("/library", response_model=ApiResponse)
def get_library():
    return ApiResponse(success=True, data=lib_mgr.get_all_tracks())


@app.post("/library/scan", response_model=ApiResponse)
def scan_library():
    tracks = lib_mgr.scan_library()
    return ApiResponse(success=True, data={"track_count": len(tracks)})


@app.get("/library/artists", response_model=ApiResponse)
def get_artists():
    return ApiResponse(success=True, data=lib_mgr.get_artists())


@app.get("/library/albums", response_model=ApiResponse)
def get_albums():
    return ApiResponse(success=True, data=lib_mgr.get_albums())


@app.get("/library/search", response_model=ApiResponse)
def search_library(q: str = ""):
    return ApiResponse(success=True, data=lib_mgr.search(q))


@app.get("/library/stream/{track_id}")
def stream_track(track_id: int):
    """Serve a library track for playback.

    ``FileResponse`` handles Range requests itself (206 + ``Content-Range``),
    which is what makes seeking and scrubbing work — so no ``filename`` is
    passed: that sets ``Content-Disposition: attachment``, which is wrong for a
    streaming endpoint.
    """
    track = lib_mgr.get_track_by_id(track_id)
    if not track or not os.path.exists(track["file_path"]):
        raise HTTPException(status_code=404, detail="Track not found")
    return FileResponse(track["file_path"], media_type="audio/flac")


@app.get("/library/art/{track_id}")
def track_art(track_id: int):
    track = lib_mgr.get_track_by_id(track_id)
    if not track:
        raise HTTPException(status_code=404, detail="Track not found")
    art_path = lib_mgr.get_art_path(track)
    if not art_path or not os.path.exists(art_path):
        raise HTTPException(status_code=404, detail="No album art")
    return FileResponse(art_path, media_type=_sniff_image_type(art_path))


def _sniff_image_type(path: str) -> str:
    """Detect the real image type from its magic bytes.

    The cache file is named ``.png`` but the embedded artwork is usually JPEG
    (the downloader is configured with ``cover-format: jpg``), so the extension
    cannot be trusted. Browsers sniff anyway; sending the correct type keeps the
    response honest.
    """
    try:
        with open(path, "rb") as handle:
            header = handle.read(8)
    except OSError:
        return "application/octet-stream"
    if header.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if header.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    return "application/octet-stream"


# --- Logs ---
@app.get("/logs", response_model=ApiResponse)
def read_logs():
    return ApiResponse(success=True, data=get_recent_logs())


# --- Settings ---
@app.get("/settings", response_model=ApiResponse)
def read_settings():
    return ApiResponse(success=True, data=get_settings())


@app.post("/settings", response_model=ApiResponse)
def write_settings(req: SettingsUpdate):
    previous = get_settings()
    patch = req.model_dump(exclude_unset=True)
    updated = update_settings(patch)

    # The library cache and database reflect the tree under downloads_path.
    # Refresh immediately when that root changes so Settings never leaves the
    # old folder's albums visible until a manual or post-download rescan.
    previous_downloads = os.path.normcase(
        os.path.normpath(str(previous.get("downloads_path") or ""))
    )
    updated_downloads = os.path.normcase(
        os.path.normpath(str(updated.get("downloads_path") or ""))
    )
    if "downloads_path" in patch and previous_downloads != updated_downloads:
        lib_mgr.scan_library()

    return ApiResponse(success=True, data=updated)


# --- Setup (first-run wizard) ---
@app.get("/setup/status", response_model=ApiResponse)
def setup_status():
    return ApiResponse(
        success=True,
        data={"complete": setup_mgr.is_complete(), **setup_mgr.check_system()},
    )


@app.post("/setup/check", response_model=ApiResponse)
def setup_check():
    return ApiResponse(success=True, data=setup_mgr.check_system())


@app.post("/setup/images", response_model=ApiResponse)
def setup_images():
    """Kick off image pull/build in the background. Progress via ws/setup.

    Fully automatic — the wrapper image is built from the upstream release, so
    no Dockerfile path or other user configuration is involved.
    """
    setup_mgr.run_image_setup()
    return ApiResponse(success=True, data={"started": True})


@app.post("/setup/wrapper", response_model=ApiResponse)
async def setup_wrapper():
    """Start the wrapper from the images-step Continue action.

    The worker waits on the wrapper manager's condition while its raw logs are
    streamed independently over ``/ws/wrapper``. The response reports only the
    state actually detected in this run's container output.
    """
    started = await asyncio.get_running_loop().run_in_executor(
        None, wrapper_mgr.start_wrapper
    )
    if not started:
        return ApiResponse(
            success=False, data={"started": False, "state": "error"}
        )
    state = await asyncio.get_running_loop().run_in_executor(
        None, wrapper_mgr.wait_for_setup_state, 60
    )
    success = state in {"authenticated", "needs_credentials", "needs_2fa"}
    return ApiResponse(
        success=success,
        data={"started": True, "state": state},
        error=None if success else "Wrapper startup did not reach a known state",
    )



@app.post("/setup/complete", response_model=ApiResponse)
def setup_complete():
    setup_mgr.mark_complete()
    return ApiResponse(success=True, data={"complete": True})


# --- Diagnostics (QC_plan.md §8.2) ---
@app.get("/setup/diagnostics", response_model=ApiResponse)
def setup_diagnostics():
    """One-click diagnostic bundle for a visibly-failed setup step.

    Pure read (safe to re-call). Returns the structured fields plus a single
    copyable ``report`` text block. Every string is redacted so no Apple ID,
    password, or token can leak (QC_plan.md §8.2, §12). Never raises: absent
    Docker/WSL degrade to "unavailable" so the report is never a dead end.
    """
    return ApiResponse(success=True, data=collect_diagnostics())


# --- WebSockets ---
@app.websocket("/ws/logs")
async def ws_logs(websocket: WebSocket):
    await log_manager.connect(websocket)
    for entry in get_recent_logs(100):
        await websocket.send_json(entry)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        log_manager.disconnect(websocket)


@app.websocket("/ws/progress")
async def ws_progress(websocket: WebSocket):
    await progress_manager.connect(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        progress_manager.disconnect(websocket)


@app.websocket("/ws/auth")
async def ws_auth(websocket: WebSocket):
    await auth_ws_manager.connect(websocket)
    await websocket.send_json({"type": "auth_status", **auth_mgr.get_auth_status()})
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        auth_ws_manager.disconnect(websocket)


@app.websocket("/ws/setup")
async def ws_setup(websocket: WebSocket):
    # Streams first-run setup progress. Events are `setup_progress` dicts whose
    # full JSON schema (type/step/status/message/percent/progress/error) is
    # documented on `setup_callback` above — that is the canonical reference
    # for Workstream E. Lifecycle mirrors `/ws/progress`/`/ws/auth`: graceful
    # accept, read-loop to detect disconnect, unregister on drop (no crash).
    await setup_ws_manager.connect(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        setup_ws_manager.disconnect(websocket)


@app.websocket("/ws/wrapper")
async def ws_wrapper(websocket: WebSocket):
    """Stream the wrapper container's complete raw log output."""
    await wrapper_log_ws_manager.connect(websocket)
    for entry in wrapper_mgr.get_recent_logs():
        await websocket.send_json({"type": "wrapper_log", **entry})
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        wrapper_log_ws_manager.disconnect(websocket)


if __name__ == "__main__":
    import uvicorn

    _settings = get_settings()
    setup_logger(_settings.get("log_level", "INFO"))
    uvicorn.run(app, host="127.0.0.1", port=get_backend_port(os.environ))
