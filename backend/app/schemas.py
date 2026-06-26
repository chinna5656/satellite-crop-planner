from typing import Annotated, Any

from pydantic import BaseModel, Field, field_validator, model_validator


BBox = Annotated[
    list[float],
    Field(
        min_length=4,
        max_length=4,
        description="[min_lon, min_lat, max_lon, max_lat] in EPSG:4326.",
        examples=[[-121.9, 37.1, -121.8, 37.2]],
    ),
]


class AnalyzeFieldRequest(BaseModel):
    bbox: BBox
    time_range: str = Field(
        description="STAC datetime interval, for example '2025-05-01/2025-06-01'."
    )
    rainfall_15d_mm: float | None = Field(
        default=None,
        ge=0,
        description=(
            "Optional 15-day cumulative rainfall metadata in millimeters. "
            "Use this until a rainfall provider is connected."
        ),
    )

    @field_validator("bbox")
    @classmethod
    def validate_bbox(cls, bbox: list[float]) -> list[float]:
        min_lon, min_lat, max_lon, max_lat = bbox
        if not (-180 <= min_lon < max_lon <= 180):
            raise ValueError("bbox longitude bounds must satisfy -180 <= min_lon < max_lon <= 180")
        if not (-90 <= min_lat < max_lat <= 90):
            raise ValueError("bbox latitude bounds must satisfy -90 <= min_lat < max_lat <= 90")
        return bbox

    @field_validator("time_range")
    @classmethod
    def validate_time_range(cls, value: str) -> str:
        if "/" not in value:
            raise ValueError("time_range must be a STAC datetime interval like YYYY-MM-DD/YYYY-MM-DD")
        return value


class PixelResult(BaseModel):
    lon: float
    lat: float
    ndvi: float | None
    lst_celsius: float | None
    ndvi_diff: float | None
    rainfall_15d_mm: float
    is_anomaly: int


class RasterSummary(BaseModel):
    mean: float | None
    min: float | None
    max: float | None
    valid_pixel_count: int


class AnalyzeFieldResponse(BaseModel):
    bbox: list[float]
    time_range: str
    crs: str
    sentinel_scene_ids: list[str]
    landsat_scene_ids: list[str]
    ndvi_summary: RasterSummary
    lst_summary: RasterSummary
    anomaly_count: int
    pixels: list[PixelResult]


class AnalyzeStressRequest(BaseModel):
    geometry: dict[str, Any] | None = Field(
        default=None,
        description="GeoJSON Polygon geometry from Leaflet Draw.",
    )
    coordinates: list | None = Field(
        default=None,
        description="GeoJSON Polygon coordinates in WGS84 lon/lat order.",
    )
    start_date: str = Field(description="Analysis start date in YYYY-MM-DD format.")
    end_date: str = Field(description="Analysis end date in YYYY-MM-DD format.")

    @field_validator("start_date", "end_date")
    @classmethod
    def validate_date(cls, value: str) -> str:
        parts = value.split("-")
        if len(parts) != 3 or any(not part.isdigit() for part in parts):
            raise ValueError("Dates must use YYYY-MM-DD format")
        return value

    @model_validator(mode="after")
    def validate_date_order(self) -> "AnalyzeStressRequest":
        if self.start_date > self.end_date:
            raise ValueError("start_date must be before or equal to end_date")
        return self

    def polygon_coordinates(self) -> list:
        if self.coordinates:
            return self.coordinates
        if self.geometry and self.geometry.get("type") == "Polygon":
            coordinates = self.geometry.get("coordinates")
            if coordinates:
                return coordinates
        raise ValueError("A GeoJSON Polygon geometry or coordinates array is required.")


class AnalyzeStressResponse(BaseModel):
    tile_url: str
    start_date: str
    end_date: str
    mean_ndvi: float
    mean_ndwi: float
    mean_lst_celsius: float | None
    rainfall_30d_mm: float
    risk_level: str
    pixel_count: str = "Planetary Computer tile"
    source: str = "Microsoft Planetary Computer"


class CropRecommendationResult(BaseModel):
    crop_type: str
    probability: float
    model_name: str = "crop_recommend_rf.pkl"


class NdwiForecastResult(BaseModel):
    horizon_days: int
    values: list[float]
    model_name: str = "ndwi_lstm.pt"


class LocalInferenceFeatures(BaseModel):
    ndwi: float
    ndvi: float
    lst_celsius: float
    chirps_30d_mm: float


class LocalInferenceResponse(BaseModel):
    features: LocalInferenceFeatures
    crop_recommendation: CropRecommendationResult
    ndwi_forecast: NdwiForecastResult
