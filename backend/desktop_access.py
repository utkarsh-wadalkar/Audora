"""Limit the desktop API to its Electron session and local development clients."""
import hmac
import os
import re

from starlette.datastructures import Headers
from starlette.responses import JSONResponse

LOOPBACK_ORIGIN = r"https?://(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?"
FILE_ORIGINS = ("null", "file://")
DESKTOP_TOKEN_HEADER = "x-audora-token"


class DesktopAccessMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] not in {"http", "websocket"}:
            await self.app(scope, receive, send)
            return

        headers = Headers(scope=scope)
        token = os.environ.get("AUDORA_DESKTOP_TOKEN")
        origin = headers.get("origin")
        trusted_origin = origin is None or bool(re.fullmatch(LOOPBACK_ORIGIN, origin))
        if origin in FILE_ORIGINS:
            trusted_origin = bool(token)
        # Electron's packaged file page omits Origin on HTTP requests but still
        # marks them cross-site. It must authenticate with the desktop token.
        if not token and origin is None and headers.get("sec-fetch-site") == "cross-site":
            trusted_origin = False
        preflight = (
            scope["type"] == "http"
            and scope["method"] == "OPTIONS"
            and headers.get("access-control-request-method")
        )
        authenticated = (
            not token or preflight
            or hmac.compare_digest(headers.get(DESKTOP_TOKEN_HEADER, "").encode(), token.encode())
        )
        if trusted_origin and authenticated:
            await self.app(scope, receive, send)
        elif scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 1008})
        else:
            await JSONResponse({"detail": "Unauthorized desktop request"}, status_code=403)(scope, receive, send)
