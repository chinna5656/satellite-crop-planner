# Backend ระบบวางแผนเพาะปลูกด้วยดาวเทียม

FastAPI backend สำหรับวิเคราะห์สุขภาพพืชและความเสี่ยงรายแปลงจากข้อมูลดาวเทียม

## รันระบบ

```powershell
cd ..
.\scripts\run-dev.ps1
```

## Production

จากโฟลเดอร์หลักของโปรเจกต์:

```powershell
Copy-Item .env.example .env
.\scripts\run-prod.ps1 -HostName 0.0.0.0 -Port 8000 -Workers 2
```

ตั้งค่าโดเมน production ใน `.env`:

```text
CROP_API_ENVIRONMENT=production
CROP_API_DOCS_ENABLED=false
CROP_API_CORS_ORIGINS=["https://your-domain.example"]
CROP_API_ALLOWED_HOSTS=["your-domain.example","127.0.0.1"]
```

## สร้าง venv เท่านั้น

จากโฟลเดอร์หลักของโปรเจกต์:

```powershell
.\scripts\create-venv.ps1
```

PowerShell แบบ manual:

```powershell
python -m venv backend\.venv
backend\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r backend\requirements.txt
```

Command Prompt แบบ manual:

```bat
python -m venv backend\.venv
backend\.venv\Scripts\activate.bat
python -m pip install --upgrade pip
python -m pip install -r backend\requirements.txt
```

## ตัวอย่าง Request

Use the GeoJSON Polygon example in the next section for current dashboard analysis requests.

`rainfall_15d_mm` เป็น metadata ทางเลือก ถ้าไม่ส่งมา API จะใช้ค่า `CROP_API_DEFAULT_RAINFALL_MM_15D` ซึ่งค่าเริ่มต้นคือ `0`

## Current Polygon Request Shape

`POST /api/analyze-field` accepts GeoJSON Polygon input. `bbox` remains supported only as a backward-compatible fallback.

```bash
curl -X POST http://127.0.0.1:8000/api/analyze-field \
  -H "Content-Type: application/json" \
  -d '{
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
  }'
```

The request model normalizes this into:

- `polygon`: closed GeoJSON Polygon in WGS84 lon/lat order
- `bbox`: derived `[min_lon, min_lat, max_lon, max_lat]` load window
- `time_range`: derived from `start_date` and `end_date` when omitted

## Pipeline

Current polygon-first behavior:

- Pydantic validates and normalizes the incoming polygon.
- STAC search uses `intersects=polygon` for Sentinel-2 and Landsat.
- `bbox` is used only as the efficient `odc.stac.load` window.
- Sentinel-2 rasters are clipped to the polygon before NDVI calculation.
- Landsat thermal rasters are clipped to the polygon before LST calculation.
- Landsat search relaxes cloud cover thresholds and expands the time range by 15 and 30 days before giving up.
- If Landsat/LST is missing, the API still returns NDVI, anomaly pixels, and `lst_status="missing"`.
- The anomaly detector switches feature sets based on LST availability and reports the chosen set in `anomaly_model_features`.

LST response contract when available:

```json
{
  "lst_summary": {
    "mean": 31.2,
    "min": 27.4,
    "max": 36.9,
    "valid_pixel_count": 120
  },
  "lst_status": "available",
  "lst_error": null
}
```

LST response contract when missing:

```json
{
  "lst_summary": {
    "mean": null,
    "min": null,
    "max": null,
    "valid_pixel_count": 0
  },
  "lst_status": "missing",
  "lst_error": "No Landsat 8/9 Level-1 scenes with TIRS Band 10 found for the requested polygon/time_range after cloud and time-window fallbacks."
}
```

Anomaly model feature sets:

| LST state | `anomaly_model_features` |
| --- | --- |
| Available | `["ndvi", "ndvi_diff", "lst_celsius", "rainfall_15d_mm"]` |
| Missing | `["ndvi", "ndvi_diff", "rainfall_15d_mm"]` |

For very small polygons with fewer than 8 valid pixels, Isolation Forest does not fit, but rule-based anomaly guards still run for sharp NDVI drops under high rainfall and heat stress when LST is available.

- ค้นหา Sentinel-2 L2A จาก Planetary Computer STAC โดยใช้ `eo:cloud_cover < 10`
- โหลดแบนด์ Red `B04` และ NIR `B08` ที่ความละเอียด 10 เมตร
- คำนวณ NDVI และ reproject raster เป็น EPSG:4326
- ค้นหา Landsat Collection 2 Level-1 และโหลด TIRS Band 10
- แปลง thermal DN เป็น TOA radiance, brightness temperature, LST ที่ปรับ emissivity แล้ว และ Celsius
- ใช้ Isolation Forest กับ NDVI ปัจจุบัน, ความต่าง NDVI ลำดับแรก และฝนสะสม 15 วัน
- ส่งคืน NDVI, LST, ความต่าง NDVI, ฝน และ flag ความผิดปกติราย pixel
