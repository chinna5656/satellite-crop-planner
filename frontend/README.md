# Frontend ระบบวางแผนเพาะปลูก

แดชบอร์ดให้บริการผ่าน FastAPI ที่ `http://127.0.0.1:8000`

หน้าจอมีความสามารถหลัก:

- แผนที่ภาพถ่ายดาวเทียม Esri บน Leaflet
- เครื่องมือวาดรูปหลายเหลี่ยมและสี่เหลี่ยมด้วย Leaflet.Draw
- สร้าง GeoJSON Polygon แบบ WGS84 และส่งไปยัง backend; bbox ถูกใช้เป็น fallback เท่านั้น
- เรียก API แบบ same-origin ไปที่ `/api/analyze-field`
- หน้าแสดงราสเตอร์ NDVI/LST ที่ `/raster`
- หมุดแจ้งเตือนสีเขียวและสีแดงจาก JSON ของ backend
- popup พร้อมกราฟแนวโน้ม NDVI และฝนสะสม
- sidebar วางแผนการปลูกแบบ responsive พร้อม KPI และแนวโน้มความชื้นดินจาก LST

## Current API Payload

The dashboard sends a GeoJSON Polygon to `/api/analyze-field`:

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

The response includes the normalized `polygon`, `ndvi_summary`, optional `lst_summary`, `lst_status`, `lst_error`, and sampled `pixels`.

## Avg LST Display

The Avg LST KPI reads `lst_summary.mean` first. If LST is missing, the backend returns `lst_summary.mean: null` and `lst_status: "missing"`. The frontend displays `-- °C` and shows the missing reason under the KPI instead of showing `0.0 °C`.

สำหรับการทดสอบในเครื่อง ให้รัน frontend และ backend จากโฟลเดอร์หลัก:

```powershell
.\scripts\run-dev.ps1
```
