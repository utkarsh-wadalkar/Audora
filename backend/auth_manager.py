"""Apple Music authentication flow (delegates container work to wrapper_mgr)."""
import os
import shutil

from wrapper_manager import wrapper_mgr
from settings import get_settings
from logger import get_logger

logger = get_logger("auth")

# The wrapper's base directory, RELATIVE to the mounted data volume.
#
# The container mount is  {wrapper_data_path} -> /app/rootfs/data  and the
# wrapper reports the 2FA file as (relative to its /app workdir):
#
#     rootfs//data/data/com.apple.android.music/files/2fa.txt
#
# i.e. absolute  /app/rootfs/data/data/com.apple.android.music/files/2fa.txt
#                 \_______________/ the mount point ends here
#
# so the tail below the mount — and therefore below wrapper_data_path on the
# host — has ONE "data" segment, not two. Note wrapper_data_path already ends
# in "rootfs/data"; re-appending the whole logged path would double-count it
# and write somewhere nothing reads, which is precisely the bug this fixes.
#
# Confirmed against the real session tree on disk:
#   {wrapper_data_path}/data/com.apple.android.music/files/adi.pb
#   {wrapper_data_path}/data/com.apple.android.music/files/mpl_db/accounts.sqlitedb
WRAPPER_BASE_SUBDIR = os.path.join("data", "com.apple.android.music", "files")

# Name of the file the wrapper's -F/--code-from-file flag polls for.
TWOFA_FILENAME = "2fa.txt"

# Files that only exist once a sign-in has actually completed. Device
# provisioning files (adi.pb, fsi.pdat, IC-Info.sids) appear on first run even
# without a successful login, so they are NOT proof of a session — only the
# account/token stores under mpl_db are.
_SESSION_MARKERS = (
    os.path.join("mpl_db", "accounts.sqlitedb"),
    os.path.join("mpl_db", "kvs.sqlitedb"),
)


class AuthManager:
    """Login, 2FA submission, logout, and session persistence checks."""

    def __init__(self) -> None:
        self._pending_2fa = False

    def _data_path(self) -> str:
        return get_settings().get("wrapper_data_path")

    def _base_dir(self) -> str:
        """Host directory the wrapper reads its 2FA code and session from."""
        data_path = self._data_path()
        if not data_path:
            return ""
        return os.path.join(data_path, WRAPPER_BASE_SUBDIR)

    def twofa_path(self) -> str:
        """Full host path of the 2FA code file the wrapper polls."""
        base_dir = self._base_dir()
        return os.path.join(base_dir, TWOFA_FILENAME) if base_dir else ""

    def is_logged_in(self) -> bool:
        """True only if a real session store exists in the wrapper's base dir.

        Previously this listed the volume root and counted any entry as a
        session, so the nested ``data/`` directory alone made it report "signed
        in" with no session at all — masking a failed sign-in.
        """
        base_dir = self._base_dir()
        if not base_dir:
            return False
        for marker in _SESSION_MARKERS:
            candidate = os.path.join(base_dir, marker)
            try:
                if os.path.isfile(candidate) and os.path.getsize(candidate) > 0:
                    return True
            except OSError:
                continue
        return False

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
        # Remove any leftover code first: the wrapper polls this file as soon as
        # it needs a code, so a stale one from a previous attempt would be
        # consumed immediately and rejected.
        self._clear_stale_2fa()
        success = wrapper_mgr.start_wrapper_login(email, password)
        return success

    def _clear_stale_2fa(self) -> None:
        """Delete a leftover 2FA code file, if any. Best effort."""
        for candidate in (self.twofa_path(), os.path.join(self._data_path() or "", TWOFA_FILENAME)):
            if not candidate:
                continue
            try:
                if os.path.isfile(candidate):
                    os.remove(candidate)
                    logger.info("Removed stale 2FA code file")
            except OSError as remove_error:
                logger.warning(f"Could not remove stale 2FA file: {remove_error}")

    def submit_2fa(self, code: str) -> bool:
        """Write the 2FA code where the wrapper's ``-F`` flag will read it.

        The wrapper polls a file several levels below the mounted volume root,
        so the intermediate directories are created if the wrapper has not
        already made them.
        """
        base_dir = self._base_dir()
        if not base_dir:
            logger.error("No wrapper data path configured; cannot write 2FA code")
            return False
        try:
            os.makedirs(base_dir, exist_ok=True)
        except OSError as mkdir_error:
            logger.error(f"Cannot create wrapper base dir {base_dir}: {mkdir_error}")
            return False

        twofa_file = os.path.join(base_dir, TWOFA_FILENAME)
        try:
            # No trailing newline: the wrapper's own example is
            # `echo -n 114514 > ...`, i.e. the bare digits.
            with open(twofa_file, "w", encoding="utf-8", newline="") as handle:
                handle.write(code.strip())
            logger.info(f"2FA code written to {twofa_file}")
            self._pending_2fa = False
            return True
        except OSError as write_error:
            logger.error(f"Failed to write 2FA code: {write_error}")
            return False

    def logout(self) -> bool:
        """Stop the wrapper and clear all session data.

        Uses ``shutil.rmtree`` for directories: the session lives in nested
        subdirectories, and the previous ``os.remove``-only loop raised on the
        first directory it met, leaving accounts.sqlitedb — and therefore the
        session — intact.
        """
        wrapper_mgr.stop_wrapper()
        data_path = self._data_path()
        if data_path and os.path.isdir(data_path):
            for entry in os.listdir(data_path):
                target = os.path.join(data_path, entry)
                try:
                    if os.path.isdir(target):
                        shutil.rmtree(target)
                    else:
                        os.remove(target)
                except OSError as remove_error:
                    logger.warning(f"Could not remove {entry}: {remove_error}")
        logger.info("Logged out and cleared session data")
        return True


auth_mgr = AuthManager()
