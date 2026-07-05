# Web Processing Flowchart

This document shows the main processing flow for the Satellite-Based Crop Planting and Management System.

## Overall Web Flow

```mermaid
flowchart TD
    A["Farmer opens web app"] --> B["FastAPI serves frontend HTML, CSS, and JavaScript"]
    B --> C{"Selected page"}
    C --> D["Dashboard page /"]
    C --> E["Raster map page /raster"]

    D --> F["Leaflet dashboard loads map and controls"]
    F --> G["User draws field polygon or rectangle"]
    G --> H["Frontend sends GeoJSON Polygon"]
    H --> I["POST /api/analyze-field"]
    I --> J["Backend searches STAC with intersects=polygon"]
    J --> K["Load bbox window and clip rasters to polygon"]
    K --> L["Return NDVI, optional LST, anomaly flags, KPIs, and result polygon"]
    L --> M["Frontend renders KPI cards, polygon overlay, pins, popups, and charts"]

    E --> N["Leaflet raster map loads OpenStreetMap base layer"]
    N --> O["User draws one polygon or rectangle"]
    O --> P["Frontend sends GeoJSON coordinates and date range"]
    P --> Q["POST /api/analyze-stress"]
    Q --> R["Backend runs Microsoft Planetary Computer STAC analysis"]
    R --> S["Return Planetary Computer tile_url and field statistics"]
    S --> T["Frontend adds tile_url as raster overlay"]
```

## Dashboard Analysis Flow

```mermaid
flowchart TD
    A["Request body: GeoJSON polygon, start_date, end_date"] --> B["Validate GeoJSON Polygon and date range"]
    B --> C{"Valid request?"}
    C -->|"No"| D["Return 422 validation error"]
    C -->|"Yes"| E["Derive bbox load window from polygon"]

    E --> F["Search Sentinel-2 L2A with STAC intersects=polygon"]
    F --> G["Filter cloud cover with configured thresholds"]
    G --> H{"Sentinel-2 imagery found?"}
    H -->|"No"| I["Return user-friendly no imagery error"]
    H -->|"Yes"| J["Load Red B04 and NIR B08 with odc.stac"]

    J --> K["Clip Sentinel raster to polygon with rioxarray"]
    K --> L["Reproject raster to EPSG:4326"]
    L --> M["Calculate NDVI = (NIR - Red) / (NIR + Red)"]

    E --> N["Search Landsat 8/9 with STAC intersects=polygon"]
    N --> O["Relax cloud threshold and expand time window if needed"]
    O --> P{"TIRS Band 10 found?"}
    P -->|"Yes"| Q["Load Band 10, clip to polygon, convert to LST Celsius"]
    P -->|"No"| R["Set LST raster to NaN and lst_status=missing"]

    M --> S["Build anomaly feature array"]
    Q --> S
    R --> S
    T["15-day cumulative rainfall metadata"] --> S
    S --> U["Isolation Forest anomaly detection"]
    U --> V["Serialize clipped pixels"]
    V --> W["Return polygon, pixels, NDVI summary, LST summary/status, and KPIs"]
```

## Raster And Planetary Computer Stress Flow

```mermaid
flowchart TD
    A["Request body: GeoJSON polygon, start_date/end_date or target_date"] --> B["Validate geometry and dates"]
    B --> C["Normalize polygon coordinates and derive bbox load window"]
    C --> D["Build STAC datetime interval"]

    D --> E["Query Microsoft Planetary Computer STAC with intersects=polygon"]
    E --> F["Search Sentinel-2 L2A"]
    F --> G["Filter eo:cloud_cover under configured threshold"]
    G --> H{"Sentinel-2 imagery found?"}
    H -->|"No"| I["Return user-friendly no imagery error"]
    H -->|"Yes"| J["Load B03 Green, B04 Red, and B08 NIR with odc.stac"]
    J --> K["Clip raster to polygon"]
    K --> L["Calculate NDVI and NDWI with xarray"]
    L --> M["Extract mean NDVI and NDWI over field"]

    E --> N["Search Landsat 8/9 thermal imagery"]
    N --> O["Use cloud and time-window fallback"]
    O --> P["Load TIRS Band 10 when available"]
    P --> Q["Convert DN to radiance, brightness temperature, emissivity-corrected LST Celsius"]
    Q --> R["Extract mean LST over field, or null if missing"]

    H --> S["Create Planetary Computer Data API NDVI tile URL"]
    M --> T["Create analysis response"]
    R --> T
    S --> T
    T --> U["Return tile_url, NDVI, NDWI, optional LST, risk level, and statistics"]
```

## LST Missing Flow

```mermaid
flowchart TD
    A["Search Landsat 8/9 Level-1"] --> B{"Scene with B10 found?"}
    B -->|"Yes"| C["Load thermal raster"]
    C --> D{"Valid LST pixels after polygon clip?"}
    D -->|"Yes"| E["lst_status=available and lst_summary.mean has value"]
    D -->|"No"| F["lst_status=missing and lst_summary values are null"]
    B -->|"No"| G["Relax cloud threshold and expand time window"]
    G --> H{"Fallback scene found?"}
    H -->|"Yes"| C
    H -->|"No"| F
    F --> I["NDVI and anomaly results still return successfully"]
```

## Frontend Error Flow

```mermaid
flowchart TD
    A["User clicks analyze"] --> B{"Field drawn?"}
    B -->|"No"| C["Show: draw a field boundary first"]
    B -->|"Yes"| D{"Dates selected?"}
    D -->|"No"| E["Show: select a valid date range"]
    D -->|"Yes"| F["Send polygon POST request"]
    F --> G{"API response ok?"}
    G -->|"Yes"| H["Render polygon overlay, alerts, charts, and KPIs"]
    G -->|"No"| I["Read API error detail"]
    I --> J["Show friendly message in the UI"]
```

## Endpoint Summary

| Endpoint | Used By | Main Purpose |
| --- | --- | --- |
| `GET /` | Dashboard UI | Main crop health dashboard |
| `GET /raster` | Raster UI | NDVI/LST raster overlay map |
| `POST /api/analyze-field` | Dashboard UI | Polygon-clipped STAC NDVI, optional LST, anomaly, and KPI processing |
| `POST /api/analyze-stress` | Raster UI | Planetary Computer field stress statistics and tile overlay |
| `GET /api/health` | Scripts and monitoring | API readiness check |
