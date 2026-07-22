"""Sequential queue processor — one download at a time as an asyncio task.

Polls the queue_items table for the next `pending` item, runs it through
the download manager, waits for completion, records history, then moves on.
Pauseable via the shared `paused` flag; resumes pending items on restart.
"""
import asyncio
from datetime import datetime
from typing import Optional

from database import SessionLocal
from models import QueueItem, DownloadHistory
from download_manager import dl_mgr
from wrapper_manager import wrapper_mgr
from docker_manager import docker_mgr
from logger import get_logger

logger = get_logger("queue")


class QueueProcessor:
    def __init__(self) -> None:
        self._task: Optional[asyncio.Task] = None
        self._stop = False
        self.paused = False
        # Set when the active download finishes; the loop awaits it.
        self._download_done: Optional[asyncio.Event] = None
        self._last_summary: Optional[dict] = None

    def start(self) -> None:
        if self._task and not self._task.done():
            return
        self._stop = False
        # Any items left "downloading" from a previous run go back to pending.
        self._reset_stuck_items()
        self._task = asyncio.create_task(self._run())
        logger.info("Queue processor started")

    async def stop(self) -> None:
        self._stop = True
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    def pause(self) -> None:
        self.paused = True
        logger.info("Queue paused")

    def resume(self) -> None:
        self.paused = False
        logger.info("Queue resumed")

    # --- Completion signal wiring (registered from app.py) ---
    def on_download_complete(self, summary: dict) -> None:
        self._last_summary = summary
        if self._download_done is not None:
            self._download_done.set()

    def _reset_stuck_items(self) -> None:
        db = SessionLocal()
        try:
            stuck = db.query(QueueItem).filter(QueueItem.status == "downloading").all()
            for item in stuck:
                item.status = "pending"
            if stuck:
                db.commit()
                logger.info(f"Reset {len(stuck)} stuck queue item(s) to pending")
        finally:
            db.close()

    def _next_pending(self) -> Optional[QueueItem]:
        db = SessionLocal()
        try:
            return (
                db.query(QueueItem)
                .filter(QueueItem.status == "pending")
                .order_by(QueueItem.position)
                .first()
            )
        finally:
            db.close()

    def _set_status(self, item_id: int, status: str) -> None:
        db = SessionLocal()
        try:
            item = db.query(QueueItem).filter(QueueItem.id == item_id).first()
            if item:
                item.status = status
                db.commit()
        finally:
            db.close()

    def _record_history(self, url: str, summary: dict) -> None:
        db = SessionLocal()
        try:
            db.add(
                DownloadHistory(
                    url=url,
                    title=summary.get("track_name") or url,
                    status=summary.get("status", "completed"),
                    track_count=summary.get("completed", 0),
                    error_count=summary.get("failed", 0),
                    created_at=datetime.utcnow(),
                    completed_at=datetime.utcnow(),
                )
            )
            db.commit()
        finally:
            db.close()

    async def _ensure_wrapper(self) -> bool:
        if not docker_mgr.is_docker_running():
            logger.warning("Docker not running; queue waiting")
            return False
        status = wrapper_mgr.get_wrapper_status()
        if status.get("running") and status.get("ready"):
            return True
        wrapper_mgr.start_wrapper()
        # Give it time to become ready (runs in a thread; poll here).
        for _ in range(60):
            if wrapper_mgr.is_wrapper_ready():
                return True
            await asyncio.sleep(1)
        return wrapper_mgr.is_wrapper_ready()

    async def _run(self) -> None:
        while not self._stop:
            try:
                if self.paused or dl_mgr.is_running:
                    await asyncio.sleep(1)
                    continue

                item = self._next_pending()
                if item is None:
                    await asyncio.sleep(2)
                    continue

                item_id, url = item.id, item.url
                logger.info(f"Queue processing #{item_id}: {url}")

                if not await self._ensure_wrapper():
                    await asyncio.sleep(3)
                    continue

                self._set_status(item_id, "downloading")
                self._download_done = asyncio.Event()
                self._last_summary = None

                started = await dl_mgr.start_download(url)
                if not started:
                    self._set_status(item_id, "failed")
                    self._record_history(url, {"status": "failed", "failed": 1})
                    continue

                # Wait for the completion callback to fire.
                await self._download_done.wait()
                summary = self._last_summary or {"status": "completed"}
                final = "completed" if summary.get("status") == "completed" else "failed"
                self._set_status(item_id, final)
                self._record_history(url, summary)

                # Refresh the library after each completed download.
                if final == "completed":
                    try:
                        from library_manager import lib_mgr

                        lib_mgr.scan_library()
                    except Exception as e:
                        logger.debug(f"post-download scan failed: {e}")

            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.error(f"Queue loop error: {e}")
                await asyncio.sleep(2)


queue_processor = QueueProcessor()
