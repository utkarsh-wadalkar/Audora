import sys
from pathlib import Path

import pytest
from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from desktop_access import DESKTOP_TOKEN_HEADER, DesktopAccessMiddleware, FILE_ORIGINS, LOOPBACK_ORIGIN


@pytest.fixture
def client():
    app = FastAPI()
    app.add_middleware(CORSMiddleware, allow_origins=FILE_ORIGINS, allow_origin_regex=LOOPBACK_ORIGIN,
                       allow_methods=["*"], allow_headers=["*"])
    app.add_middleware(DesktopAccessMiddleware)

    @app.api_route("/settings", methods=["GET", "POST"])
    def settings():
        return {"ok": True}

    @app.websocket("/updates")
    async def updates(websocket: WebSocket):
        await websocket.accept()
        await websocket.send_json({"ok": True})

    return TestClient(app)


def test_packaged_file_renderer_needs_session_token(client, monkeypatch):
    monkeypatch.setenv("AUDORA_DESKTOP_TOKEN", "desktop-test-token")
    assert client.get("/settings", headers={"Origin": "null"}).status_code == 403
    assert client.get("/settings").status_code == 403
    headers = {"Origin": "null", DESKTOP_TOKEN_HEADER: "desktop-test-token"}
    response = client.get("/settings", headers=headers)
    assert response.status_code == 200
    assert response.headers["Access-Control-Allow-Origin"] == "null"
    assert client.get("/settings", headers={**headers, "Origin": "https://third-party.example"}).status_code == 403
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/updates", headers={"Origin": "null"}):
            pass
    with client.websocket_connect("/updates", headers={**headers, "Origin": "file://"}) as connection:
        assert connection.receive_json() == {"ok": True}


def test_file_renderer_preflight_and_local_dev_only(client, monkeypatch):
    monkeypatch.setenv("AUDORA_DESKTOP_TOKEN", "desktop-test-token")
    preflight = client.options("/settings", headers={
        "Origin": "null", "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": DESKTOP_TOKEN_HEADER,
    })
    assert preflight.status_code == 200
    assert preflight.headers["Access-Control-Allow-Origin"] == "null"
    monkeypatch.delenv("AUDORA_DESKTOP_TOKEN")
    origin = "http://localhost:5181"
    local = client.get("/settings", headers={"Origin": origin})
    assert local.status_code == 200
    assert local.headers["Access-Control-Allow-Origin"] == origin
    for untrusted in (*FILE_ORIGINS, "https://third-party.example"):
        response = client.get("/settings", headers={"Origin": untrusted})
        assert response.status_code == 403
        assert "Access-Control-Allow-Origin" not in response.headers
    assert client.get("/settings", headers={"Sec-Fetch-Site": "cross-site"}).status_code == 403


def test_packaged_electron_http_requests_without_origin(client, monkeypatch):
    monkeypatch.setenv("AUDORA_DESKTOP_TOKEN", "desktop-test-token")
    headers = {"Sec-Fetch-Site": "cross-site"}
    for method in ("GET", "POST"):
        assert client.request(method, "/settings", headers=headers).status_code == 403
        assert client.request(method, "/settings", headers={
            **headers, DESKTOP_TOKEN_HEADER: "other-session",
        }).status_code == 403
        assert client.request(method, "/settings", headers={
            **headers, DESKTOP_TOKEN_HEADER: "desktop-test-token",
        }).status_code == 200
