from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

from app.config import Settings, get_settings
from app.exceptions import CropAnalysisError, ImageryNotFoundError
from app.geospatial import (
    AnalysisInputs,
    CropAnalysisService,
    analyze_field_with_planetary_computer,
)
from app.schemas import (
    AnalyzeFieldRequest,
    AnalyzeFieldResponse,
    AnalyzeStressRequest,
    AnalyzeStressResponse,
)


PROJECT_ROOT = Path(__file__).resolve().parents[2]
FRONTEND_DIR = PROJECT_ROOT / "frontend"
settings = get_settings()


app = FastAPI(
    title=settings.app_name,
    version=settings.app_version,
    description=(
        "วิเคราะห์ Sentinel-2 NDVI, Landsat thermal LST, ข้อมูลฝนสะสม "
        "และความผิดปกติด้วย Isolation Forest เพื่อวางแผนความเสี่ยงรายแปลง"
    ),
    docs_url="/docs" if settings.docs_enabled else None,
    redoc_url="/redoc" if settings.docs_enabled else None,
    openapi_url="/openapi.json" if settings.docs_enabled else None,
)

app.add_middleware(
    TrustedHostMiddleware,
    allowed_hosts=settings.allowed_hosts,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.add_middleware(GZipMiddleware, minimum_size=1000)


@app.middleware("http")
async def add_security_headers(request, call_next):
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    response.headers.setdefault("Permissions-Policy", "camera=(), microphone=(), payment=()")
    if settings.is_production:
        response.headers.setdefault("Cache-Control", "no-store")
    elif request.url.path in {"/", "/raster"} or request.url.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response


if settings.serve_frontend and FRONTEND_DIR.exists():
    app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="frontend-static")


def get_crop_analysis_service(
    settings: Settings = Depends(get_settings),
) -> CropAnalysisService:
    return CropAnalysisService(settings)


@app.get("/", include_in_schema=False)
def frontend() -> FileResponse:
    if not settings.serve_frontend:
        raise HTTPException(status_code=404, detail="Frontend serving is disabled")
    index_path = FRONTEND_DIR / "index.html"
    if not index_path.exists():
        raise HTTPException(status_code=404, detail="frontend/index.html not found")
    return FileResponse(index_path)


@app.get("/raster", include_in_schema=False)
def raster_page() -> FileResponse:
    if not settings.serve_frontend:
        raise HTTPException(status_code=404, detail="Frontend serving is disabled")
    raster_path = FRONTEND_DIR / "raster.html"
    if not raster_path.exists():
        raise HTTPException(status_code=404, detail="frontend/raster.html not found")
    return FileResponse(raster_path)


@app.get("/favicon.ico", include_in_schema=False)
def favicon() -> Response:
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@app.get("/health")
def health() -> dict[str, str]:
    return {
        "status": "ok",
        "environment": settings.environment,
        "version": settings.app_version,
    }


@app.get("/api/health")
def api_health() -> dict[str, str]:
    return health()


@app.get("/api/routes", include_in_schema=False)
def api_routes() -> dict[str, list[str]]:
    """Development helper to confirm the running FastAPI process loaded the latest routes."""

    routes = []
    for route in app.routes:
        methods = getattr(route, "methods", None)
        path = getattr(route, "path", None)
        if path and methods:
            routes.append(f"{','.join(sorted(methods))} {path}")
    return {"routes": sorted(routes)}


@app.post("/api/analyze-stress", response_model=AnalyzeStressResponse)
@app.post("/api/analyze-stress/", response_model=AnalyzeStressResponse, include_in_schema=False)
def analyze_stress(request: AnalyzeStressRequest) -> AnalyzeStressResponse:
    """Run Microsoft Planetary Computer field stress analysis and return a Leaflet tile URL."""

    try:
        polygon_coordinates = request.polygon_coordinates()
        stress_stats = analyze_field_with_planetary_computer(
            polygon_coordinates,
            request.start_date,
            request.end_date,
            settings,
        )
        mean_ndvi = float(stress_stats["mean_ndvi"])
        raw_lst_celsius = stress_stats.get("mean_lst_celsius")
        mean_lst_celsius = (
            float(raw_lst_celsius) if raw_lst_celsius is not None else None
        )
        has_critical_heat = mean_lst_celsius is not None and mean_lst_celsius >= 38.0
        has_watch_heat = mean_lst_celsius is not None and mean_lst_celsius >= 34.0

        if mean_ndvi < 0.35 or has_critical_heat:
            risk_level = "เสี่ยงรุนแรง"
        elif mean_ndvi < 0.5 or has_watch_heat:
            risk_level = "เฝ้าระวัง"
        else:
            risk_level = "ปกติ"

        return AnalyzeStressResponse(
            tile_url=str(stress_stats["tile_url"]),
            start_date=str(stress_stats["start_date"]),
            end_date=str(stress_stats["end_date"]),
            mean_ndvi=mean_ndvi,
            mean_ndwi=float(stress_stats["mean_ndwi"]),
            mean_lst_celsius=mean_lst_celsius,
            rainfall_30d_mm=float(stress_stats["rainfall_30d_mm"]),
            risk_level=risk_level,
            pixel_count=str(stress_stats["pixel_count"]),
            source=str(stress_stats.get("source", "Microsoft Planetary Computer")),
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=str(exc),
        ) from exc
    except ImageryNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=str(exc),
        ) from exc
    except CropAnalysisError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=str(exc),
        ) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Unexpected Microsoft Planetary Computer stress analysis failure: {exc}",
        ) from exc


@app.post("/api/analyze-field", response_model=AnalyzeFieldResponse)
@app.post("/api/analyze-field/", response_model=AnalyzeFieldResponse, include_in_schema=False)
@app.post("/analyze-field", response_model=AnalyzeFieldResponse)
@app.post("/analyze-field/", response_model=AnalyzeFieldResponse, include_in_schema=False)
def analyze_field(
    request: AnalyzeFieldRequest,
    settings: Settings = Depends(get_settings),
    service: CropAnalysisService = Depends(get_crop_analysis_service),
) -> AnalyzeFieldResponse:
    """Run the full satellite crop-health pipeline for a field bounding box."""

    rainfall_15d_mm = (
        request.rainfall_15d_mm
        if request.rainfall_15d_mm is not None
        else settings.default_rainfall_mm_15d
    )

    try:
        return service.analyze(
            AnalysisInputs(
                bbox=request.bbox,
                time_range=request.time_range,
                rainfall_15d_mm=rainfall_15d_mm,
            )
        )
    except ImageryNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=str(exc),
        ) from exc
    except CropAnalysisError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=str(exc),
        ) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Unexpected crop analysis failure: {exc}",
        ) from exc

