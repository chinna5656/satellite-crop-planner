# ระบบวางแผนเพาะปลูกด้วยดาวเทียม

แดชบอร์ด FastAPI + Leaflet สำหรับวิเคราะห์สุขภาพพืช วางแผนการปลูก และตรวจสอบความเสี่ยงจากข้อมูลดาวเทียม

## รัน Frontend และ Backend พร้อมกัน

โหมดพัฒนาจะเปิด reload และใช้ค่าตั้งต้นในเครื่อง

PowerShell:

```powershell
.\scripts\run-dev.ps1
```

Command Prompt:

```bat
scripts\run-dev.bat
```

ตัวอย่าง PowerShell เพิ่มเติม:

```powershell
.\scripts\run-dev.ps1 -Port 8080
.\scripts\run-dev.ps1 -HostName 0.0.0.0 -Port 8000
.\scripts\run-dev.ps1 -SkipInstall
.\scripts\run-dev.ps1 -RecreateVenv
```

ตัวอย่าง Command Prompt เพิ่มเติม:

```bat
set APP_PORT=8080
scripts\run-dev.bat

set SKIP_INSTALL=1
scripts\run-dev.bat

set RECREATE_VENV=1
scripts\run-dev.bat
```

จากนั้นเปิด:

- แดชบอร์ด: http://127.0.0.1:8000
- แผนที่ราสเตอร์ NDVI/LST: http://127.0.0.1:8000/raster
- เอกสาร API: http://127.0.0.1:8000/docs
- ตรวจสถานะระบบ: http://127.0.0.1:8000/health
- ผังการประมวลผลเว็บ: [docs/web-processing-flowchart.md](docs/web-processing-flowchart.md)

## รัน Production

คัดลอกไฟล์ตัวอย่าง environment แล้วแก้ค่าให้ตรงกับโดเมนจริง:

```powershell
Copy-Item .env.example .env
```

PowerShell:

```powershell
.\scripts\run-prod.ps1 -HostName 0.0.0.0 -Port 8000 -Workers 2
```

Command Prompt:

```bat
set APP_WORKERS=2
scripts\run-prod.bat
```

Docker:

```powershell
docker build -t satellite-crop-planner .
docker run --env-file .env -p 8000:8000 satellite-crop-planner
```

ค่าระบบ production ใช้ตัวแปร environment ที่ขึ้นต้นด้วย `CROP_API_*` เช่น:

- `CROP_API_ENVIRONMENT=production`
- `CROP_API_DOCS_ENABLED=false`
- `CROP_API_CORS_ORIGINS=["https://your-domain.example"]`
- `CROP_API_ALLOWED_HOSTS=["your-domain.example","127.0.0.1"]`
- `CROP_API_MAX_RESPONSE_PIXELS=15000`

## สร้าง Virtual Environment ของ Backend

ใช้เมื่อต้องการเตรียม dependency ก่อนเริ่ม server

PowerShell:

```powershell
.\scripts\create-venv.ps1
```

Command Prompt:

```bat
scripts\create-venv.bat
```

ขั้นตอน PowerShell แบบ manual:

```powershell
python -m venv backend\.venv
backend\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r backend\requirements.txt
```

ขั้นตอน Command Prompt แบบ manual:

```bat
python -m venv backend\.venv
backend\.venv\Scripts\activate.bat
python -m pip install --upgrade pip
python -m pip install -r backend\requirements.txt
```

ถ้า `python` เปิด Microsoft Store หรือรันไม่สำเร็จ ให้ติดตั้ง Python 3.11+ จาก `https://www.python.org/downloads/` และเลือก `Add python.exe to PATH` ตอนติดตั้ง

ถ้า `backend\.venv` มีอยู่แล้วแต่ชี้ไปยัง Python ที่เสีย ให้สร้างใหม่:

```powershell
.\scripts\create-venv.ps1 -Recreate
```

## แก้ปัญหา API

ถ้า API เริ่มไม่ขึ้นและมีข้อความประมาณนี้:

```text
Unable to create process using ... WindowsApps ... python.exe
```

แปลว่า virtual environment ของ backend ถูกสร้างจาก Microsoft Store Python ให้ติดตั้ง Python 3.11+ จาก `https://www.python.org/downloads/` เปิดใช้ `Add python.exe to PATH` แล้วสร้าง venv ใหม่:

```powershell
.\scripts\run-dev.ps1 -RecreateVenv
```

ถ้า Windows ยังส่ง `python` ไปที่ Store ให้ปิด App Execution Aliases ของ `python.exe` และ `python3.exe` ใน Windows Settings แล้วรันใหม่

## แหล่งข้อมูลดาวเทียม

ระบบใช้ Microsoft Planetary Computer ผ่าน STAC API และ Data API สำหรับ Sentinel-2, Landsat และ tile overlay ของหน้า raster จึงไม่ต้องตั้งค่า credential เพิ่ม

## โครงสร้างโปรเจกต์

```text
backend/
  app/
  requirements.txt
  .venv/              # สร้างโดย scripts
frontend/
  index.html
  app.js
  styles.css
scripts/
  create-venv.ps1
  create-venv.bat
  run-dev.ps1
  run-dev.bat
  run-prod.ps1
  run-prod.bat
docs/
  web-processing-flowchart.md
```

## รายละเอียดการเชื่อมต่อ

- `GET /` ให้บริการหน้า `frontend/index.html`
- `GET /raster` ให้บริการหน้าแผนที่ราสเตอร์ NDVI/LST
- `GET /static/app.js` และ `GET /static/styles.css` ให้บริการไฟล์ frontend
- `POST /api/analyze-field` รัน API วิเคราะห์สุขภาพพืช
- `POST /analyze-field` ยังรองรับเพื่อความเข้ากันได้
- frontend เรียก `window.CROP_API_URL || "/api/analyze-field"` จึงใช้ same-origin เมื่อให้บริการผ่าน FastAPI

## หมายเหตุ Production

- ใช้ HTTPS ที่ reverse proxy หรือ load balancer
- ตั้งค่า `CROP_API_CORS_ORIGINS` และ `CROP_API_ALLOWED_HOSTS` ให้ตรงกับโดเมนจริง
- ตั้ง `CROP_API_DOCS_ENABLED=false` ถ้าไม่ต้องการเปิดเอกสาร API สาธารณะ
- เพิ่ม `CROP_API_MAX_RESPONSE_PIXELS` เฉพาะเมื่อ client รองรับ JSON raster ขนาดใหญ่ได้
"# satellite-crop-planner" 

## Polygon Analysis API Update

`POST /api/analyze-field` is now polygon-first. The frontend sends a GeoJSON Polygon, and the backend:

- validates and normalizes the polygon with Pydantic
- derives a bbox only as an efficient raster load window
- searches Microsoft Planetary Computer STAC with `intersects=polygon`
- loads Sentinel-2 and Landsat assets with `odc.stac`
- clips rasters to the exact polygon with `rioxarray.rio.clip`
- returns the normalized `polygon` in the response for map display

Example request:

```json
{
  "polygon": {
    "type": "Polygon",
    "coordinates": [
      [
        [100.521, 14.215],
        [100.5215, 14.215],
        [100.5215, 14.2155],
        [100.521, 14.2155],
        [100.521, 14.215]
      ]
    ]
  },
  "start_date": "2025-01-01",
  "end_date": "2025-02-28",
  "rainfall_15d_mm": 10.0
}
```

`bbox` is still accepted for compatibility. If only `bbox` is sent, the backend creates a rectangular polygon from it.

## LST Fallback Behavior

LST is optional and multi-source. The backend tries Landsat 8/9 Level-1 TIRS Band 10 first, then falls back to ECOSTRESS LST for small polygons or narrow date ranges. If both thermal sources are unavailable, the API still returns NDVI and anomaly results.

Missing LST response fields:

```json
{
  "lst_summary": {
    "mean": null,
    "min": null,
    "max": null,
    "valid_pixel_count": 0
  },
  "lst_status": "missing",
  "lst_source": "Sentinel-2 Only",
  "lst_error": "Reason from backend",
  "pixels": [
    {
      "lst_celsius": null
    }
  ]
}
```

The frontend displays `-- °C` for missing LST and shows the `lst_status` or `lst_error` reason under the Avg LST KPI.

## Dynamic Anomaly Detection

The anomaly model adapts to LST availability:

- LST available: Isolation Forest uses `ndvi`, `ndvi_diff`, `lst_celsius`, and `rainfall_15d_mm`.
- LST missing: Isolation Forest falls back to `ndvi`, `ndvi_diff`, and `rainfall_15d_mm`.
- Very small polygons with too few pixels still run rule-based anomaly guards for sharp NDVI drops and heavy rainfall.

The API returns `anomaly_model_features` so the frontend and logs can show which mode was used.

## k6 Web Test

Install k6 first: https://grafana.com/docs/k6/latest/set-up/install-k6/

Start the FastAPI app, then run a web smoke/load test:

```powershell
.\scripts\run-k6.ps1
```

Command Prompt:

```bat
scripts\run-k6.bat
```

Custom target and load:

```powershell
.\scripts\run-k6.ps1 -BaseUrl http://127.0.0.1:8000 -Vus 10 -Duration 1m
```

The default test checks `/`, `/raster`, `/api/health`, and static frontend assets.

To also test the heavier satellite analysis endpoints:

```powershell
.\scripts\run-k6.ps1 -RunAnalysis -Duration 1m
```

The same options are available in Command Prompt through environment variables:

```bat
set BASE_URL=http://127.0.0.1:8000
set CROP_K6_VUS=10
set CROP_K6_DURATION=1m
set RUN_ANALYSIS=1
scripts\run-k6.bat
```

The k6 script writes `k6-summary.json` after each run.

## Data Transfer Workflow

See [docs/data-transfer-workflow.md](docs/data-transfer-workflow.md) for the Leaflet-to-FastAPI-to-Planetary-Computer request/response workflow.

## Raster Layer Switching

The `/raster` page now expects `/api/analyze-stress` to return a `tile_urls` object keyed by `ndvi`, `lst`, and `anomaly`. The frontend switches between available tile layers without calling the API again. If Landsat thermal data is missing, the backend keeps the Sentinel NDVI response successful, returns `mean_lst_celsius: null`, and disables only unavailable LST tiles.

The raster page also supports manual JSON import for saved backend responses. Imported files can use either the current `tile_urls` response shape or the older single `tile_url` field, but only explicitly provided layers are enabled.
