from pathlib import Path
from datetime import datetime, timedelta, timezone  # 🆕 สำหรับตั้งเวลาหมดอายุ Token
from jose import JWTError, jwt                      # 🆕 สำหรับเข้ารหัสและถอดรหัส JWT Token

from fastapi import Depends, FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.security import OAuth2PasswordBearer
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
    UserLogin,
    Token,
)

# ระบบตรวจสอบ Token จาก Request Header (Authorization: Bearer <token>)
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="api/login", auto_error=False)


PROJECT_ROOT = Path(__file__).resolve().parents[2]
FRONTEND_DIR = PROJECT_ROOT / "frontend"
settings = get_settings()
ALGORITHM = "HS256"

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

def get_current_user(token: str = Depends(oauth2_scheme)) -> str:
    """ฟังก์ชันด่านตรวจ (Dependency) คอยตรวจสอบและแกะ JWT Token จาก Header"""
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="กรุณาเข้าสู่ระบบก่อนสิทธิ์เข้าถึงข้อมูลวิเคราะห์พืช",
        headers={"WWW-Authenticate": "Bearer"},
    )
    
    if not token:
        raise credentials_exception
        
    try:
        # ถอดรหัสลับพิกเซลความปลอดภัย
        payload = jwt.decode(token, settings.jwt_secret_key, algorithms=[ALGORITHM])
        username: str = payload.get("sub")
        if username is None:
            raise credentials_exception
        return username
    except JWTError:
        raise credentials_exception
    
@app.get("/", include_in_schema=False)
def frontend() -> FileResponse:
    if not settings.serve_frontend:
        raise HTTPException(status_code=404, detail="Frontend serving is disabled")
    index_path = FRONTEND_DIR / "index.html"
    if not index_path.exists():
        raise HTTPException(status_code=404, detail="frontend/index.html not found")
    return FileResponse(index_path)

@app.post("/api/login", response_model=Token)
def login(user_data: UserLogin) -> dict:
    """Endpoint สำหรับการตรวจสอบรหัสผ่าน และออกตั๋ว JWT Token ให้หน้าบ้าน"""
    if (
        user_data.username == settings.mock_login_username
        and user_data.password == settings.mock_login_password
    ):
        # คำนวณเวลาหมดอายุของ Token
        expire = datetime.now(timezone.utc) + timedelta(
            minutes=settings.access_token_expire_minutes
        )
        
        # บรรจุข้อมูลใส่ตั๋ว (Payload)
        token_data = {"sub": user_data.username, "exp": expire}
        encoded_jwt = jwt.encode(token_data, settings.jwt_secret_key, algorithm=ALGORITHM)
        
        return {"access_token": encoded_jwt, "token_type": "bearer"}
        
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="ชื่อผู้ใช้งาน หรือ รหัสผ่านในระบบไม่ถูกต้อง",
    )

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

@app.get("/login", include_in_schema=False)
@app.get("/login.html", include_in_schema=False)
def login_page() -> FileResponse:
    if not settings.serve_frontend:
        raise HTTPException(status_code=404, detail="Frontend serving is disabled")
    login_path = FRONTEND_DIR / "login.html"
    if not login_path.exists():
        raise HTTPException(status_code=404, detail="frontend/login.html not found")
    return FileResponse(login_path)

@app.post("/api/analyze-stress", response_model=AnalyzeStressResponse)
@app.post("/api/analyze-stress/", response_model=AnalyzeStressResponse, include_in_schema=False)
def analyze_stress(request: AnalyzeStressRequest,
                   current_user: str = Depends(get_current_user)
                ) -> AnalyzeStressResponse:
    """Run Microsoft Planetary Computer field stress analysis for raster overlays."""

    try:
        polygon_coordinates = request.polygon_coordinates()
        stress_stats = analyze_field_with_planetary_computer(
            polygon_coordinates,
            str(request.start_date),
            str(request.end_date),
            settings,
        )
        mean_ndvi = float(stress_stats["mean_ndvi"])
        raw_lst_celsius = stress_stats.get("mean_lst_celsius")
        mean_lst_celsius = (
            float(raw_lst_celsius) if raw_lst_celsius is not None else None
        )
        anomaly_count = int(stress_stats.get("anomaly_count", 0))
        valid_pixel_count = int(stress_stats.get("valid_pixel_count", 0))
        anomaly_ratio = (
            float(stress_stats.get("anomaly_ratio", 0.0))
            if valid_pixel_count
            else 0.0
        )
        thermal_critical_pixel_count = int(
            stress_stats.get("thermal_critical_pixel_count", 0)
        )
        thermal_watch_pixel_count = int(stress_stats.get("thermal_watch_pixel_count", 0))
        thermal_valid_pixel_count = int(stress_stats.get("thermal_valid_pixel_count", 0))
        thermal_critical_ratio = (
            float(stress_stats.get("thermal_critical_ratio", 0.0))
            if thermal_valid_pixel_count
            else 0.0
        )
        thermal_watch_ratio = (
            float(stress_stats.get("thermal_watch_ratio", 0.0))
            if thermal_valid_pixel_count
            else 0.0
        )
        has_critical_heat = (
            thermal_critical_ratio >= 0.15
            or thermal_critical_pixel_count >= 3
            or (mean_lst_celsius is not None and mean_lst_celsius >= 38.0)
        )
        has_watch_heat = (
            thermal_watch_ratio >= 0.05
            or thermal_watch_pixel_count >= 1
            or (mean_lst_celsius is not None and mean_lst_celsius >= 34.0)
        )

        if (
            anomaly_ratio >= 0.15
            or (anomaly_count >= 3 and mean_ndvi < 0.45)
            or has_critical_heat
        ):
            risk_level = "เสี่ยงรุนแรง"
        elif (
            anomaly_ratio >= 0.05
            or anomaly_count >= 1
            or mean_ndvi < 0.5
            or has_watch_heat
        ):
            risk_level = "เฝ้าระวัง"
        else:
            risk_level = "ปกติ"

        return AnalyzeStressResponse(
            tile_url=str(stress_stats["tile_url"]),
            tile_urls={
                str(key): str(value)
                for key, value in dict(stress_stats.get("tile_urls", {})).items()
            },
            start_date=str(stress_stats["start_date"]),
            end_date=str(stress_stats["end_date"]),
            mean_ndvi=mean_ndvi,
            mean_ndwi=float(stress_stats["mean_ndwi"]),
            mean_lst_celsius=mean_lst_celsius,
            lst_status=str(stress_stats.get("lst_status", "unknown")),
            lst_error=(
                str(stress_stats["lst_error"])
                if stress_stats.get("lst_error") is not None
                else None
            ),
            lst_source=(
                str(stress_stats["lst_source"])
                if stress_stats.get("lst_source") is not None
                else None
            ),
            anomaly_count=anomaly_count,
            anomaly_ratio=anomaly_ratio,
            anomaly_model_features=[
                str(feature)
                for feature in stress_stats.get("anomaly_model_features", [])
            ],
            thermal_valid_pixel_count=thermal_valid_pixel_count,
            thermal_critical_pixel_count=thermal_critical_pixel_count,
            thermal_watch_pixel_count=thermal_watch_pixel_count,
            thermal_critical_ratio=thermal_critical_ratio,
            thermal_watch_ratio=thermal_watch_ratio,
            rainfall_30d_mm=float(stress_stats["rainfall_30d_mm"]),
            risk_level=risk_level,
            valid_pixel_count=valid_pixel_count,
            pixel_count=valid_pixel_count,
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
    current_user: str = Depends(get_current_user)
) -> AnalyzeFieldResponse:
    """Run the full satellite crop-health pipeline for a field bounding box."""

    rainfall_15d_mm = (
        request.rainfall_15d_mm
        if request.rainfall_15d_mm is not None
        else settings.default_rainfall_mm_15d
    )

    try:
        analysis = service.analyze(
            AnalysisInputs(
                bbox=request.bbox,
                polygon=request.polygon,
                time_range=str(request.time_range),
                rainfall_15d_mm=rainfall_15d_mm,
            )
        )
        analysis.polygon = request.polygon
        return analysis
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

