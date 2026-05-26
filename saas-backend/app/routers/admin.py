"""
Admin-only endpoints.  Only the account whose email matches ADMIN_EMAIL
in settings can call these.  Returns user list + usage stats.

GET /admin/users        → all users with their plan + ASIN count + last login
GET /admin/usage        → per-user tool usage summary (last 30 days by default)
GET /admin/usage/daily  → daily tool run counts for the chart
"""
from datetime import datetime, timedelta
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, text
from sqlalchemy.orm import Session

from ..auth import get_current_user
from ..config import get_settings
from ..database import get_db
from ..models import User, ASIN, ToolUsage

router = APIRouter(prefix="/admin", tags=["admin"])
settings = get_settings()


def _require_admin(user: User = Depends(get_current_user)):
    if user.email != settings.ADMIN_EMAIL:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin access only")
    return user


@router.get("/users")
def list_users(db: Session = Depends(get_db), _admin=Depends(_require_admin)):
    users = db.query(User).order_by(User.created_at.desc()).all()
    asin_counts = {
        row.user_id: row.cnt
        for row in db.query(ASIN.user_id, func.count(ASIN.id).label("cnt"))
                      .filter(ASIN.is_active == True)
                      .group_by(ASIN.user_id)
                      .all()
    }
    # Last tool run per user
    last_active = {
        row.user_id: row.latest
        for row in db.query(ToolUsage.user_id, func.max(ToolUsage.created_at).label("latest"))
                      .group_by(ToolUsage.user_id)
                      .all()
    }
    return [
        {
            "id": str(u.id),
            "email": u.email,
            "full_name": u.full_name or "",
            "plan": u.plan.value,
            "is_active": u.is_active,
            "asins_tracked": asin_counts.get(u.id, 0),
            "joined_at": u.created_at.isoformat(),
            "last_active": last_active[u.id].isoformat() if u.id in last_active else None,
        }
        for u in users
    ]


@router.get("/usage")
def usage_summary(days: int = 30, db: Session = Depends(get_db), _admin=Depends(_require_admin)):
    since = datetime.utcnow() - timedelta(days=days)
    rows = (
        db.query(
            ToolUsage.user_id,
            User.email,
            User.plan,
            ToolUsage.tool,
            func.count(ToolUsage.id).label("runs"),
            func.sum(ToolUsage.input_count).label("total_inputs"),
        )
        .join(User, User.id == ToolUsage.user_id)
        .filter(ToolUsage.created_at >= since)
        .group_by(ToolUsage.user_id, User.email, User.plan, ToolUsage.tool)
        .order_by(func.count(ToolUsage.id).desc())
        .all()
    )
    return [
        {
            "user_id": str(r.user_id),
            "email": r.email,
            "plan": r.plan.value,
            "tool": r.tool,
            "runs": r.runs,
            "total_inputs": int(r.total_inputs or 0),
        }
        for r in rows
    ]


@router.get("/usage/daily")
def usage_daily(days: int = 30, db: Session = Depends(get_db), _admin=Depends(_require_admin)):
    """Daily run counts per tool — for the admin chart."""
    since = datetime.utcnow() - timedelta(days=days)
    rows = (
        db.query(
            func.date(ToolUsage.created_at).label("day"),
            ToolUsage.tool,
            func.count(ToolUsage.id).label("runs"),
        )
        .filter(ToolUsage.created_at >= since)
        .group_by(func.date(ToolUsage.created_at), ToolUsage.tool)
        .order_by(text("day"))
        .all()
    )
    return [{"day": str(r.day), "tool": r.tool, "runs": r.runs} for r in rows]


@router.get("/stats")
def platform_stats(db: Session = Depends(get_db), _admin=Depends(_require_admin)):
    """Top-level KPIs for the admin panel header."""
    total_users  = db.query(func.count(User.id)).scalar()
    active_users = db.query(func.count(User.id)).filter(User.is_active == True).scalar()
    total_asins  = db.query(func.count(ASIN.id)).filter(ASIN.is_active == True).scalar()
    total_runs   = db.query(func.count(ToolUsage.id)).scalar()
    runs_today   = db.query(func.count(ToolUsage.id)).filter(
        ToolUsage.created_at >= datetime.utcnow().replace(hour=0, minute=0, second=0)
    ).scalar()
    plan_dist = {
        row.plan.value: row.cnt
        for row in db.query(User.plan, func.count(User.id).label("cnt")).group_by(User.plan).all()
    }
    return {
        "total_users": total_users,
        "active_users": active_users,
        "total_asins": total_asins,
        "total_tool_runs": total_runs,
        "runs_today": runs_today,
        "plan_distribution": plan_dist,
    }
