from celery import Celery
from celery.schedules import crontab
from .config import get_settings

settings = get_settings()

celery = Celery(
    "esolz",
    broker=settings.REDIS_URL,
    backend=settings.REDIS_URL,
    include=["app.tasks.bsr", "app.tasks.tools"],
)

celery.conf.update(
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    timezone="UTC",
    enable_utc=True,
    task_track_started=True,
    worker_prefetch_multiplier=1,  # fair dispatch — one task at a time per worker
)

celery.conf.beat_schedule = {
    # Runs every day at 06:00 UTC (11:30 IST)
    "daily-bsr-scrape": {
        "task": "app.tasks.bsr.scrape_all_bsr",
        "schedule": crontab(hour=6, minute=0),
    },
}
