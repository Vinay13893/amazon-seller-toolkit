import os
from pydantic_settings import BaseSettings
from functools import lru_cache

# Always load .env from the saas-backend/ root, regardless of working directory
_ENV_FILE = os.path.join(os.path.dirname(os.path.dirname(__file__)), ".env")


class Settings(BaseSettings):
    APP_NAME: str = "e-Solz Amazon Tools"
    APP_VERSION: str = "1.0.0"
    DEBUG: bool = False

    SECRET_KEY: str
    ENCRYPTION_KEY: str

    DATABASE_URL: str
    REDIS_URL: str = "redis://localhost:6379/0"

    JWT_ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60 * 24  # 24 hours

    # AWS S3 — report file storage
    AWS_ACCESS_KEY_ID: str = ""
    AWS_SECRET_ACCESS_KEY: str = ""
    AWS_S3_BUCKET: str = "esolz-reports"
    AWS_REGION: str = "ap-south-1"

    # Resend — transactional email
    RESEND_API_KEY: str = ""

    # Admin — email that gets access to the /admin/* endpoints
    ADMIN_EMAIL: str = "test@esolz.com"
    FROM_EMAIL: str = "noreply@e-solz.com"

    # SP-API developer app (platform-level, shared across all users)
    SP_API_LWA_APP_ID: str = ""
    SP_API_LWA_CLIENT_SECRET: str = ""
    SP_API_AWS_ACCESS_KEY: str = ""
    SP_API_AWS_SECRET_KEY: str = ""

    # Amazon Ads API developer app
    ADS_CLIENT_ID: str = ""
    ADS_CLIENT_SECRET: str = ""

    class Config:
        env_file = _ENV_FILE
        case_sensitive = True


@lru_cache()
def get_settings() -> Settings:
    return Settings()
