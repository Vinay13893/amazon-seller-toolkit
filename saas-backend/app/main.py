import os
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from .config import get_settings
from .database import Base, engine
from .routers import users, asins, bsr, tools, admin

_STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")

settings = get_settings()

# Create all tables (switch to Alembic migrations before production)
Base.metadata.create_all(bind=engine)

app = FastAPI(
    title=settings.APP_NAME,
    version=settings.APP_VERSION,
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    openapi_url="/api/openapi.json",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://e-solz.com",
        "https://www.e-solz.com",
        "https://esolz-web.onrender.com",
        "http://localhost:8000",
        "http://localhost:3000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(users.router, prefix="/api/v1")
app.include_router(asins.router, prefix="/api/v1")
app.include_router(bsr.router, prefix="/api/v1")
app.include_router(admin.router, prefix="/api/v1")
app.include_router(tools.router, prefix="/api/v1")

app.mount("/static", StaticFiles(directory=_STATIC_DIR), name="static")


@app.get("/health", tags=["system"])
def health():
    return {"status": "ok", "app": settings.APP_NAME, "version": settings.APP_VERSION}


@app.get("/", include_in_schema=False)
@app.get("/app", include_in_schema=False)
def serve_app():
    return FileResponse(os.path.join(_STATIC_DIR, "index.html"))
