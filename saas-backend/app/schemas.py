from pydantic import BaseModel, EmailStr, field_validator, computed_field
from datetime import datetime
from typing import Optional, List
from uuid import UUID
from .models import PlanTier
from .config import get_settings


# ─── Auth ────────────────────────────────────────────────────

class UserSignup(BaseModel):
    email: EmailStr
    password: str
    full_name: Optional[str] = None

    @field_validator("password")
    @classmethod
    def password_strength(cls, v: str) -> str:
        if len(v) < 8:
            raise ValueError("Password must be at least 8 characters")
        return v


class UserLogin(BaseModel):
    email: EmailStr
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"


class UserOut(BaseModel):
    id: UUID
    email: str
    full_name: Optional[str]
    plan: PlanTier
    is_active: bool
    created_at: datetime

    @computed_field
    @property
    def is_admin(self) -> bool:
        return self.email == get_settings().ADMIN_EMAIL

    model_config = {"from_attributes": True}


# ─── Amazon Credentials ──────────────────────────────────────

class CredentialConnect(BaseModel):
    """User submits their own Amazon refresh tokens to connect their account."""
    marketplace: str = "amazon.in"
    sp_refresh_token: Optional[str] = None
    seller_id: Optional[str] = None
    ads_refresh_token: Optional[str] = None
    ads_profile_id: Optional[str] = None


class CredentialStatus(BaseModel):
    marketplace: str
    sp_connected: bool
    ads_connected: bool
    seller_id: Optional[str]
    ads_profile_id: Optional[str]
    last_sync_at: Optional[datetime]

    model_config = {"from_attributes": True}


# ─── ASINs ───────────────────────────────────────────────────

class ASINCreate(BaseModel):
    asin: str
    marketplace: str = "amazon.in"
    label: Optional[str] = None

    @field_validator("asin")
    @classmethod
    def validate_asin(cls, v: str) -> str:
        v = v.strip().upper()
        if len(v) != 10 or not v.startswith("B"):
            raise ValueError("Invalid ASIN format — must be 10 characters starting with B")
        return v


class ASINOut(BaseModel):
    id: UUID
    asin: str
    marketplace: str
    label: Optional[str]
    is_active: bool
    created_at: datetime

    model_config = {"from_attributes": True}


# ─── BSR ─────────────────────────────────────────────────────

class BSRDataPoint(BaseModel):
    bsr_rank: Optional[int]
    category: Optional[str]
    sub_rank: Optional[int]
    sub_category: Optional[str]
    captured_at: datetime

    model_config = {"from_attributes": True}


class BSRHistoryResponse(BaseModel):
    asin: str
    label: Optional[str]
    data: List[BSRDataPoint]


class BSRSummaryItem(BaseModel):
    asin_id: str
    asin: str
    label: Optional[str]
    bsr_rank: Optional[int]
    category: Optional[str]
    sub_rank: Optional[int] = None
    sub_category: Optional[str] = None
    captured_at: Optional[str]


# ─── Keyword Rank ────────────────────────────────────────────

class KeywordRankOut(BaseModel):
    asin: str
    keyword: str
    rank: Optional[int]
    page: Optional[int]
    captured_at: datetime

    model_config = {"from_attributes": True}
