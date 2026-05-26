import uuid
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from typing import List
from uuid import UUID
from ..database import get_db
from ..models import User, ASIN
from ..schemas import ASINCreate, ASINOut
from ..auth import get_current_user

router = APIRouter(prefix="/asins", tags=["asins"])

# Per-plan ASIN tracking limits
PLAN_LIMITS = {
    "free": 3,
    "starter": 10,
    "growth": 50,
    "pro": 9999,
    "agency": 9999,
}


@router.get("", response_model=List[ASINOut])
def list_asins(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return db.query(ASIN).filter(
        ASIN.user_id == current_user.id,
        ASIN.is_active == True,
    ).order_by(ASIN.created_at.desc()).all()


@router.post("", response_model=ASINOut, status_code=status.HTTP_201_CREATED)
def add_asin(
    payload: ASINCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    limit = PLAN_LIMITS.get(current_user.plan.value, 3)
    count = db.query(ASIN).filter(
        ASIN.user_id == current_user.id,
        ASIN.is_active == True,
    ).count()

    if count >= limit:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"ASIN limit reached ({limit} on your {current_user.plan.value} plan). Upgrade to track more.",
        )

    # Reactivate if previously soft-deleted
    existing = db.query(ASIN).filter(
        ASIN.user_id == current_user.id,
        ASIN.asin == payload.asin,
        ASIN.marketplace == payload.marketplace,
    ).first()

    if existing:
        if not existing.is_active:
            existing.is_active = True
            if payload.label:
                existing.label = payload.label
            db.commit()
            db.refresh(existing)
            return existing
        raise HTTPException(status_code=400, detail="ASIN already being tracked")

    asin = ASIN(
        id=uuid.uuid4(),
        user_id=current_user.id,
        asin=payload.asin,
        marketplace=payload.marketplace,
        label=payload.label,
    )
    db.add(asin)
    db.commit()
    db.refresh(asin)
    return asin


@router.patch("/{asin_id}", response_model=ASINOut)
def update_asin_label(
    asin_id: UUID,
    label: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    asin = db.query(ASIN).filter(ASIN.id == asin_id, ASIN.user_id == current_user.id).first()
    if not asin:
        raise HTTPException(status_code=404, detail="ASIN not found")
    asin.label = label
    db.commit()
    db.refresh(asin)
    return asin


@router.delete("/{asin_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_asin(
    asin_id: UUID,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    asin = db.query(ASIN).filter(ASIN.id == asin_id, ASIN.user_id == current_user.id).first()
    if not asin:
        raise HTTPException(status_code=404, detail="ASIN not found")
    asin.is_active = False  # soft delete — preserve historical BSR data
    db.commit()
