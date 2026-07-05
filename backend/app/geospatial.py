from __future__ import annotations

import math
import re
import urllib.request
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

import numpy as np
import odc.stac
import planetary_computer
import rioxarray  # noqa: F401 - activates the xarray .rio accessor
import xarray as xr
from pystac import Item
from pystac_client import Client
from sklearn.ensemble import IsolationForest

from app.config import Settings
from app.exceptions import CropAnalysisError, ImageryNotFoundError, ImageryProcessingError
from app.schemas import (
    AnalyzeFieldResponse,
    CropRecommendationResult,
    LocalInferenceFeatures,
    LocalInferenceResponse,
    NdwiForecastResult,
    PixelResult,
    RasterSummary,
)


SENTINEL_RED_BAND = "B04"
SENTINEL_GREEN_BAND = "B03"
SENTINEL_NIR_BAND = "B08"
LANDSAT_TIRS_BAND_10 = "B10"
LANDSAT_MTL_ASSET_CANDIDATES = ("MTL.txt", "mtl.txt", "MTL", "mtl")
WGS84 = "EPSG:4326"
PLANETARY_COMPUTER_DATA_API_URL = "https://planetarycomputer.microsoft.com/api/data/v1"
BACKEND_DIR = Path(__file__).resolve().parents[1]
DEFAULT_MODEL_DIR = BACKEND_DIR / "models"
RF_MODEL_FILENAME = "crop_recommend_rf.pkl"
LSTM_MODEL_FILENAME = "ndwi_lstm.pt"
LOCAL_AI_FEATURE_ORDER = ["ndwi", "ndvi", "lst_celsius", "chirps_30d_mm"]


@dataclass(frozen=True)
class AnalysisInputs:
    bbox: list[float]
    time_range: str
    rainfall_15d_mm: float


@dataclass(frozen=True)
class LSTMModelConfig:
    input_size: int = 1
    hidden_size: int = 64
    num_layers: int = 2
    output_size: int = 1
    dropout: float = 0.0


def run_local_ai_inference(
    *,
    ndwi: float,
    ndvi: float,
    lst_celsius: float,
    chirps_30d_mm: float,
    historical_ndwi_sequence: list[float] | list[list[float]],
    model_dir: str | Path | None = None,
    forecast_days: int = 7,
    lstm_config: LSTMModelConfig | None = None,
) -> LocalInferenceResponse:
    """Run local Random Forest crop recommendation and LSTM NDWI forecasting.

    Feature order for the Random Forest is fixed as:
    ``[NDWI, NDVI, LST_Celsius, CHIRPS_30d_mm]``.

    The default LSTM assumes a single NDWI input feature. If your saved checkpoint
    includes a ``config`` dictionary, it can override the default architecture.
    """

    model_base = Path(model_dir) if model_dir else DEFAULT_MODEL_DIR
    features = LocalInferenceFeatures(
        ndwi=_validated_float(ndwi, "ndwi"),
        ndvi=_validated_float(ndvi, "ndvi"),
        lst_celsius=_validated_float(lst_celsius, "lst_celsius"),
        chirps_30d_mm=_validated_float(chirps_30d_mm, "chirps_30d_mm"),
    )

    crop_type, crop_probability = predict_crop_recommendation(features, model_base)
    ndwi_forecast = forecast_ndwi_with_lstm(
        historical_ndwi_sequence=historical_ndwi_sequence,
        model_dir=model_base,
        forecast_days=forecast_days,
        lstm_config=lstm_config,
    )

    return LocalInferenceResponse(
        features=features,
        crop_recommendation=CropRecommendationResult(
            crop_type=crop_type,
            probability=crop_probability,
        ),
        ndwi_forecast=NdwiForecastResult(
            horizon_days=forecast_days,
            values=ndwi_forecast,
        ),
    )


def run_local_ai_inference_from_features(
    extracted_features: dict[str, float | str],
    historical_ndwi_sequence: list[float] | list[list[float]],
    *,
    model_dir: str | Path | None = None,
    forecast_days: int = 7,
    lstm_config: LSTMModelConfig | None = None,
) -> LocalInferenceResponse:
    """Convenience wrapper for extracted NDWI, NDVI, LST, and rainfall features."""

    return run_local_ai_inference(
        ndwi=float(extracted_features["mean_ndwi"]),
        ndvi=float(extracted_features["mean_ndvi"]),
        lst_celsius=float(extracted_features["mean_lst_celsius"]),
        chirps_30d_mm=float(extracted_features["rainfall_30d_mm"]),
        historical_ndwi_sequence=historical_ndwi_sequence,
        model_dir=model_dir,
        forecast_days=forecast_days,
        lstm_config=lstm_config,
    )


def predict_crop_recommendation(
    features: LocalInferenceFeatures,
    model_dir: str | Path | None = None,
) -> tuple[str, float]:
    """Predict the best crop type and confidence using ``crop_recommend_rf.pkl``."""

    model_base = Path(model_dir) if model_dir else DEFAULT_MODEL_DIR
    model = _load_crop_recommendation_model(str(model_base / RF_MODEL_FILENAME))
    feature_array = np.array(
        [[features.ndwi, features.ndvi, features.lst_celsius, features.chirps_30d_mm]],
        dtype="float32",
    )

    try:
        prediction = model.predict(feature_array)[0]
        if hasattr(model, "predict_proba"):
            probabilities = model.predict_proba(feature_array)[0]
            probability = float(np.max(probabilities))
        else:
            probability = 1.0
    except Exception as exc:
        raise ImageryProcessingError(f"Crop recommendation model inference failed: {exc}") from exc

    return str(prediction), probability


def forecast_ndwi_with_lstm(
    *,
    historical_ndwi_sequence: list[float] | list[list[float]],
    model_dir: str | Path | None = None,
    forecast_days: int = 7,
    lstm_config: LSTMModelConfig | None = None,
) -> list[float]:
    """Forecast NDWI for the next ``forecast_days`` using ``ndwi_lstm.pt``."""

    if forecast_days < 1:
        raise ImageryProcessingError("forecast_days must be at least 1.")

    model_base = Path(model_dir) if model_dir else DEFAULT_MODEL_DIR
    sequence = _prepare_lstm_sequence(historical_ndwi_sequence)
    config = lstm_config or LSTMModelConfig(input_size=sequence.shape[1])
    model, resolved_config = _load_ndwi_lstm_model(
        str(model_base / LSTM_MODEL_FILENAME),
        config,
    )

    if sequence.shape[1] != resolved_config.input_size:
        raise ImageryProcessingError(
            "Historical NDWI sequence feature width does not match the LSTM input size "
            f"({sequence.shape[1]} != {resolved_config.input_size})."
        )

    try:
        import torch

        device = next(model.parameters()).device
        rolling_sequence = sequence.copy()
        forecasts: list[float] = []

        model.eval()
        with torch.no_grad():
            for _ in range(forecast_days):
                tensor = torch.tensor(
                    rolling_sequence,
                    dtype=torch.float32,
                    device=device,
                ).unsqueeze(0)
                predicted = model(tensor).detach().cpu().numpy().reshape(-1)[0]
                predicted_float = float(predicted)
                forecasts.append(predicted_float)

                next_row = rolling_sequence[-1].copy()
                next_row[0] = predicted_float
                rolling_sequence = np.vstack([rolling_sequence[1:], next_row])
    except Exception as exc:
        raise ImageryProcessingError(f"NDWI LSTM inference failed: {exc}") from exc

    return forecasts


@lru_cache(maxsize=4)
def _load_crop_recommendation_model(model_path: str) -> Any:
    try:
        import joblib
    except ImportError as exc:
        raise ImageryProcessingError("joblib is not installed. Install backend requirements.") from exc

    path = Path(model_path)
    if not path.exists():
        raise ImageryProcessingError(f"Crop recommendation model not found: {path}")

    try:
        return joblib.load(path)
    except Exception as exc:
        raise ImageryProcessingError(f"Could not load crop recommendation model: {exc}") from exc


@lru_cache(maxsize=4)
def _load_ndwi_lstm_model(
    model_path: str,
    config: LSTMModelConfig,
) -> tuple[Any, LSTMModelConfig]:
    try:
        import torch
    except ImportError as exc:
        raise ImageryProcessingError("PyTorch is not installed. Install backend requirements.") from exc

    path = Path(model_path)
    if not path.exists():
        raise ImageryProcessingError(f"NDWI LSTM model not found: {path}")

    try:
        checkpoint = torch.load(path, map_location="cpu")
        checkpoint_config = _extract_lstm_config(checkpoint)
        resolved_config = checkpoint_config or config
        model = StandardNDWILSTM(resolved_config)

        state_dict = _extract_lstm_state_dict(checkpoint)
        if state_dict is None:
            raise ImageryProcessingError("Unsupported ndwi_lstm.pt checkpoint format.")

        model.load_state_dict(state_dict)
        model.eval()
        return model, resolved_config
    except ImageryProcessingError:
        raise
    except Exception as exc:
        raise ImageryProcessingError(f"Could not load NDWI LSTM model: {exc}") from exc


def _extract_lstm_config(checkpoint: Any) -> LSTMModelConfig | None:
    if not isinstance(checkpoint, dict) or "config" not in checkpoint:
        return None

    config = checkpoint["config"]
    if not isinstance(config, dict):
        return None

    return LSTMModelConfig(
        input_size=int(config.get("input_size", 1)),
        hidden_size=int(config.get("hidden_size", 64)),
        num_layers=int(config.get("num_layers", 2)),
        output_size=int(config.get("output_size", 1)),
        dropout=float(config.get("dropout", 0.0)),
    )


def _extract_lstm_state_dict(checkpoint: Any) -> dict | None:
    if not isinstance(checkpoint, dict):
        return None

    if isinstance(checkpoint.get("state_dict"), dict):
        return checkpoint["state_dict"]
    if isinstance(checkpoint.get("model_state_dict"), dict):
        return checkpoint["model_state_dict"]

    metadata_keys = {"config", "epoch", "loss", "optimizer_state_dict", "scaler"}
    possible_state_dict = {
        key: value for key, value in checkpoint.items() if key not in metadata_keys
    }
    if possible_state_dict and all(hasattr(value, "shape") for value in possible_state_dict.values()):
        return possible_state_dict

    return None


def _prepare_lstm_sequence(sequence: list[float] | list[list[float]]) -> np.ndarray:
    array = np.asarray(sequence, dtype="float32")
    if array.ndim == 1:
        array = array.reshape(-1, 1)
    if array.ndim != 2:
        raise ImageryProcessingError(
            "historical_ndwi_sequence must be a list of floats or a 2D sequence."
        )
    if array.shape[0] < 2:
        raise ImageryProcessingError("historical_ndwi_sequence must contain at least 2 timesteps.")
    if not np.isfinite(array).all():
        raise ImageryProcessingError("historical_ndwi_sequence contains non-finite values.")
    return array


def _validated_float(value: float, field_name: str) -> float:
    parsed = float(value)
    if not math.isfinite(parsed):
        raise ImageryProcessingError(f"{field_name} must be a finite number.")
    return parsed


class StandardNDWILSTM:
    """Small default PyTorch LSTM used until the final model architecture is supplied."""

    def __new__(cls, config: LSTMModelConfig):
        try:
            import torch
        except ImportError as exc:
            raise ImageryProcessingError("PyTorch is not installed. Install backend requirements.") from exc

        class _Model(torch.nn.Module):
            def __init__(self, model_config: LSTMModelConfig) -> None:
                super().__init__()
                dropout = model_config.dropout if model_config.num_layers > 1 else 0.0
                self.lstm = torch.nn.LSTM(
                    input_size=model_config.input_size,
                    hidden_size=model_config.hidden_size,
                    num_layers=model_config.num_layers,
                    batch_first=True,
                    dropout=dropout,
                )
                self.fc = torch.nn.Linear(model_config.hidden_size, model_config.output_size)

            def forward(self, x):
                output, _ = self.lstm(x)
                return self.fc(output[:, -1, :])

        return _Model(config)


def analyze_field_with_planetary_computer(
    polygon_coordinates: list,
    start_date: str,
    end_date: str,
    settings: Settings,
) -> dict[str, float | str]:
    """Return stress statistics and an NDVI tile URL from Microsoft Planetary Computer."""

    bbox = _bbox_from_polygon_coordinates(polygon_coordinates)
    time_range = f"{start_date}/{end_date}"
    service = CropAnalysisService(settings)

    sentinel_items = service._search_sentinel(bbox, time_range)

    sentinel_cube = service._load_sentinel_index_cube(sentinel_items, bbox)
    ndvi_cube = service._calculate_ndvi(sentinel_cube)
    ndwi_cube = service._calculate_ndwi(sentinel_cube)
    current_ndvi = ndvi_cube.isel(time=-1)
    current_ndwi = ndwi_cube.isel(time=-1)
    try:
        landsat_items = service._search_landsat(bbox, time_range)
        lst = service._calculate_lst_celsius(landsat_items, bbox, current_ndvi)
    except CropAnalysisError:
        lst = xr.full_like(current_ndvi, np.nan).rio.write_crs(WGS84)

    current_ndvi, current_ndwi, lst = xr.align(current_ndvi, current_ndwi, lst, join="inner")
    ndvi_summary = service._summary(current_ndvi)
    ndwi_summary = service._summary(current_ndwi)
    lst_summary = service._summary(lst)
    print(f"NDVI summary: {ndvi_summary}, NDWI summary: {ndwi_summary}, LST summary: {lst_summary}")
    tile_url = create_planetary_computer_ndvi_tile_url(
        sentinel_items[-1],
        settings.sentinel_collection,
    )

    return {
        "tile_url": tile_url,
        "start_date": start_date,
        "end_date": end_date,
        "mean_ndvi": _required_summary_mean(ndvi_summary, "NDVI"),
        "mean_ndwi": _required_summary_mean(ndwi_summary, "NDWI"),
        "mean_lst_celsius": lst_summary.mean,
        "rainfall_30d_mm": 0.0,
        "pixel_count": f"{ndvi_summary.valid_pixel_count} pixels",
        "source": "Microsoft Planetary Computer",
    }


def create_planetary_computer_ndvi_tile_url(item: Item, collection: str) -> str:
    """Build a Leaflet tile URL using the Planetary Computer Data API."""

    query = urlencode(
        {
            "collection": collection,
            "item": item.id,
            "assets": [SENTINEL_RED_BAND, SENTINEL_NIR_BAND],
            "asset_as_band": "true",
            "expression": f"({SENTINEL_NIR_BAND}-{SENTINEL_RED_BAND})/({SENTINEL_NIR_BAND}+{SENTINEL_RED_BAND})",
            "rescale": "-0.2,0.9",
            "colormap_name": "rdylgn",
        },
        doseq=True,
    )
    return f"{PLANETARY_COMPUTER_DATA_API_URL}/item/tiles/WebMercatorQuad/{{z}}/{{x}}/{{y}}@1x?{query}"


def _bbox_from_polygon_coordinates(polygon_coordinates: list) -> list[float]:
    try:
        ring = _normalize_polygon_ring(polygon_coordinates)
        longitudes = [float(point[0]) for point in ring]
        latitudes = [float(point[1]) for point in ring]
    except Exception as exc:
        raise ImageryProcessingError(
            "polygon_coordinates must be GeoJSON Polygon coordinates or a coordinate ring in lon/lat order."
        ) from exc

    min_lon, max_lon = min(longitudes), max(longitudes)
    min_lat, max_lat = min(latitudes), max(latitudes)
    if not (-180 <= min_lon < max_lon <= 180 and -90 <= min_lat < max_lat <= 90):
        raise ImageryProcessingError("Polygon coordinates are outside valid WGS84 bounds.")
    return [min_lon, min_lat, max_lon, max_lat]


def _normalize_polygon_ring(polygon_coordinates: list) -> list:
    """Accept either GeoJSON Polygon coordinates or a single linear ring."""

    if not polygon_coordinates:
        raise ValueError("Empty polygon coordinates.")

    first = polygon_coordinates[0]
    if _looks_like_coordinate_pair(first):
        return polygon_coordinates

    if isinstance(first, list) and first and _looks_like_coordinate_pair(first[0]):
        return first

    raise ValueError("Unsupported polygon coordinate structure.")


def _looks_like_coordinate_pair(value: Any) -> bool:
    return (
        isinstance(value, list)
        and len(value) >= 2
        and isinstance(value[0], (int, float))
        and isinstance(value[1], (int, float))
    )


def _required_summary_mean(summary: RasterSummary, label: str) -> float:
    if summary.mean is None:
        raise ImageryNotFoundError(f"{label} returned no valid pixels for this field/date range.")
    return float(summary.mean)


class CropAnalysisService:
    """Coordinates STAC search, raster loading, index computation, and anomaly detection."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.client = Client.open(settings.planetary_computer_stac_url)

    def analyze(self, inputs: AnalysisInputs) -> AnalyzeFieldResponse:
        sentinel_items = self._search_sentinel(inputs.bbox, inputs.time_range)

        sentinel_cube = self._load_sentinel_cube(sentinel_items, inputs.bbox)
        ndvi_cube = self._calculate_ndvi(sentinel_cube)
        current_ndvi = ndvi_cube.isel(time=-1)
        ndvi_diff = self._calculate_first_order_ndvi_difference(ndvi_cube)

        landsat_items: list[Item] = []
        lst_error: str | None = None
        try:
            landsat_items = self._search_landsat(inputs.bbox, inputs.time_range)
            lst = self._calculate_lst_celsius(landsat_items, inputs.bbox, current_ndvi)
        except CropAnalysisError as exc:
            lst_error = str(exc)
            lst = xr.full_like(current_ndvi, np.nan).rio.write_crs(WGS84)

        current_ndvi, ndvi_diff, lst = xr.align(current_ndvi, ndvi_diff, lst, join="inner")
        anomaly_flags = self._detect_anomalies(current_ndvi, ndvi_diff, inputs.rainfall_15d_mm)
        lst_summary = self._summary(lst)
        lst_status = "available" if lst_summary.valid_pixel_count > 0 else "missing"
        if lst_status == "missing" and lst_error is None:
            lst_error = "LST calculation completed but returned no valid thermal pixels."

        pixels = self._serialize_pixels(
            current_ndvi=current_ndvi,
            ndvi_diff=ndvi_diff,
            lst=lst,
            anomaly_flags=anomaly_flags,
            rainfall_15d_mm=inputs.rainfall_15d_mm,
        )

        return AnalyzeFieldResponse(
            bbox=inputs.bbox,
            time_range=inputs.time_range,
            crs=WGS84,
            sentinel_scene_ids=[item.id for item in sentinel_items],
            landsat_scene_ids=[item.id for item in landsat_items],
            ndvi_summary=self._summary(current_ndvi),
            lst_summary=lst_summary,
            lst_status=lst_status,
            lst_error=lst_error,
            anomaly_count=int(np.nansum(anomaly_flags.values)),
            pixels=pixels,
        )

    def _search_sentinel(self, bbox: list[float], time_range: str) -> list[Item]:
        """Find cloud-filtered Sentinel-2 L2A scenes over the requested field."""

        items = self._search_cloud_filtered_items(
            collection=self.settings.sentinel_collection,
            bbox=bbox,
            time_range=time_range,
            max_items=self.settings.max_sentinel_items,
        )
        if not items:
            raise ImageryNotFoundError(
                "No Sentinel-2 L2A images found with cloud cover under "
                f"{self.settings.relaxed_max_cloud_cover}% for the requested bbox/time_range."
            )
        return [planetary_computer.sign(item) for item in items]

    def _search_landsat(self, bbox: list[float], time_range: str) -> list[Item]:
        """Find Landsat Collection 2 Level-1 scenes with thermal Band 10 metadata."""

        items = [
            item
            for item in self._search_cloud_filtered_items(
                collection=self.settings.landsat_collection,
                bbox=bbox,
                time_range=time_range,
                max_items=self.settings.max_landsat_items,
            )
            if LANDSAT_TIRS_BAND_10 in item.assets
        ]
        if not items:
            raise ImageryNotFoundError(
                "No Landsat 8/9 Level-1 scenes with TIRS Band 10 found for the requested "
                "bbox/time_range and cloud filter."
            )
        return [planetary_computer.sign(item) for item in items]

    def _search_cloud_filtered_items(
        self,
        *,
        collection: str,
        bbox: list[float],
        time_range: str,
        max_items: int,
    ) -> list[Item]:
        """Search first with the strict cloud threshold, then retry with a relaxed threshold."""

        thresholds = [self.settings.max_cloud_cover]
        if self.settings.relaxed_max_cloud_cover > self.settings.max_cloud_cover:
            thresholds.append(self.settings.relaxed_max_cloud_cover)

        for threshold in thresholds:
            search = self.client.search(
                collections=[collection],
                bbox=bbox,
                datetime=time_range,
                query={"eo:cloud_cover": {"lt": threshold}},
                sortby=[{"field": "properties.datetime", "direction": "asc"}],
                max_items=max_items,
            )
            items = list(search.items())
            if items:
                return items
        return []

    def _load_sentinel_cube(self, items: list[Item], bbox: list[float]) -> xr.Dataset:
        """Load Red and NIR bands at 10 m in the scenes' native projected grid."""

        try:
            cube = odc.stac.load(
                items,
                bands=[SENTINEL_RED_BAND, SENTINEL_NIR_BAND],
                bbox=bbox,
                resolution=self.settings.analysis_resolution_m,
                groupby="solar_day",
                chunks={},
            )
        except Exception as exc:
            raise ImageryProcessingError(f"Could not load Sentinel-2 imagery: {exc}") from exc

        if SENTINEL_RED_BAND not in cube or SENTINEL_NIR_BAND not in cube:
            raise ImageryProcessingError("Sentinel-2 response is missing B04 or B08 assets.")
        return cube

    def _load_sentinel_index_cube(self, items: list[Item], bbox: list[float]) -> xr.Dataset:
        """Load Sentinel-2 Green, Red, and NIR bands for NDWI/NDVI stress analysis."""

        try:
            cube = odc.stac.load(
                items,
                bands=[SENTINEL_GREEN_BAND, SENTINEL_RED_BAND, SENTINEL_NIR_BAND],
                bbox=bbox,
                resolution=self.settings.analysis_resolution_m,
                groupby="solar_day",
                chunks={},
            )
        except Exception as exc:
            raise ImageryProcessingError(f"Could not load Sentinel-2 stress imagery: {exc}") from exc

        required_bands = {SENTINEL_GREEN_BAND, SENTINEL_RED_BAND, SENTINEL_NIR_BAND}
        if not required_bands.issubset(cube.data_vars):
            raise ImageryProcessingError("Sentinel-2 response is missing B03, B04, or B08 assets.")
        return cube

    def _calculate_ndvi(self, cube: xr.Dataset) -> xr.DataArray:
        """Compute NDVI = (NIR - Red) / (NIR + Red), then reproject to EPSG:4326."""

        red = cube[SENTINEL_RED_BAND].astype("float32")
        nir = cube[SENTINEL_NIR_BAND].astype("float32")
        denominator = nir + red
        ndvi = xr.where(denominator != 0, (nir - red) / denominator, np.nan)
        ndvi = ndvi.clip(min=-1.0, max=1.0).rio.write_crs(cube.odc.crs)
        return ndvi.rio.reproject(WGS84)

    def _calculate_ndwi(self, cube: xr.Dataset) -> xr.DataArray:
        """Compute NDWI = (Green - NIR) / (Green + NIR), then reproject to EPSG:4326."""

        green = cube[SENTINEL_GREEN_BAND].astype("float32")
        nir = cube[SENTINEL_NIR_BAND].astype("float32")
        denominator = green + nir
        ndwi = xr.where(denominator != 0, (green - nir) / denominator, np.nan)
        ndwi = ndwi.clip(min=-1.0, max=1.0).rio.write_crs(cube.odc.crs)
        return ndwi.rio.reproject(WGS84)

    def _calculate_first_order_ndvi_difference(self, ndvi_cube: xr.DataArray) -> xr.DataArray:
        """Calculate the first-order NDVI slope between the two latest observations."""

        if ndvi_cube.sizes.get("time", 0) < 2:
            return xr.zeros_like(ndvi_cube.isel(time=-1))
        return ndvi_cube.diff(dim="time").isel(time=-1)

    def _calculate_lst_celsius(
        self,
        landsat_items: list[Item],
        bbox: list[float],
        ndvi_reference: xr.DataArray,
    ) -> xr.DataArray:
        """Convert Landsat TIRS Band 10 DN to LST Celsius and align it to the NDVI grid."""

        item = landsat_items[-1]
        radiance_mult, radiance_add, k1, k2 = self._extract_landsat_thermal_constants(item)
        if None in (radiance_mult, radiance_add, k1, k2):
            raise ImageryProcessingError(
                "The selected Landsat item does not expose Band 10 radiance/K constants "
                "in STAC properties or MTL metadata, so DN-to-LST conversion cannot run."
            )

        try:
            thermal_cube = odc.stac.load(
                [item],
                bands=[LANDSAT_TIRS_BAND_10],
                bbox=bbox,
                resolution=self.settings.landsat_resolution_m,
                chunks={},
            )
        except Exception as exc:
            raise ImageryProcessingError(f"Could not load Landsat thermal imagery: {exc}") from exc

        dn = thermal_cube[LANDSAT_TIRS_BAND_10].isel(time=0).astype("float32")
        dn = xr.where(dn > 0, dn, np.nan)
        radiance = (float(radiance_mult) * dn) + float(radiance_add)
        brightness_temp_kelvin = float(k2) / np.log((float(k1) / radiance) + 1.0)

        emissivity = self._estimate_surface_emissivity(ndvi_reference)
        emissivity_on_thermal_grid = emissivity.rio.reproject_match(
            brightness_temp_kelvin.rio.write_crs(thermal_cube.odc.crs)
        )
        lst_kelvin = self._brightness_temperature_to_lst(
            brightness_temp_kelvin,
            emissivity_on_thermal_grid,
        )
        lst_celsius = (lst_kelvin - 273.15).rio.write_crs(thermal_cube.odc.crs)
        return lst_celsius.rio.reproject_match(ndvi_reference)

    @staticmethod
    def _estimate_surface_emissivity(ndvi: xr.DataArray) -> xr.DataArray:
        """Estimate emissivity from NDVI using the proportion-of-vegetation method."""

        proportion_vegetation = (((ndvi - 0.2) / 0.3).clip(min=0.0, max=1.0)) ** 2
        return (0.004 * proportion_vegetation + 0.986).clip(min=0.97, max=0.99)

    @staticmethod
    def _brightness_temperature_to_lst(
        brightness_temp_kelvin: xr.DataArray,
        emissivity: xr.DataArray,
    ) -> xr.DataArray:
        wavelength = 10.895e-6
        rho = 1.4387769e-2
        return brightness_temp_kelvin / (
            1 + ((wavelength * brightness_temp_kelvin) / rho) * np.log(emissivity)
        )

    @staticmethod
    def _detect_anomalies(
        current_ndvi: xr.DataArray,
        ndvi_diff: xr.DataArray,
        rainfall_15d_mm: float,
    ) -> xr.DataArray:
        """Run Isolation Forest on NDVI, NDVI slope, and 15-day cumulative rainfall."""

        ndvi_values = current_ndvi.values.reshape(-1)
        diff_values = ndvi_diff.values.reshape(-1)
        rainfall_values = np.full_like(ndvi_values, rainfall_15d_mm, dtype="float32")
        valid_mask = np.isfinite(ndvi_values) & np.isfinite(diff_values)

        flags = np.zeros(ndvi_values.shape, dtype="int8")
        if valid_mask.sum() >= 8:
            features = np.column_stack(
                [ndvi_values[valid_mask], diff_values[valid_mask], rainfall_values[valid_mask]]
            )
            model = IsolationForest(contamination="auto", random_state=42)
            predictions = model.fit_predict(features)
            flags[valid_mask] = np.where(predictions == -1, 1, 0)

            rainfall_high = rainfall_15d_mm >= 25.0
            sharp_ndvi_drop = diff_values < -0.12
            weak_vegetation = ndvi_values < 0.35
            flags[valid_mask & rainfall_high & sharp_ndvi_drop & weak_vegetation] = 1

        return xr.DataArray(
            flags.reshape(current_ndvi.shape),
            coords=current_ndvi.coords,
            dims=current_ndvi.dims,
            name="is_anomaly",
        )

    def _serialize_pixels(
        self,
        current_ndvi: xr.DataArray,
        ndvi_diff: xr.DataArray,
        lst: xr.DataArray,
        anomaly_flags: xr.DataArray,
        rainfall_15d_mm: float,
    ) -> list[PixelResult]:
        """Flatten aligned rasters into JSON-friendly pixel records."""

        y_coord, x_coord = current_ndvi.rio.y_dim, current_ndvi.rio.x_dim
        pixels: list[PixelResult] = []
        total_cells = current_ndvi.shape[0] * current_ndvi.shape[1]
        sample_stride = max(1, math.ceil(total_cells / self.settings.max_response_pixels))

        for y_index, lat in enumerate(current_ndvi[y_coord].values):
            for x_index, lon in enumerate(current_ndvi[x_coord].values):
                linear_index = y_index * current_ndvi.shape[1] + x_index
                ndvi_value = current_ndvi.values[y_index, x_index]
                lst_value = lst.values[y_index, x_index]
                diff_value = ndvi_diff.values[y_index, x_index]
                is_anomaly = int(anomaly_flags.values[y_index, x_index])

                if not np.isfinite(ndvi_value) and not np.isfinite(lst_value):
                    continue
                if is_anomaly != 1 and linear_index % sample_stride != 0:
                    continue

                pixels.append(
                    PixelResult(
                        lon=float(lon),
                        lat=float(lat),
                        ndvi=CropAnalysisService._finite_float(ndvi_value),
                        lst_celsius=CropAnalysisService._finite_float(lst_value),
                        ndvi_diff=CropAnalysisService._finite_float(diff_value),
                        rainfall_15d_mm=float(rainfall_15d_mm),
                        is_anomaly=is_anomaly,
                    )
                )
        return pixels

    @staticmethod
    def _summary(data: xr.DataArray) -> RasterSummary:
        values = data.values
        valid_values = values[np.isfinite(values)]
        if valid_values.size == 0:
            return RasterSummary(mean=None, min=None, max=None, valid_pixel_count=0)
        return RasterSummary(
            mean=float(np.nanmean(valid_values)),
            min=float(np.nanmin(valid_values)),
            max=float(np.nanmax(valid_values)),
            valid_pixel_count=int(valid_values.size),
        )

    @staticmethod
    def _finite_float(value: float) -> float | None:
        return float(value) if math.isfinite(float(value)) else None

    @staticmethod
    def _first_number(properties: dict, *keys: str) -> float | None:
        for key in keys:
            value = properties.get(key)
            if value is not None:
                return float(value)
        return None

    def _extract_landsat_thermal_constants(
        self,
        item: Item,
    ) -> tuple[float | None, float | None, float | None, float | None]:
        """Read Landsat thermal calibration constants from STAC properties or MTL text."""

        props = item.properties
        values = (
            self._first_number(props, "landsat:radiance_mult_band_10", "RADIANCE_MULT_BAND_10"),
            self._first_number(props, "landsat:radiance_add_band_10", "RADIANCE_ADD_BAND_10"),
            self._first_number(props, "landsat:k1_constant_band_10", "K1_CONSTANT_BAND_10"),
            self._first_number(props, "landsat:k2_constant_band_10", "K2_CONSTANT_BAND_10"),
        )
        if all(value is not None for value in values):
            return values

        mtl_text = self._read_mtl_text(item)
        if not mtl_text:
            return values

        return (
            values[0]
            if values[0] is not None
            else self._number_from_mtl(mtl_text, "RADIANCE_MULT_BAND_10"),
            values[1]
            if values[1] is not None
            else self._number_from_mtl(mtl_text, "RADIANCE_ADD_BAND_10"),
            values[2]
            if values[2] is not None
            else self._number_from_mtl(mtl_text, "K1_CONSTANT_BAND_10"),
            values[3]
            if values[3] is not None
            else self._number_from_mtl(mtl_text, "K2_CONSTANT_BAND_10"),
        )

    @staticmethod
    def _read_mtl_text(item: Item) -> str | None:
        for asset_key in LANDSAT_MTL_ASSET_CANDIDATES:
            asset = item.assets.get(asset_key)
            if not asset:
                continue
            try:
                with urllib.request.urlopen(asset.href, timeout=20) as response:
                    return response.read().decode("utf-8", errors="replace")
            except Exception:
                continue
        return None

    @staticmethod
    def _number_from_mtl(mtl_text: str, key: str) -> float | None:
        match = re.search(rf"\b{re.escape(key)}\s=\s([-+]?\d+(?:\.\d+)?)", mtl_text)
        return float(match.group(1)) if match else None
