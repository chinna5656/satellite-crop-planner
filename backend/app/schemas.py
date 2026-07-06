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
    bbox: BBox | None = None
    polygon: dict[str, Any] | None = Field(
        default=None,
        description="Optional GeoJSON Polygon geometry. Used to derive bbox when bbox is omitted.",
    )
    geometry: dict[str, Any] | None = Field(
        default=None,
        description="Optional GeoJSON geometry. Used to derive bbox when bbox is omitted.",
    )
    coordinates: list | None = Field(
        default=None,
        description="Optional GeoJSON Polygon coordinates. Used to derive bbox when bbox is omitted.",
    )
    time_range: str | None = Field(
        default=None,
        description="STAC datetime interval, for example '2025-05-01/2025-06-01'."
    )
    start_date: str | None = Field(
        default=None,
        description="Optional start date in YYYY-MM-DD format. Used when time_range is omitted.",
    )
    end_date: str | None = Field(
        default=None,
        description="Optional end date in YYYY-MM-DD format. Used when time_range is omitted.",
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
    def validate_bbox(cls, bbox: list[float] | None) -> list[float] | None:
        if bbox is None:
            return bbox
        min_lon, min_lat, max_lon, max_lat = bbox
        cls._validate_bbox_bounds(min_lon, min_lat, max_lon, max_lat)
        return bbox

    @staticmethod
    def _validate_bbox_bounds(
        min_lon: float,
        min_lat: float,
        max_lon: float,
        max_lat: float,
    ) -> None:
        if not (-180 <= min_lon < max_lon <= 180):
            raise ValueError("bbox longitude bounds must satisfy -180 <= min_lon < max_lon <= 180")
        if not (-90 <= min_lat < max_lat <= 90):
            raise ValueError("bbox latitude bounds must satisfy -90 <= min_lat < max_lat <= 90")

    @staticmethod
    def _bbox_to_polygon(bbox: list[float]) -> dict[str, Any]:
        min_lon, min_lat, max_lon, max_lat = bbox
        return {
            "type": "Polygon",
            "coordinates": [
                [
                    [min_lon, min_lat],
                    [max_lon, min_lat],
                    [max_lon, max_lat],
                    [min_lon, max_lat],
                    [min_lon, min_lat],
                ]
            ],
        }

    @staticmethod
    def _normalize_polygon_coordinates(coordinates: list) -> list:
        if not coordinates:
            raise ValueError("GeoJSON Polygon coordinates cannot be empty.")

        first = coordinates[0]
        if (
            isinstance(first, (list, tuple))
            and len(first) >= 2
            and isinstance(first[0], (int, float))
            and isinstance(first[1], (int, float))
        ):
            ring = coordinates
        else:
            ring = first

        points = [
            [float(point[0]), float(point[1])]
            for point in ring
            if isinstance(point, (list, tuple))
            and len(point) >= 2
            and isinstance(point[0], (int, float))
            and isinstance(point[1], (int, float))
        ]
        if len(points) < 3:
            raise ValueError("GeoJSON Polygon coordinates must contain at least three lon/lat points.")

        if points[0] != points[-1]:
            points.append(points[0])
        return [points]

    @staticmethod
    def _derive_bbox_from_coordinates(coordinates: list) -> list[float]:
        points = AnalyzeFieldRequest._normalize_polygon_coordinates(coordinates)[0]

        lon_values = [float(point[0]) for point in points]
        lat_values = [float(point[1]) for point in points]
        bbox = [min(lon_values), min(lat_values), max(lon_values), max(lat_values)]
        AnalyzeFieldRequest._validate_bbox_bounds(*bbox)
        return bbox

    @field_validator("time_range")
    @classmethod
    def validate_time_range(cls, value: str | None) -> str | None:
        if value is None:
            return value
        if "/" not in value:
            raise ValueError("time_range must be a STAC datetime interval like YYYY-MM-DD/YYYY-MM-DD")
        return value

    @field_validator("start_date", "end_date")
    @classmethod
    def validate_optional_date(cls, value: str | None) -> str | None:
        if value is None:
            return value
        parts = value.split("-")
        if len(parts) != 3 or any(not part.isdigit() for part in parts):
            raise ValueError("Dates must use YYYY-MM-DD format")
        return value

    @model_validator(mode="after")
    def normalize_time_range(self) -> "AnalyzeFieldRequest":
        coordinates = self.coordinates
        geometry = self.geometry or self.polygon
        if geometry:
            if geometry.get("type") != "Polygon":
                raise ValueError("geometry must be a GeoJSON Polygon.")
            coordinates = geometry.get("coordinates")

        if self.bbox is None:
            if coordinates:
                self.bbox = self._derive_bbox_from_coordinates(coordinates)
            else:
                raise ValueError("Send bbox or a GeoJSON Polygon geometry.")

        if coordinates:
            self.polygon = {
                "type": "Polygon",
                "coordinates": self._normalize_polygon_coordinates(coordinates),
            }
        elif self.bbox:
            self.polygon = self._bbox_to_polygon(self.bbox)

        if self.time_range:
            start_date, end_date = self.time_range.split("/", 1)
        elif self.start_date and self.end_date:
            start_date, end_date = self.start_date, self.end_date
            self.time_range = f"{start_date}/{end_date}"
        else:
            raise ValueError("Send either time_range or both start_date and end_date.")

        if start_date > end_date:
            raise ValueError("start_date must be before or equal to end_date")
        return self


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
    polygon: dict[str, Any] | None = None
    time_range: str
    crs: str
    sentinel_scene_ids: list[str]
    landsat_scene_ids: list[str]
    ndvi_summary: RasterSummary
    lst_summary: RasterSummary
    lst_status: str = "unknown"
    lst_error: str | None = None
    anomaly_model_features: list[str] = Field(default_factory=list)
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
    start_date: str | None = Field(
        default=None,
        description="Analysis start date in YYYY-MM-DD format.",
    )
    end_date: str | None = Field(
        default=None,
        description="Analysis end date in YYYY-MM-DD format.",
    )
    target_date: str | None = Field(
        default=None,
        description="Optional target date. The API looks back 30 days when start_date/end_date are omitted.",
    )
    time_range: str | None = Field(
        default=None,
        description="Optional STAC datetime interval, for example '2025-05-01/2025-06-01'.",
    )

    @field_validator("start_date", "end_date", "target_date")
    @classmethod
    def validate_date(cls, value: str | None) -> str | None:
        if value is None:
            return value
        parts = value.split("-")
        if len(parts) != 3 or any(not part.isdigit() for part in parts):
            raise ValueError("Dates must use YYYY-MM-DD format")
        return value

    @field_validator("time_range")
    @classmethod
    def validate_stress_time_range(cls, value: str | None) -> str | None:
        if value is None:
            return value
        if "/" not in value:
            raise ValueError("time_range must be a STAC datetime interval like YYYY-MM-DD/YYYY-MM-DD")
        return value

    @model_validator(mode="after")
    def normalize_dates(self) -> "AnalyzeStressRequest":
        if self.start_date and self.end_date:
            pass
        elif self.time_range:
            self.start_date, self.end_date = self.time_range.split("/", 1)
        elif self.target_date:
            year, month, day = [int(part) for part in self.target_date.split("-")]
            from datetime import date, timedelta

            end = date(year, month, day)
            start = end - timedelta(days=30)
            self.start_date = start.isoformat()
            self.end_date = end.isoformat()
        else:
            raise ValueError("Send start_date/end_date, time_range, or target_date.")

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
