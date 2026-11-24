"""SQLAlchemy engine + session management on SQLite (WAL mode)."""
import os

from sqlalchemy import create_engine, event, inspect
from sqlalchemy.orm import declarative_base, sessionmaker
from runtime_platform import get_data_dir
from user_data import migrate_user_data

_DATA_DIR = get_data_dir()
_DB_PATH = os.path.join(_DATA_DIR, "audora.db")

SQLALCHEMY_DATABASE_URL = f"sqlite:///{_DB_PATH}"

engine = create_engine(
    SQLALCHEMY_DATABASE_URL,
    connect_args={"check_same_thread": False},
    future=True,
)


@event.listens_for(engine, "connect")
def _set_sqlite_pragma(dbapi_connection, _connection_record):
    """Enable WAL for concurrent reads during writes and enforce FKs."""
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.close()


SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
Base = declarative_base()


def init_db() -> None:
    """Create all tables. Import models first so they register on Base."""
    import models  # noqa: F401  (registers mappers on Base)

    migrate_user_data(_DATA_DIR)
    Base.metadata.create_all(bind=engine)
    with engine.begin() as connection:
        columns = inspect(connection).get_columns("library_tracks")
        if not any(column["name"] == "album_artist" for column in columns):
            connection.exec_driver_sql("ALTER TABLE library_tracks ADD COLUMN album_artist VARCHAR")


def get_db():
    """FastAPI dependency yielding a session that always closes."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
