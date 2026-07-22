"""Apple Music authentication flow (delegates container work to wrapper_mgr)."""
import os

from wrapper_manager import wrapper_mgr
from settings import get_settings
from logger import get_logger

logger = get_logger("auth")


class AuthManager:
    """Login, 2FA submission, logout, and session persistence checks."""

    def __init__(self) -> None:
        self._pending_2fa = False

    def _data_path(self) -> str:
        return get_settings().get("wrapper_data_path")

    def is_logged_in(self) -> bool:
        """A saved session means non-2FA files exist under rootfs/data."""
        data_path = self._data_path()
        if not data_path or not os.path.isdir(data_path):
            return False
        try:
            files = os.listdir(data_path)
        except OSError:
            return False
        session_files = [
            f
            for f in files
            if f not in ("2fa.txt",) and not f.endswith(".tmp")
        ]
        return len(session_files) > 0

    def get_auth_status(self) -> dict:
        logged_in = self.is_logged_in()
        wrapper = wrapper_mgr.get_wrapper_status()
        return {
            "logged_in": logged_in,
            "pending_2fa": wrapper.get("pending_2fa", self._pending_2fa),
            "message": "Signed in" if logged_in else "Not signed in",
        }

    async def login(self, email: str, password: str) -> bool:
        """Start the wrapper in login mode. Progress arrives via ws/auth."""
        self._pending_2fa = False
        success = wrapper_mgr.start_wrapper_login(email, password)
        return success

    def submit_2fa(self, code: str) -> bool:
        """Write the 2FA code where the wrapper's -F flag will read it."""
        data_path = self._data_path()
        try:
            os.makedirs(data_path, exist_ok=True)
        except OSError as e:
            logger.error(f"Cannot create wrapper data path: {e}")
            return False
        twofa_file = os.path.join(data_path, "2fa.txt")
        try:
            with open(twofa_file, "w", encoding="utf-8") as f:
                f.write(code.strip())
            logger.info("2FA code written to file")
            self._pending_2fa = False
            return True
        except OSError as e:
            logger.error(f"Failed to write 2FA code: {e}")
            return False

    def logout(self) -> bool:
        """Stop the wrapper and clear all session data."""
        wrapper_mgr.stop_wrapper()
        data_path = self._data_path()
        if data_path and os.path.isdir(data_path):
            for f in os.listdir(data_path):
                try:
                    os.remove(os.path.join(data_path, f))
                except OSError as e:
                    logger.warning(f"Could not remove {f}: {e}")
        logger.info("Logged out and cleared session data")
        return True


auth_mgr = AuthManager()
