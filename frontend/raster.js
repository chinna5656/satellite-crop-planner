const ANALYZE_STRESS_URL = window.CROP_STRESS_API_URL || "/api/analyze-stress";
const THAILAND_CENTER = [15.87, 100.9925];
const THAILAND_ZOOM = 6;

const token = localStorage.getItem('access_token');

if (!token) {
    alert('กรุณาเข้าสู่ระบบก่อนใช้งาน!');
    window.location.href = '/login'; // เด้งกลับไปหน้าล็อกอิน
}

const rasterState = {
  drawnLayer: null,
  polygon: null,
  rasterTileLayer: null,
  activePayload: null,
  activeLayer: "ndvi",
};

const layerLabels = {
  ndvi: "NDVI",
  lst: "LST",
  anomaly: "Anomaly",
};

const rasterMap = L.map("rasterMap", {
  zoomControl: false,
}).setView(THAILAND_CENTER, THAILAND_ZOOM);

L.control.zoom({ position: "bottomright" }).addTo(rasterMap);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(rasterMap);

const drawnItems = new L.FeatureGroup();
rasterMap.addLayer(drawnItems);

const drawControl = new L.Control.Draw({
  position: "topright",
  draw: {
    marker: false,
    circle: false,
    circlemarker: false,
    polyline: false,
    polygon: {
      allowIntersection: false,
      showArea: true,
      shapeOptions: {
        color: "#059669",
        weight: 3,
        fillOpacity: 0.12,
      },
    },
    rectangle: {
      shapeOptions: {
        color: "#059669",
        weight: 3,
        fillOpacity: 0.12,
      },
    },
  },
  edit: {
    featureGroup: drawnItems,
    remove: true,
  },
});
rasterMap.addControl(drawControl);

const rasterElements = {
  bbox: document.getElementById("rasterBbox"),
  analyze: document.getElementById("rasterAnalyzeBtn"),
  manualCoords: document.getElementById("rasterManualCoordsInput"),
  plotManualPolygon: document.getElementById("rasterPlotManualPolygonBtn"),
  startDate: document.getElementById("rasterStartDate"),
  endDate: document.getElementById("rasterEndDate"),
  status: document.getElementById("rasterStatus"),
  subtitle: document.getElementById("rasterSubtitle"),
  sidebar: document.querySelector(".sidebar"),
  mobilePanel: document.getElementById("rasterMobilePanelBtn"),
  ndvi: document.getElementById("rasterNdvi"),
  lst: document.getElementById("rasterLst"),
  risk: document.getElementById("rasterRisk"),
  cells: document.getElementById("rasterCells"),
};

rasterMap.on(L.Draw.Event.CREATED, (event) => {
  drawnItems.clearLayers();
  rasterState.drawnLayer = event.layer;
  drawnItems.addLayer(rasterState.drawnLayer);

  const geojson = rasterState.drawnLayer.toGeoJSON();
  setActivePolygon(geojson.geometry);
  rasterMap.fitBounds(rasterState.drawnLayer.getBounds().pad(0.12));
  setRasterStatus("Field saved. Click analyze to request raster layers.");
});

rasterMap.on(L.Draw.Event.EDITED, (event) => {
  event.layers.eachLayer((layer) => {
    rasterState.drawnLayer = layer;
    const geojson = layer.toGeoJSON();
    setActivePolygon(geojson.geometry);
  });
});

rasterMap.on(L.Draw.Event.DELETED, () => {
  rasterState.drawnLayer = null;
  rasterState.polygon = null;
  rasterState.activePayload = null;
  setText(rasterElements.bbox, "No field selected");
  removeRasterOverlay();
  updateLayerButtons();
  setRasterStatus("Field cleared.");
});

rasterElements.analyze?.addEventListener("click", analyzeStress);
rasterElements.plotManualPolygon?.addEventListener("click", plotManualPolygon);
rasterElements.mobilePanel?.addEventListener("click", () => {
  rasterElements.sidebar.classList.toggle("open");
  setTimeout(() => rasterMap.invalidateSize(), 260);
});

document.querySelectorAll(".layer-toggle").forEach((button) => {
  button.disabled = false;
  button.addEventListener("click", () => selectRasterLayer(button.dataset.layer));
});

window.addEventListener("resize", () => rasterMap.invalidateSize());
setRasterStatus("Draw a polygon or enter coordinates, then analyze live data.");
updateLayerButtons();

async function analyzeStress() {
  if (!rasterState.polygon) {
    setRasterStatus("Please draw a polygon, rectangle, or plot manual coordinates before analysis.", true);
    return;
  }

  let dates;
  try {
    dates = getSelectedDates();
  } catch (error) {
    setRasterStatus(error.message, true);
    return;
  }

  const requestBody = {
    geometry: rasterState.polygon,
    coordinates: rasterState.polygon.coordinates,
    start_date: dates.startDate,
    end_date: dates.endDate,
  };

  rasterElements.analyze.disabled = true;
  rasterElements.analyze.textContent = "Analyzing...";
  setRasterStatus("Requesting raster layers from the backend...");

  try {
    const response = await fetch(ANALYZE_STRESS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      },
      body: JSON.stringify(requestBody),
    });

    if (response.status === 401) {
        alert("เซสชันหมดอายุ หรือไม่มีสิทธิ์เข้าถึง กรุณาเข้าสู่ระบบใหม่");
        localStorage.removeItem("access_token");
        window.location.href = "/login";
        return;
    }

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(formatApiDetail(payload.detail || payload.message || `Analysis failed with HTTP ${response.status}`));
    }

    renderRasterPayload(payload);
    setRasterStatus(`Loaded raster layers from ${payload.source || "Microsoft Planetary Computer"}.`);
  } catch (error) {
    removeRasterOverlay();
    setRasterStatus(`${error.message}. Check /api/analyze-stress and the returned tile_urls.`, true);
  } finally {
    rasterElements.analyze.disabled = false;
    rasterElements.analyze.textContent = "Analyze and show raster";
  }
}

function renderRasterPayload(payload) {
  const normalizedPayload = normalizeRasterPayload(payload);
  const hasAnyTile = Object.keys(normalizedPayload.tile_urls).length > 0;
  if (!hasAnyTile) {
    throw new Error("Result has no tile_url or tile_urls.");
  }

  rasterState.activePayload = normalizedPayload;
  updateLayerToggleAvailability(normalizedPayload);

  const preferredLayer = getLayerTileUrl(normalizedPayload, rasterState.activeLayer)
    ? rasterState.activeLayer
    : getFirstAvailableLayer(normalizedPayload);
  selectRasterLayer(preferredLayer, false);
  updateSummaryCards(normalizedPayload);
}

function normalizeRasterPayload(payload) {
  const tileUrls = { ...(payload.tile_urls || {}) };
  if (payload.tile_url && !tileUrls.ndvi) {
    tileUrls.ndvi = payload.tile_url;
  }
  return {
    ...payload,
    tile_urls: tileUrls,
    tile_url: payload.tile_url || tileUrls.ndvi || "",
  };
}

function selectRasterLayer(layer, shouldUpdateStatus = true) {
  const payload = rasterState.activePayload;
  const selectedLayer = layer || "ndvi";

  if (!payload) {
    rasterState.activeLayer = selectedLayer;
    updateLayerButtons();
    if (shouldUpdateStatus) {
      setRasterStatus("No raster payload loaded yet. Analyze live data first.");
    }
    return;
  }

  const tileUrl = getLayerTileUrl(payload, selectedLayer);
  if (!tileUrl) {
    setRasterStatus(`${layerLabels[selectedLayer] || selectedLayer} layer is unavailable for this result.`, true);
    updateLayerButtons();
    return;
  }

  rasterState.activeLayer = selectedLayer;
  addRasterTileOverlay(tileUrl, selectedLayer);
  updateLayerButtons();
  if (shouldUpdateStatus) {
    setRasterStatus(`Showing ${layerLabels[selectedLayer] || selectedLayer} layer.`);
  }
}

function getLayerTileUrl(payload, layer) {
  return payload.tile_urls?.[layer] || (layer === "ndvi" ? payload.tile_url : null);
}

function getFirstAvailableLayer(payload) {
  return ["ndvi", "lst", "anomaly"].find((layer) => getLayerTileUrl(payload, layer)) || "ndvi";
}

function updateLayerToggleAvailability(payload) {
  document.querySelectorAll(".layer-toggle").forEach((button) => {
    const layer = button.dataset.layer;
    const hasTile = Boolean(getLayerTileUrl(payload, layer));
    button.disabled = !hasTile;
    button.title = hasTile
      ? `${layerLabels[layer] || layer} layer`
      : `${layerLabels[layer] || layer} layer unavailable for this result`;
  });
}

function updateLayerButtons() {
  document.querySelectorAll(".layer-toggle").forEach((button) => {
    button.classList.toggle("active", button.dataset.layer === rasterState.activeLayer);
  });
}

function addRasterTileOverlay(tileUrl, layer = rasterState.activeLayer) {
  removeRasterOverlay();
  rasterState.rasterTileLayer = L.tileLayer(tileUrl, {
    opacity: getOpacity(),
    maxZoom: 19,
    zIndex: 450,
    crossOrigin: true,
    attribution: "Microsoft Planetary Computer",
  });

  rasterState.rasterTileLayer.on("tileerror", () => {
    setRasterStatus(
      `Could not load ${layerLabels[layer] || layer} tiles. Summary values are still available.`,
      true,
    );
  });

  rasterState.rasterTileLayer.on("load", () => {
    setRasterStatus(`Showing ${layerLabels[layer] || layer} tile overlay.`);
  });

  rasterState.rasterTileLayer.addTo(rasterMap);

  if (rasterState.drawnLayer) {
    rasterMap.fitBounds(rasterState.drawnLayer.getBounds().pad(0.12));
  }
  if (rasterElements.subtitle) {
    rasterElements.subtitle.textContent = `${layerLabels[layer] || layer} layer from raster analysis`;
  }
}

function removeRasterOverlay() {
  if (rasterState.rasterTileLayer) {
    rasterMap.removeLayer(rasterState.rasterTileLayer);
    rasterState.rasterTileLayer = null;
  }
}

function updateSummaryCards(payload) {
  setText(rasterElements.ndvi, formatMaybeNumber(payload.mean_ndvi ?? payload.ndvi, 2));
  setText(
    rasterElements.lst,
    formatMaybeNumber(payload.mean_lst_celsius ?? payload.lst_celsius, 1, " C"),
  );
  setText(rasterElements.risk, payload.risk_level ?? payload.stress_class ?? "--");
  setText(
    rasterElements.cells,
    formatCellCount(payload.valid_pixel_count ?? payload.pixel_count ?? payload.tile_count),
  );
}

function getSelectedDates() {
  const startDate = rasterElements.startDate?.value;
  const endDate = rasterElements.endDate?.value;

  if (!startDate || !endDate) {
    throw new Error("Please choose start and end dates.");
  }
  if (startDate > endDate) {
    throw new Error("Start date must be before or equal to end date.");
  }

  return { startDate, endDate };
}

function plotManualPolygon() {
  let latLngs;
  try {
    latLngs = parseManualCoordinateLines(rasterElements.manualCoords?.value || "");
  } catch (error) {
    setRasterStatus(error.message, true);
    return;
  }

  drawnItems.clearLayers();
  removeRasterOverlay();
  rasterState.activePayload = null;
  rasterState.drawnLayer = L.polygon(latLngs, {
    color: "#059669",
    weight: 3,
    fillOpacity: 0.12,
  });
  drawnItems.addLayer(rasterState.drawnLayer);

  const coordinates = latLngs.map(([lat, lon]) => [lon, lat]);
  if (!sameCoordinate(coordinates[0], coordinates[coordinates.length - 1])) {
    coordinates.push([...coordinates[0]]);
  }
  setActivePolygon({
    type: "Polygon",
    coordinates: [coordinates],
  });

  rasterMap.fitBounds(rasterState.drawnLayer.getBounds().pad(0.12));
  updateLayerButtons();
  setRasterStatus("Manual polygon ready. Click analyze to request live raster layers.");
}

function parseManualCoordinateLines(rawText) {
  const lines = rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 3) {
    throw new Error("Enter at least three latitude, longitude coordinate lines.");
  }

  const latLngs = lines.map((line, index) => {
    const parts = line.split(/[,\s]+/).filter(Boolean);
    if (parts.length !== 2) {
      throw new Error(`Line ${index + 1} must contain latitude and longitude.`);
    }

    const lat = Number(parts[0]);
    const lon = Number(parts[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      throw new Error(`Line ${index + 1} contains non-numeric coordinates.`);
    }
    if (lat < -90 || lat > 90) {
      throw new Error(`Line ${index + 1} latitude must be between -90 and 90.`);
    }
    if (lon < -180 || lon > 180) {
      throw new Error(`Line ${index + 1} longitude must be between -180 and 180.`);
    }
    return [lat, lon];
  });

  const uniqueVertices = new Set(latLngs.map(([lat, lon]) => `${lat},${lon}`));
  if (uniqueVertices.size < 3) {
    throw new Error("Manual polygon must contain at least three unique vertices.");
  }

  return latLngs;
}

function setActivePolygon(geometry) {
  if (!geometry || geometry.type !== "Polygon" || !Array.isArray(geometry.coordinates)) {
    throw new Error("Selected geometry must be a GeoJSON Polygon.");
  }
  rasterState.polygon = geometry;
  setText(rasterElements.bbox, JSON.stringify(geometry.coordinates, null, 2));
}

function sameCoordinate(first, second) {
  return Boolean(first && second && first[0] === second[0] && first[1] === second[1]);
}

function getOpacity() {
  const slider = document.getElementById("opacitySlider");
  const value = Number(slider?.value ?? 72);
  return Number.isFinite(value) ? value / 100 : 0.72;
}

document.getElementById("opacitySlider")?.addEventListener("input", () => {
  if (rasterState.rasterTileLayer) {
    rasterState.rasterTileLayer.setOpacity(getOpacity());
  }
});

function setRasterStatus(message, isError = false) {
  if (!rasterElements.status) return;
  rasterElements.status.textContent = message;
  rasterElements.status.className = `text-sm ${isError ? "text-red-600" : "text-slate-500"}`;
}

function setText(element, value) {
  if (element) element.textContent = String(value);
}

function formatMaybeNumber(value, digits, suffix = "") {
  if (value === null || value === undefined || value === "") return "--";
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return "--";
  return `${numberValue.toFixed(digits)}${suffix}`;
}

function formatCellCount(value) {
  if (value === null || value === undefined || value === "") return "--";
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return String(value);
  return `${numberValue.toLocaleString()} pixels`;
}

function formatApiDetail(detail) {
  if (Array.isArray(detail)) {
    return detail.map((item) => item.msg || JSON.stringify(item)).join("; ");
  }
  if (detail && typeof detail === "object") {
    return JSON.stringify(detail);
  }
  return String(detail || "");
}
