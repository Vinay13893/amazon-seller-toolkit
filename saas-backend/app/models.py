import uuid
import enum
from datetime import datetime
from sqlalchemy import (
    Column, String, Integer, Boolean, DateTime,
    ForeignKey, Text, Enum as SAEnum, BigInteger, Uuid,
)

# SQLite only auto-increments INTEGER PRIMARY KEY, not BIGINT.
# Use this for history table PKs so local dev works and production
# PostgreSQL still gets a proper BigInteger column.
_BigPK = BigInteger().with_variant(Integer, "sqlite")
from sqlalchemy.orm import relationship
from .database import Base


class PlanTier(str, enum.Enum):
    free = "free"
    starter = "starter"
    growth = "growth"
    pro = "pro"
    agency = "agency"


class JobStatus(str, enum.Enum):
    pending = "pending"
    running = "running"
    done = "done"
    failed = "failed"


class User(Base):
    __tablename__ = "users"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email = Column(String(255), unique=True, nullable=False, index=True)
    password_hash = Column(String(255), nullable=False)
    full_name = Column(String(255), nullable=True)
    plan = Column(SAEnum(PlanTier), default=PlanTier.free, nullable=False)
    is_active = Column(Boolean, default=True, nullable=False)
    is_verified = Column(Boolean, default=False, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    subscription_expires_at = Column(DateTime, nullable=True)

    credentials = relationship("SellerCredential", back_populates="user", cascade="all, delete-orphan")
    asins = relationship("ASIN", back_populates="user", cascade="all, delete-orphan")
    keyword_ranks = relationship("KeywordRank", back_populates="user", cascade="all, delete-orphan")
    jobs = relationship("JobLog", back_populates="user", cascade="all, delete-orphan")


class SellerCredential(Base):
    """
    Stores per-user Amazon API tokens, encrypted at rest using Fernet.
    Platform-level LWA app_id / client_secret / AWS keys come from env vars,
    not stored here. Only the user's refresh_token is stored.
    """
    __tablename__ = "seller_credentials"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(Uuid(as_uuid=True), ForeignKey("users.id"), nullable=False, index=True)
    marketplace = Column(String(50), default="amazon.in", nullable=False)
    seller_id = Column(String(100), nullable=True)

    # SP-API refresh token (Fernet-encrypted)
    sp_refresh_token_enc = Column(Text, nullable=True)

    # Amazon Ads API refresh token (Fernet-encrypted)
    ads_refresh_token_enc = Column(Text, nullable=True)
    ads_profile_id = Column(String(100), nullable=True)

    connected_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    last_sync_at = Column(DateTime, nullable=True)

    user = relationship("User", back_populates="credentials")


class ASIN(Base):
    __tablename__ = "asins"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(Uuid(as_uuid=True), ForeignKey("users.id"), nullable=False, index=True)
    asin = Column(String(20), nullable=False)
    marketplace = Column(String(50), default="amazon.in", nullable=False)
    label = Column(String(255), nullable=True)  # user-friendly name e.g. "EVA Gym Mat Black"
    is_active = Column(Boolean, default=True, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    user = relationship("User", back_populates="asins")
    bsr_history = relationship("BSRHistory", back_populates="asin", cascade="all, delete-orphan")


class BSRHistory(Base):
    __tablename__ = "bsr_history"

    id = Column(_BigPK, primary_key=True, autoincrement=True)
    asin_id = Column(Uuid(as_uuid=True), ForeignKey("asins.id"), nullable=False, index=True)
    bsr_rank = Column(Integer, nullable=True)
    category = Column(String(255), nullable=True)
    sub_rank = Column(Integer, nullable=True)
    sub_category = Column(String(255), nullable=True)
    captured_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)

    asin = relationship("ASIN", back_populates="bsr_history")


class KeywordRank(Base):
    __tablename__ = "keyword_ranks"

    id = Column(_BigPK, primary_key=True, autoincrement=True)
    user_id = Column(Uuid(as_uuid=True), ForeignKey("users.id"), nullable=False, index=True)
    asin = Column(String(20), nullable=False)
    keyword = Column(String(500), nullable=False)
    rank = Column(Integer, nullable=True)   # NULL = not found in top results
    page = Column(Integer, nullable=True)
    marketplace = Column(String(50), default="amazon.in", nullable=False)
    captured_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)

    user = relationship("User", back_populates="keyword_ranks")


class JobLog(Base):
    """Tracks background scraping / sync jobs per user."""
    __tablename__ = "job_logs"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(Uuid(as_uuid=True), ForeignKey("users.id"), nullable=True, index=True)
    job_type = Column(String(50), nullable=False)   # bsr_scrape | keyword_rank | ads_sync
    status = Column(SAEnum(JobStatus), default=JobStatus.pending, nullable=False)
    error_message = Column(Text, nullable=True)
    started_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    completed_at = Column(DateTime, nullable=True)

    user = relationship("User", back_populates="jobs")


class ToolUsage(Base):
    """Logs every tool invocation for analytics and plan enforcement."""
    __tablename__ = "tool_usage"

    id = Column(_BigPK, primary_key=True, autoincrement=True)
    user_id = Column(Uuid(as_uuid=True), ForeignKey("users.id"), nullable=False, index=True)
    tool = Column(String(50), nullable=False, index=True)   # rank | hijack | pincode | bsr_refresh
    input_count = Column(Integer, default=1, nullable=False)  # pairs / ASINs / combos
    result_count = Column(Integer, nullable=True)             # rows returned
    marketplace = Column(String(10), nullable=True)
    task_id = Column(String(100), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)

    user = relationship("User")
