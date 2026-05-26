from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from typing import List
from datetime import datetime, timedelta
from uuid import UUID
from ..database import get_db
from ..models import User, ASIN, BSRHistory as BSRModel
from ..schemas import BSRHistoryResponse, BSRDataPoint, BSRSummaryItem
from ..auth import get_current_user
from ..tasks.bsr import scrape_bsr_for_user

router = APIRouter(prefix="/bsr", tags=["bsr"])


@router.get("/summary", response_model=List[BSRSummaryItem])
def bsr_summary(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Latest BSR snapshot for all tracked ASINs — for the dashboard overview card."""
    asins = db.query(ASIN).filter(
        ASIN.user_id == current_user.id,
        ASIN.is_active == True,
    ).all()

    result = []
    for a in asins:
        latest = (
            db.query(BSRModel)
            .filter(BSRModel.asin_id == a.id)
            .order_by(BSRModel.captured_at.desc())
            .first()
        )
        result.append(BSRSummaryItem(
            asin_id=str(a.id),
            asin=a.asin,
            label=a.label,
            bsr_rank=latest.bsr_rank if latest else None,
            category=latest.category if latest else None,
            sub_rank=latest.sub_rank if latest else None,
            sub_category=latest.sub_category if latest else None,
            captured_at=latest.captured_at.isoformat() if latest else None,
        ))

    return sorted(result, key=lambda x: (x.bsr_rank or 999_999_999))


@router.get("/{asin_id}", response_model=BSRHistoryResponse)
def bsr_history(
    asin_id: UUID,
    days: int = Query(30, ge=1, le=365),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Full BSR history chart data for a single ASIN."""
    asin = db.query(ASIN).filter(
        ASIN.id == asin_id,
        ASIN.user_id == current_user.id,
    ).first()
    if not asin:
        raise HTTPException(status_code=404, detail="ASIN not found")

    since = datetime.utcnow() - timedelta(days=days)
    history = (
        db.query(BSRModel)
        .filter(BSRModel.asin_id == asin_id, BSRModel.captured_at >= since)
        .order_by(BSRModel.captured_at.asc())
        .all()
    )

    return BSRHistoryResponse(
        asin=asin.asin,
        label=asin.label,
        data=[BSRDataPoint.model_validate(h) for h in history],
    )


@router.post("/refresh", status_code=202)
def trigger_refresh(
    current_user: User = Depends(get_current_user),
):
    """Enqueue a BSR scrape for the current user's ASINs (runs in background)."""
    task = scrape_bsr_for_user.delay(str(current_user.id))
    return {"queued": True, "task_id": task.id}
