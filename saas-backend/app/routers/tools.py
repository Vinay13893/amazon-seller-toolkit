"""
One-shot tool endpoints.

POST /tools/rank     → queue keyword rank task
POST /tools/hijack   → queue hijack check task
POST /tools/pincode  → queue pincode check task
GET  /tools/result/{task_id} → poll task state + results
"""
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from celery.result import AsyncResult
from sqlalchemy.orm import Session

from ..auth import get_current_user
from ..celery_app import celery
from ..database import get_db
from ..models import ToolUsage
from ..tasks.tools import keyword_rank, hijack_check, pincode_check

router = APIRouter(prefix="/tools", tags=["tools"])


# ─── Request schemas ──────────────────────────────────────────────────────
class RankPair(BaseModel):
    keyword: str
    asin: str


class RankRequest(BaseModel):
    pairs: list[RankPair]
    marketplace: str = "IN"


class HijackItem(BaseModel):
    asin: str
    authorized_seller: str = ""


class HijackRequest(BaseModel):
    items: list[HijackItem]
    marketplace: str = "IN"


class PincodeRequest(BaseModel):
    asins: list[str]
    pincodes: list[str]


# ─── Endpoints ────────────────────────────────────────────────────────────
@router.post("/rank", status_code=status.HTTP_202_ACCEPTED)
def queue_rank(req: RankRequest, user=Depends(get_current_user), db: Session = Depends(get_db)):
    if not req.pairs:
        raise HTTPException(400, "pairs list is empty")
    if len(req.pairs) > 20:
        raise HTTPException(400, "max 20 keyword/ASIN pairs per request")
    task = keyword_rank.delay(
        [p.model_dump() for p in req.pairs],
        req.marketplace,
    )
    db.add(ToolUsage(user_id=user.id, tool="rank", input_count=len(req.pairs), marketplace=req.marketplace, task_id=task.id))
    db.commit()
    return {"queued": True, "task_id": task.id}


@router.post("/hijack", status_code=status.HTTP_202_ACCEPTED)
def queue_hijack(req: HijackRequest, user=Depends(get_current_user), db: Session = Depends(get_db)):
    if not req.items:
        raise HTTPException(400, "items list is empty")
    if len(req.items) > 10:
        raise HTTPException(400, "max 10 ASINs per request")
    task = hijack_check.delay(
        [i.model_dump() for i in req.items],
        req.marketplace,
    )
    db.add(ToolUsage(user_id=user.id, tool="hijack", input_count=len(req.items), marketplace=req.marketplace, task_id=task.id))
    db.commit()
    return {"queued": True, "task_id": task.id}


@router.post("/pincode", status_code=status.HTTP_202_ACCEPTED)
def queue_pincode(req: PincodeRequest, user=Depends(get_current_user), db: Session = Depends(get_db)):
    if not req.asins or not req.pincodes:
        raise HTTPException(400, "asins and pincodes must not be empty")
    if len(req.asins) > 10:
        raise HTTPException(400, "max 10 ASINs per request")
    if len(req.pincodes) > 10:
        raise HTTPException(400, "max 10 pincodes per request")
    task = pincode_check.delay(req.asins, req.pincodes)
    db.add(ToolUsage(user_id=user.id, tool="pincode", input_count=len(req.asins)*len(req.pincodes), task_id=task.id))
    db.commit()
    return {"queued": True, "task_id": task.id}


@router.get("/result/{task_id}")
def get_result(task_id: str, _user=Depends(get_current_user)):
    res = AsyncResult(task_id, app=celery)
    if res.state == "PENDING":
        return {"state": "PENDING", "result": None}
    if res.state == "STARTED":
        return {"state": "STARTED", "result": None}
    if res.state == "SUCCESS":
        return {"state": "SUCCESS", "result": res.result}
    if res.state == "FAILURE":
        return {"state": "FAILURE", "result": None, "error": str(res.result)}
    return {"state": res.state, "result": None}
