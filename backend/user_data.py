"""Adopt the database and settings from a prior packaged installation."""
from contextlib import closing
from pathlib import Path
import shutil
import sqlite3
from tempfile import TemporaryDirectory


def migrate_user_data(destination: Path, legacy: Path | None = None) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    if legacy is None:
        legacy = Path(__file__).resolve().parent / "data"
    installer_backup = destination.parent / "legacy-install-backup"
    previous_backup = installer_backup.with_suffix(".previous")

    for filename in ("audora.db", "settings.json"):
        target = destination / filename
        if target.exists():
            continue
        source = next(
            (folder / filename for folder in (installer_backup, legacy, previous_backup)
             if (folder / filename).is_file()),
            None,
        )
        if source is None:
            continue
        with TemporaryDirectory(prefix=".migration-", dir=destination) as temp:
            staged = Path(temp) / filename
            if filename == "audora.db":
                # SQLite's backup API includes committed WAL transactions.
                with closing(sqlite3.connect(source.resolve().as_uri() + "?mode=ro", uri=True)) as old:
                    with closing(sqlite3.connect(staged)) as new:
                        old.backup(new)
            else:
                shutil.copyfile(source, staged)
            staged.replace(target)
