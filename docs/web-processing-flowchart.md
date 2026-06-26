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
    G --> H["Frontend converts drawn field to WGS84 bbox"]
    H --> I["POST /api/analyze-field"]
    I --> J["Backend runs STAC satellite analysis"]
    J --> K["Return NDVI, LST, anomaly flags, KPIs, alerts"]
    K --> L["Frontend renders KPI cards, pins, popups, and charts"]

    E --> M["Leaflet raster map loads OpenStreetMap base layer"]
    M --> N["User draws one polygon or rectangle"]
    N --> O["Frontend sends GeoJSON coordinates and date range"]
    O --> P["POST /api/analyze-stress"]
    P --> Q["Backend runs Microsoft Planetary Computer STAC analysis"]
    Q --> R["Return Planetary Computer tile_url and field statistics"]
    R --> S["Frontend adds tile_url as raster overlay"]
```

## Dashboard Analysis Flow

```mermaid
flowchart TD
    A["Request body: bbox and time_range"] --> B["Validate bbox and date range"]
    B --> C{"Valid request?"}
    C -->|"No"| D["Return 422 validation error"]
    C -->|"Yes"| E["Query Planetary Computer STAC"]

    E --> F["Search Sentinel-2 Level-2A"]
    F --> G["Filter cloud cover under 10 percent"]
    G --> H{"Cloud-free imagery found?"}
    H -->|"No"| I["Return user-friendly no imagery error"]
    H -->|"Yes"| J["Load Red B4 and NIR B8 at 10 meter resolution"]

    J --> K["Reproject raster to EPSG:4326 using rioxarray"]
    K --> L["Calculate NDVI = (NIR - Red) / (NIR + Red)"]

    E --> M["Search Landsat 8/9 thermal imagery"]
    M --> N["Load thermal Band 10"]
    N --> O["Convert DN to radiance and LST Celsius"]

    L --> P["Build feature array"]
    O --> P
    Q["15-day cumulative rainfall metadata"] --> P
    P --> R["Isolation Forest anomaly detection"]
    R --> S["Create geospatial JSON matrix"]
    S --> T["Return pixels, NDVI, LST, anomaly flags, and summary KPIs"]
```

## Raster And Planetary Computer Stress Flow

```mermaid
flowchart TD
    A["Request body: GeoJSON polygon, start_date, end_date"] --> B["Validate geometry and dates"]
    B --> C["Convert polygon coordinates to WGS84 bbox"]
    C --> D["Build STAC datetime interval"]

    D --> E["Query Microsoft Planetary Computer STAC"]
    E --> F["Search Sentinel-2 L2A"]
    F --> G["Filter eo:cloud_cover under configured threshold"]
    G --> H{"Sentinel-2 imagery found?"}
    H -->|"No"| I["Return user-friendly no imagery error"]
    H -->|"Yes"| J["Load B03 Green, B04 Red, and B08 NIR with odc.stac"]
    J --> K["Calculate NDVI and NDWI with xarray"]
    K --> L["Extract mean NDVI and NDWI over field"]

    E --> M["Search Landsat 8/9 thermal imagery"]
    M --> N["Load TIRS Band 10 with odc.stac"]
    N --> O["Convert DN to radiance, brightness temperature, emissivity-corrected LST Celsius"]
    O --> P["Extract mean LST over field"]

    H --> Q["Create Planetary Computer Data API NDVI tile URL"]

    L --> AI["Pass features to Local AI Inference Module"]
    P --> AI
    AI --> S["Create analysis response"]
    
    Q --> S
    S --> U["Return tile_url, NDVI, NDWI, LST, risk level, and statistics"]
```

## Local AI Inference Flow

```mermaid
flowchart TD
    A["Planetary Computer features: NDWI, NDVI, LST, rainfall metadata"] --> B["Load crop_recommend_rf.pkl with joblib"]
    B --> C["Random Forest predicts crop type"]
    C --> D["Calculate recommendation probability"]

    E["Historical NDWI sequence"] --> F["Load ndwi_lstm.pt with PyTorch"]
    F --> G["LSTM forecasts next 7 days NDWI"]

    D --> H["Build Pydantic response JSON"]
    G --> H
    H --> I["Return crop recommendation, confidence, NDWI forecast, and source features"]
```

## Frontend Error Flow

```mermaid
flowchart TD
    A["User clicks analyze"] --> B{"Field drawn?"}
    B -->|"No"| C["Show: draw a field boundary first"]
    B -->|"Yes"| D{"Dates selected?"}
    D -->|"No"| E["Show: select a valid date range"]
    D -->|"Yes"| F["Send POST request"]
    F --> G{"API response ok?"}
    G -->|"Yes"| H["Render raster overlay, alerts, charts, and KPIs"]
    G -->|"No"| I["Read API error detail"]
    I --> J["Show friendly message in the UI"]
```

## Endpoint Summary

| Endpoint | Used By | Main Purpose |
| --- | --- | --- |
| `GET /` | Dashboard UI | Main crop health dashboard |
| `GET /raster` | Raster UI | NDVI/LST raster overlay map |
| `POST /api/analyze-field` | Dashboard UI | STAC-based NDVI, LST, anomaly, and KPI processing |
| `POST /api/analyze-stress` | Raster UI | Planetary Computer field stress statistics and tile overlay |
| `GET /api/health` | Scripts and monitoring | API readiness check |
