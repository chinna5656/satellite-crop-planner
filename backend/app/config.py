from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """การตั้งค่าระบบสำหรับ API วิเคราะห์พืช."""

    environment: str = Field(default="development")
    app_name: str = "API ระบบวางแผนและจัดการเพาะปลูกด้วยดาวเทียม"
    app_version: str = "1.0.0"
    docs_enabled: bool = True
    serve_frontend: bool = True
    cors_origins: list[str] = Field(
        default_factory=lambda: [
            "http://127.0.0.1:8000",
            "http://localhost:8000",
            "http://127.0.0.1:5500",
            "http://localhost:5500",
        ]
    )
    allowed_hosts: list[str] = Field(default_factory=lambda: ["127.0.0.1", "localhost", "*"])
    planetary_computer_stac_url: str = Field(
        default="https://planetarycomputer.microsoft.com/api/stac/v1"
    )
    max_cloud_cover: float = Field(default=10.0, ge=0.0, le=100.0)
    relaxed_max_cloud_cover: float = Field(default=80.0, ge=0.0, le=100.0)
    sentinel_collection: str = "sentinel-2-l2a"
    landsat_collection: str = "landsat-c2-l1"
    analysis_resolution_m: int = Field(default=10, gt=0)
    landsat_resolution_m: int = Field(default=30, gt=0)
    max_sentinel_items: int = Field(default=4, ge=1, le=20)
    max_landsat_items: int = Field(default=3, ge=1, le=20)
    max_response_pixels: int = Field(default=15000, ge=100, le=250000)
    default_rainfall_mm_15d: float = Field(default=0.0, ge=0.0)

    model_config = SettingsConfigDict(
        env_file=".env",
        env_prefix="CROP_API_",
        case_sensitive=False,
    )

    @property
    def is_production(self) -> bool:
        return self.environment.lower() == "production"


@lru_cache
def get_settings() -> Settings:
    return Settings()
