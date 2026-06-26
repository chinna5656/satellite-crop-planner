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

```bash
curl -X POST http://127.0.0.1:8000/api/analyze-field \
  -H "Content-Type: application/json" \
  -d '{
    "bbox": [100.45, 13.65, 100.55, 13.75],
    "time_range": "2025-05-01/2025-06-01",
    "rainfall_15d_mm": 42
  }'
```

`rainfall_15d_mm` เป็น metadata ทางเลือก ถ้าไม่ส่งมา API จะใช้ค่า `CROP_API_DEFAULT_RAINFALL_MM_15D` ซึ่งค่าเริ่มต้นคือ `0`

## Pipeline

- ค้นหา Sentinel-2 L2A จาก Planetary Computer STAC โดยใช้ `eo:cloud_cover < 10`
- โหลดแบนด์ Red `B04` และ NIR `B08` ที่ความละเอียด 10 เมตร
- คำนวณ NDVI และ reproject raster เป็น EPSG:4326
- ค้นหา Landsat Collection 2 Level-1 และโหลด TIRS Band 10
- แปลง thermal DN เป็น TOA radiance, brightness temperature, LST ที่ปรับ emissivity แล้ว และ Celsius
- ใช้ Isolation Forest กับ NDVI ปัจจุบัน, ความต่าง NDVI ลำดับแรก และฝนสะสม 15 วัน
- ส่งคืน NDVI, LST, ความต่าง NDVI, ฝน และ flag ความผิดปกติราย pixel
