"""Pydantic v2 schemas for request/response bodies."""
from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict


# --- Generic envelope (Audora.md Section 7.4) ---
class ApiResponse(BaseModel):
    success: bool = True
    data: Any = None
    error: Optional[str] = None


# --- Auth ---
class LoginRequest(BaseModel):
    email: str
    password: str


class TwoFARequest(BaseModel):
    code: str


class AuthStatus(BaseModel):
    logged_in: bool
    pending_2fa: bool = False
    message: str = ""


# --- Download ---
class DownloadRequest(BaseModel):
    url: str
    format: Optional[str] = None  # alac | aac | atmos; None => use settings default


class DownloadResponse(BaseModel):
    started: bool


# --- Queue ---
class QueueItemCreate(BaseModel):
    url: str


class QueueItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    url: str
    title: Optional[str] = None
    status: str
    position: int
    created_at: Optional[datetime] = None


# --- History ---
class HistoryItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    url: str
    title: Optional[str] = None
    status: str
    track_count: int = 0
    error_count: int = 0
    created_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None


# --- Library ---
class TrackOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: Optional[int] = None
    file_path: str
    title: Optional[str] = None
    artist: Optional[str] = None
    album: Optional[str] = None
    duration: int = 0
    file_size: int = 0
    format: Optional[str] = None


# --- Settings ---
class SettingsUpdate(BaseModel):
    downloads_path: Optional[str] = None
    wrapper_data_path: Optional[str] = None
    auto_start_wrapper: Optional[bool] = None
    backend_port: Optional[int] = None
    log_level: Optional[str] = None
    download_format: Optional[str] = None
    setup_complete: Optional[bool] = None
    keep_wrapper_running: Optional[bool] = None


class SettingsOut(BaseModel):
    downloads_path: str
    wrapper_data_path: str
    auto_start_wrapper: bool
    backend_port: int
    log_level: str
    download_format: str = "alac"
    setup_complete: bool = False


# --- Status ---
class DockerStatus(BaseModel):
    running: bool
    message: str = ""


class WrapperStatus(BaseModel):
    running: bool
    ready: bool = False
    message: str = ""
