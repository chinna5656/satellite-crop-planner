# ==========================================
# โซนที่ 1: การนำเข้าไลบรารี (Imports)
# ==========================================
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.security import OAuth2PasswordBearer
from fastapi.staticfiles import StaticFiles

from jose import JWTError, jwt
from passlib.context import CryptContext
from sqlalchemy.orm import Session

# Local Imports
from app.config import Settings, get_settings
from app.database import Base, SessionLocal, engine
from app.exceptions import CropAnalysisError, ImageryNotFoundError
from app.geospatial import (
    AnalysisInputs,
    CropAnalysisService,
    analyze_field_with_planetary_computer,
)
from app.models import User
from app.schemas import (
    AnalyzeFieldRequest,
    AnalyzeFieldResponse,
    AnalyzeStressRequest,
    AnalyzeStressResponse,
    Token,
    UserLogin,
)

# ==========================================
# โซนที่ 2: การตั้งค่าระบบฐานข้อมูลและความปลอดภัย
# ==========================================
settings = get_settings()
PROJECT_ROOT = Path(__file__).resolve().parents[2]
FRONTEND_DIR = PROJECT_ROOT / "frontend"

# สร้างตารางฐานข้อมูลอัตโนมัติ
Base.metadata.create_all(bind=engine)

# การตั้งค่าความปลอดภัย (JWT และ Password Hashing)
ALGORITHM = "HS256"
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="api/login", auto_error=False)

# สร้างแอปพลิเคชัน FastAPI
app = FastAPI(
    title=settings.app_name,
    version=settings.app_version,
    description="ระบบวิเคราะห์พืชผลและวางแผนเพาะปลูกด้วยดาวเทียม",
    docs_url="/docs" if settings.docs_enabled else None,
    redoc_url="/redoc" if settings.docs_enabled else None,
    openapi_url="/openapi.json" if settings.docs_enabled else None,
)

# ==========================================
# โซนที่ 3: Middlewares (การจัดการ Request/Response ส่วนกลาง)
# ==========================================
app.add_middleware(TrustedHostMiddleware, allowed_hosts=settings.allowed_hosts)
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
    elif request.url.path in {"/", "/raster", "/login", "/register"} or request.url.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response

if settings.serve_frontend and FRONTEND_DIR.exists():
    app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="frontend-static")

# ==========================================
# โซนที่ 4: Dependencies (ตัวช่วยดึงข้อมูลที่ใช้บ่อย)
# ==========================================
def get_db():
    """เปิด-ปิด การเชื่อมต่อฐานข้อมูลในแต่ละ Request"""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

def get_crop_analysis_service(settings_dep: Settings = Depends(get_settings)) -> CropAnalysisService:
    return CropAnalysisService(settings_dep)

def get_current_user(token: str = Depends(oauth2_scheme)) -> str:
    """ฟังก์ชันด่านตรวจเช็กตั๋ว JWT"""
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="กรุณาเข้าสู่ระบบก่อนใช้งาน",
        headers={"WWW-Authenticate": "Bearer"},
    )
    if not token:
        raise credentials_exception
    try:
        payload = jwt.decode(token, settings.jwt_secret_key, algorithms=[ALGORITHM])
        username: str = payload.get("sub")
        if username is None:
            raise credentials_exception
        return username
    except JWTError:
        raise credentials_exception

# ==========================================
# โซนที่ 5: Frontend Pages Routes (การเสิร์ฟหน้าเว็บ HTML)
# ==========================================
def serve_html(filename: str) -> FileResponse:
    """ฟังก์ชันช่วยเสิร์ฟไฟล์ HTML"""
    if not settings.serve_frontend:
        raise HTTPException(status_code=404, detail="Frontend serving is disabled")
    file_path = FRONTEND_DIR / filename
    if not file_path.exists():
        raise HTTPException(status_code=404, detail=f"frontend/{filename} not found")
    return FileResponse(file_path)

@app.get("/", include_in_schema=False)
def frontend(): return serve_html("index.html")

@app.get("/raster", include_in_schema=False)
def raster_page(): return serve_html("raster.html")

@app.get("/login", include_in_schema=False)
@app.get("/login.html", include_in_schema=False)
def login_page(): return serve_html("login.html")

@app.get("/register", include_in_schema=False)
@app.get("/register.html", include_in_schema=False)
def register_page(): return serve_html("register.html")

# ==========================================
# โซนที่ 6: API Routes (การจัดการข้อมูลหลังบ้าน)
# ==========================================
@app.get("/favicon.ico", include_in_schema=False)
def favicon(): return Response(status_code=status.HTTP_204_NO_CONTENT)

@app.get("/health")
@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok", "environment": settings.environment, "version": settings.app_version}

@app.get("/api/routes", include_in_schema=False)
def api_routes() -> dict[str, list[str]]:
    routes = [f"{','.join(sorted(getattr(r, 'methods', [])))} {getattr(r, 'path', '')}" for r in app.routes if getattr(r, 'path', None)]
    return {"routes": sorted(routes)}

# --- Auth APIs ---
@app.post("/api/register")
def register(user_data: UserLogin, db: Session = Depends(get_db)):
    if db.query(User).filter(User.username == user_data.username).first():
        raise HTTPException(status_code=400, detail="ชื่อผู้ใช้งานนี้ถูกใช้งานไปแล้ว")
    
    hashed_password = pwd_context.hash(user_data.password)
    db.add(User(username=user_data.username, hashed_password=hashed_password))
    db.commit()
    return {"message": "สมัครสมาชิกสำเร็จ สามารถเข้าสู่ระบบได้เลย"}

@app.post("/api/login", response_model=Token)
def login(user_data: UserLogin, db: Session = Depends(get_db)) -> dict:
    user = db.query(User).filter(User.username == user_data.username).first()
    if not user or not pwd_context.verify(user_data.password, user.hashed_password):
         raise HTTPException(status_code=401, detail="ชื่อผู้ใช้งาน หรือ รหัสผ่านไม่ถูกต้อง")

    expire = datetime.now(timezone.utc) + timedelta(minutes=settings.access_token_expire_minutes)
    token_data = {"sub": user.username, "exp": expire}
    return {"access_token": jwt.encode(token_data, settings.jwt_secret_key, algorithm=ALGORITHM), "token_type": "bearer"}

# --- Analysis APIs ---
@app.post("/api/analyze-stress", response_model=AnalyzeStressResponse)
def analyze_stress(request: AnalyzeStressRequest, current_user: str = Depends(get_current_user)):
    try:
        stress_stats = analyze_field_with_planetary_computer(
            request.polygon_coordinates(), str(request.start_date), str(request.end_date), settings
        )
        # โลจิกคำนวณความเสี่ยง (ย่อให้กระชับขึ้น)
        mean_lst = float(stress_stats.get("mean_lst_celsius")) if stress_stats.get("mean_lst_celsius") else None
        valid_px = int(stress_stats.get("valid_pixel_count", 0))
        anomaly_ratio = float(stress_stats.get("anomaly_ratio", 0.0)) if valid_px else 0.0
        thermal_crit = float(stress_stats.get("thermal_critical_ratio", 0.0)) if int(stress_stats.get("thermal_valid_pixel_count", 0)) else 0.0
        
        has_critical = thermal_crit >= 0.15 or int(stress_stats.get("thermal_critical_pixel_count", 0)) >= 3 or (mean_lst and mean_lst >= 38.0)
        has_watch = float(stress_stats.get("thermal_watch_ratio", 0.0)) >= 0.05 or int(stress_stats.get("thermal_watch_pixel_count", 0)) >= 1 or (mean_lst and mean_lst >= 34.0)

        risk_level = "เสี่ยงรุนแรง" if anomaly_ratio >= 0.15 or (int(stress_stats.get("anomaly_count", 0)) >= 3 and float(stress_stats["mean_ndvi"]) < 0.45) or has_critical else ("เฝ้าระวัง" if anomaly_ratio >= 0.05 or int(stress_stats.get("anomaly_count", 0)) >= 1 or float(stress_stats["mean_ndvi"]) < 0.5 or has_watch else "ปกติ")

        return AnalyzeStressResponse(
            tile_url=str(stress_stats["tile_url"]),
            tile_urls={str(k): str(v) for k, v in dict(stress_stats.get("tile_urls", {})).items()},
            start_date=str(stress_stats["start_date"]),
            end_date=str(stress_stats["end_date"]),
            mean_ndvi=float(stress_stats["mean_ndvi"]),
            mean_ndwi=float(stress_stats["mean_ndwi"]),
            mean_lst_celsius=mean_lst,
            lst_status=str(stress_stats.get("lst_status", "unknown")),
            lst_error=str(stress_stats["lst_error"]) if stress_stats.get("lst_error") else None,
            lst_source=str(stress_stats["lst_source"]) if stress_stats.get("lst_source") else None,
            anomaly_count=int(stress_stats.get("anomaly_count", 0)),
            anomaly_ratio=anomaly_ratio,
            anomaly_model_features=[str(f) for f in stress_stats.get("anomaly_model_features", [])],
            thermal_valid_pixel_count=int(stress_stats.get("thermal_valid_pixel_count", 0)),
            thermal_critical_pixel_count=int(stress_stats.get("thermal_critical_pixel_count", 0)),
            thermal_watch_pixel_count=int(stress_stats.get("thermal_watch_pixel_count", 0)),
            thermal_critical_ratio=thermal_crit,
            thermal_watch_ratio=float(stress_stats.get("thermal_watch_ratio", 0.0)),
            rainfall_30d_mm=float(stress_stats["rainfall_30d_mm"]),
            risk_level=risk_level,
            valid_pixel_count=valid_px,
            pixel_count=valid_px,
            source=str(stress_stats.get("source", "Microsoft Planetary Computer")),
        )
    except (ValueError, ImageryNotFoundError, CropAnalysisError) as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Unexpected analysis failure: {exc}")

@app.post("/api/analyze-field", response_model=AnalyzeFieldResponse)
def analyze_field(request: AnalyzeFieldRequest, settings: Settings = Depends(get_settings), service: CropAnalysisService = Depends(get_crop_analysis_service), current_user: str = Depends(get_current_user)):
    try:
        analysis = service.analyze(AnalysisInputs(
            bbox=request.bbox,
            polygon=request.polygon,
            time_range=str(request.time_range),
            rainfall_15d_mm=request.rainfall_15d_mm if request.rainfall_15d_mm is not None else settings.default_rainfall_mm_15d,
        ))
        analysis.polygon = request.polygon
        return analysis
    except (ImageryNotFoundError, CropAnalysisError) as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Unexpected crop analysis failure: {exc}")