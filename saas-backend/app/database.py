from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base
from .config import get_settings

settings = get_settings()

# Normalise legacy postgres:// URLs to psycopg3 scheme for PostgreSQL.
# SQLite URLs (sqlite:///...) pass through unchanged.
_db_url = settings.DATABASE_URL
if _db_url.startswith("postgresql://") or _db_url.startswith("postgres://"):
    _db_url = _db_url.replace("postgresql://", "postgresql+psycopg://", 1)
    _db_url = _db_url.replace("postgres://", "postgresql+psycopg://", 1)

_kwargs = {}
if _db_url.startswith("sqlite"):
    _kwargs["connect_args"] = {"check_same_thread": False}

engine = create_engine(_db_url, pool_pre_ping=True, **_kwargs)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
