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

# The event loop captured at startup so thread callbacks can schedule onto it.
_loop: asyncio.AbstractEventLoop | None = None


def _broadcast_from_thread(manager: ConnectionManager, message: dict) -> None:
    """Safely schedule a broadcast from any thread onto the main loop."""
    if _loop is None:
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


def setup_callback(event: dict) -> None:
    _broadcast_from_thread(setup_ws_manager, event)


# Register callbacks once at import time.
register_log_callback(log_callback)
wrapper_mgr.register_auth_callback(auth_callback)
dl_mgr.register_progress_callback(progress_callback)
dl_mgr.register_completion_callback(queue_processor.on_download_complete)
setup_mgr.register_progress_callback(setup_callback)


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

    # Auto-start the wrapper if we have a session and the setting is on.
    if settings.get("auto_start_wrapper", True) and auth_mgr.is_logged_in():
        if docker_mgr.is_docker_running():
            logger.info("Auto-starting wrapper (session exists)")
            wrapper_mgr.start_wrapper()
            # Await readiness without blocking the loop.
            asyncio.create_task(_await_wrapper_ready())
        else:
            logger.info("Docker not running; skipping wrapper auto-start")

    # Start the sequential queue processor.
    queue_processor.start()

    yield

    # --- Shutdown ---
    logger.info("Audora backend shutting down...")
    await queue_processor.stop()
    await dl_mgr.cancel_download()
    wrapper_mgr.stop_wrapper()


async def _await_wrapper_ready() -> None:
    loop = asyncio.get_running_loop()
    ready = await loop.run_in_executor(None, wrapper_mgr.wait_until_ready, 60)
    logger.info(f"Wrapper ready: {ready}")


app = FastAPI(title="Audora Backend", version="1.2.0", lifespan=lifespan)

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
    return ApiResponse(success=True, data={"status": "ok"})


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
    success = await dl_mgr.start_download(req.url, req.format)
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
    track = lib_mgr.get_track_by_id(track_id)
    if not track or not os.path.exists(track["file_path"]):
        raise HTTPException(status_code=404, detail="Track not found")
    return FileResponse(
        track["file_path"],
        media_type="audio/mp4",
        filename=os.path.basename(track["file_path"]),
    )


@app.get("/library/art/{track_id}")
def track_art(track_id: int):
    track = lib_mgr.get_track_by_id(track_id)
    if not track:
        raise HTTPException(status_code=404, detail="Track not found")
    art_path = lib_mgr.get_art_path(track)
    if not art_path or not os.path.exists(art_path):
        raise HTTPException(status_code=404, detail="No album art")
    return FileResponse(art_path, media_type="image/png")


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
    updated = update_settings(req.model_dump(exclude_unset=True))
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
    """Kick off image pull/build in the background. Progress via ws/setup."""
    settings = get_settings()
    wrapper_ctx = settings.get("wrapper_build_context")
    setup_mgr.run_image_setup(wrapper_ctx)
    return ApiResponse(success=True, data={"started": True})


@app.post("/setup/complete", response_model=ApiResponse)
def setup_complete():
    setup_mgr.mark_complete()
    return ApiResponse(success=True, data={"complete": True})


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
    await setup_ws_manager.connect(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        setup_ws_manager.disconnect(websocket)


if __name__ == "__main__":
    import uvicorn

    _settings = get_settings()
    setup_logger(_settings.get("log_level", "INFO"))
    uvicorn.run(app, host="127.0.0.1", port=_settings.get("backend_port", 8000))
