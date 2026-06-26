# Frontend ระบบวางแผนเพาะปลูก

แดชบอร์ดให้บริการผ่าน FastAPI ที่ `http://127.0.0.1:8000`

หน้าจอมีความสามารถหลัก:

- แผนที่ภาพถ่ายดาวเทียม Esri บน Leaflet
- เครื่องมือวาดรูปหลายเหลี่ยมและสี่เหลี่ยมด้วย Leaflet.Draw
- สร้าง bbox แบบ WGS84 ในรูปแบบ `[min_lon, min_lat, max_lon, max_lat]`
- เรียก API แบบ same-origin ไปที่ `/api/analyze-field`
- หน้าแสดงราสเตอร์ NDVI/LST ที่ `/raster`
- หมุดแจ้งเตือนสีเขียวและสีแดงจาก JSON ของ backend
- popup พร้อมกราฟแนวโน้ม NDVI และฝนสะสม
- sidebar วางแผนการปลูกแบบ responsive พร้อม KPI และแนวโน้มความชื้นดินจาก LST

สำหรับการทดสอบในเครื่อง ให้รัน frontend และ backend จากโฟลเดอร์หลัก:

```powershell
.\scripts\run-dev.ps1
```
