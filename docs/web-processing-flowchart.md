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
    K --> L["Return NDVI, optional LST, anomaly flags, anomaly feature set, KPIs, and result polygon"]
    L --> M["Frontend renders KPI cards, polygon overlay, pins, popups, and charts"]

    E --> N["Leaflet raster map loads OpenStreetMap base layer"]
    N --> O["User draws one polygon or rectangle"]
    O --> P["Frontend sends GeoJSON coordinates and date range"]
    P --> Q["POST /api/analyze-stress"]
    Q --> R["Backend runs Microsoft Planetary Computer STAC analysis"]
    R --> S["Return tile_urls, field statistics, and optional LST status"]
    S --> T["Frontend adds selected tile URL as raster overlay"]
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

    M --> S{"LST available?"}
    Q --> S
    R --> S
    S -->|"Yes"| T["Build full features: NDVI, NDVI diff, LST, rainfall"]
    S -->|"No"| U["Build reduced features: NDVI, NDVI diff, rainfall"]
    V["15-day cumulative rainfall metadata"] --> T
    V --> U
    T --> W["Isolation Forest anomaly detection"]
    U --> W
    W --> X["Apply rule-based guards for micro-polygons"]
    X --> Y["Serialize clipped pixels"]
    Y --> Z["Return polygon, pixels, NDVI summary, LST summary/status, anomaly_model_features, and KPIs"]
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
    O --> P{"TIRS Band 10 found?"}
    P -->|"Yes"| Q["Load B10 and convert to LST Celsius"]
    P -->|"No"| R["Set mean LST to null and lst_status=missing"]
    Q --> S["Extract mean LST over field"]

    H --> T["Create Planetary Computer Data API NDVI tile URL"]
    M --> U["Create analysis response"]
    R --> U
    S --> U
    T --> U
    U --> V["Return tile_urls, NDVI, NDWI, optional LST, risk level, and statistics"]
```

## Raster Layer Toggle Flow

```mermaid
flowchart TD
    A["API or imported JSON payload loaded"] --> B["Normalize legacy tile_url into tile_urls.ndvi"]
    B --> C["Store payload in rasterState.activePayload"]
    C --> D["Enable buttons with available tile_urls"]
    D --> E["User clicks NDVI, LST, or anomaly"]
    E --> F{"Layer URL available?"}
    F -->|"Yes"| G["Replace Leaflet tile layer without API refetch"]
    F -->|"No"| H["Show unavailable-layer status"]
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

## Dynamic Anomaly Feature Flow

```mermaid
flowchart TD
    A["Sentinel-2 NDVI pipeline succeeds"] --> B{"LST has valid pixels?"}
    B -->|"Yes"| C["Use full Isolation Forest features: NDVI, NDVI diff, LST, rainfall"]
    B -->|"No"| D["Use reduced Isolation Forest features: NDVI, NDVI diff, rainfall"]
    C --> E{"At least 8 valid pixels?"}
    D --> E
    E -->|"Yes"| F["Fit Isolation Forest and predict anomaly flags"]
    E -->|"No"| G["Skip model fit for micro-polygon"]
    F --> H["Apply rule-based anomaly guards"]
    G --> H
    H --> I["Return is_anomaly per pixel and anomaly_model_features"]
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
