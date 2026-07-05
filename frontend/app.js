const API_URLS = [window.CROP_API_URL || "/api/analyze-field"];
const MAX_DISPLAY_MARKERS = 60;

const state = {
  bbox: null,
  polygon: null, // [แก้ไขจุดนี้]: เพิ่มตัวแปรสำหรับเก็บโครงสร้าง Polygon ในระบบ
  fieldLayer: null,
  resultPolygonLayer: null,
  alertLayer: null,
  popupCharts: new Map(),
  latestPayload: null,
};

// ==========================================
// 1. UTILITY & HELPER FUNCTIONS
// ==========================================

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function roundMetric(value) {
  return Number(value.toFixed(3));
}

function roundCoord(value) {
  return Number(value.toFixed(6));
}

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function formatNumber(value, digits) {
  const numberValue = toFiniteNumber(value);
  return numberValue === null ? "--" : numberValue.toFixed(digits);
}

function nullableNumber(value) {
  return toFiniteNumber(value);
}

function average(values) {
  const clean = values
    .map(toFiniteNumber)
    .filter((value) => value !== null);
  return clean.length
    ? clean.reduce((sum, value) => sum + value, 0) / clean.length
    : null;
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    const numberValue = toFiniteNumber(value);
    if (numberValue !== null) return numberValue;
  }
  return null;
}

function getLstInfo(payload, alerts = []) {
  const summaryMean = firstFiniteNumber(payload.lst_summary?.mean);
  if (summaryMean !== null) {
    return { value: summaryMean, source: "backend summary" };
  }

  const directValue = firstFiniteNumber(
    payload.mean_lst_celsius,
    payload.lst_celsius,
    payload.mean_lst,
  );
  if (directValue !== null) {
    return { value: directValue, source: "direct response field" };
  }

  const pixelMean = average(
    (payload.pixels ?? [])
      .map((pixel) => pixel.lst_celsius ?? pixel.lstCelsius)
      .filter((value) => value !== null && value !== undefined),
  );
  if (pixelMean !== null) {
    return { value: pixelMean, source: "pixel fallback" };
  }

  const alertMean = average(alerts.map((item) => item.lst_celsius));
  if (alertMean !== null) {
    return { value: alertMean, source: "displayed marker fallback" };
  }

  return {
    value: null,
    source: payload.lst_status || "missing",
    message: payload.lst_error || "No valid LST value was returned by the backend.",
  };
}

function getMeanLst(payload, alerts = []) {
  return getLstInfo(payload, alerts).value;
}

function toDateInputValue(date) {
  return date.toISOString().slice(0, 10);
}

// [แก้ไขจุดนี้]: เพิ่มฟังก์ชันสำหรับแปลงพิกัดของ Leaflet ให้เป็น GeoJSON Polygon
function getPolygonCoords(layer) {
  const latLngs = layer.getLatLngs()[0];

  const coordinates = latLngs.map((latLng) => [
    roundCoord(latLng.lng),
    roundCoord(latLng.lat),
  ]);

  // ปิดวงรูปทรงตามมาตรฐาน GeoJSON
  if (coordinates.length > 0) {
    const firstCoord = coordinates[0];
    const lastCoord = coordinates[coordinates.length - 1];
    if (firstCoord[0] !== lastCoord[0] || firstCoord[1] !== lastCoord[1]) {
      coordinates.push([firstCoord[0], firstCoord[1]]);
    }
  }

  return coordinates;
}

function chartOptions() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        labels: {
          boxWidth: 10,
          color: "#475569",
          font: { size: 11, weight: "bold" },
        },
      },
    },
    scales: {
      x: {
        grid: { display: false },
        ticks: { color: "#64748b", font: { size: 10 } },
      },
      y: {
        grid: { color: "rgba(148, 163, 184, 0.24)" },
        ticks: { color: "#64748b", font: { size: 10 } },
      },
    },
  };
}

function buildNdviSeries(ndvi = 0.62, slope = 0.02) {
  const current = nullableNumber(ndvi) ?? 0.62;
  const diff = nullableNumber(slope) ?? 0.02;
  return [
    current - 0.18,
    current - 0.11,
    current - 0.06,
    current - diff,
    current,
    current + diff * 0.6,
  ].map((value) => roundMetric(clamp(value, 0.05, 0.92)));
}

function buildRainfallSeries(total = 35) {
  const amount = nullableNumber(total) ?? 35;
  return [0.12, 0.18, 0.22, 0.16, 0.2, 0.12].map((share) =>
    Math.round(amount * share),
  );
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

// ==========================================
// 2. INITIALIZATION & ELEMENT MAPPING
// ==========================================

const elements = {
  bboxOutput: document.getElementById("bboxOutput"),
  analyzeBtn: document.getElementById("analyzeBtn"),
  clearFieldBtn: document.getElementById("clearFieldBtn"),
  jsonUpload: document.getElementById("jsonUpload"),
  startDate: document.getElementById("startDate"),
  endDate: document.getElementById("endDate"),
  rainfallInput: document.getElementById("rainfallInput"),
  statusText: document.getElementById("statusText"),
  avgNdvi: document.getElementById("avgNdvi"),
  avgLst: document.getElementById("avgLst"),
  avgLstHint: document.getElementById("avgLstHint"),
  damagePercent: document.getElementById("damagePercent"),
  alertCount: document.getElementById("alertCount"),
  plantingWindow: document.getElementById("plantingWindow"),
  plannerRecommendation: document.getElementById("plannerRecommendation"),
  mobilePanelBtn: document.getElementById("mobilePanelBtn"),
  sidebar: document.querySelector(".sidebar"),
  manualCoordsInput: document.getElementById("manualCoordsInput"),
  plotManualPolygonBtn: document.getElementById("plotManualPolygonBtn"),
};

function setDefaultDates() {
  if (!elements.startDate || !elements.endDate) return;

  const end = new Date();
  end.setDate(end.getDate() - 14);
  const start = new Date(end);
  start.setDate(start.getDate() - 60);

  elements.startDate.value ||= toDateInputValue(start);
  elements.endDate.value ||= toDateInputValue(end);
  elements.startDate.max = toDateInputValue(end);
  elements.endDate.max = toDateInputValue(end);
}

setDefaultDates();

const map = L.map("map", {
  zoomControl: false,
}).setView([15.87, 100.9925], 6);

L.control.zoom({ position: "bottomright" }).addTo(map);

L.tileLayer(
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  {
    maxZoom: 20,
    attribution: "Tiles &copy; Esri",
  },
).addTo(map);

L.tileLayer(
  "https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
  {
    maxZoom: 20,
    pane: "overlayPane",
  },
).addTo(map);

const drawnItems = new L.FeatureGroup();
map.addLayer(drawnItems);
state.alertLayer = L.layerGroup().addTo(map);

const drawControl = new L.Control.Draw({
  position: "topright",
  draw: {
    marker: false,
    circle: false,
    circlemarker: false,
    polyline: false,
    rectangle: {
      shapeOptions: {
        color: "#059669",
        weight: 3,
        fillOpacity: 0.12,
      },
    },
    polygon: {
      allowIntersection: false,
      showArea: true,
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
map.addControl(drawControl);

const soilMoistureChart = new Chart(
  document.getElementById("soilMoistureChart"),
  {
    type: "line",
    data: {
      labels: ["W1", "W2", "W3", "W4", "W5", "W6"],
      datasets: [
        {
          label: "ดัชนีความชื้นดิน",
          data: [],
          borderColor: "#059669",
          backgroundColor: "rgba(5, 150, 105, 0.12)",
          fill: true,
          tension: 0.35,
        },
        {
          label: "ความเครียดจาก LST",
          data: [],
          borderColor: "#f59e0b",
          backgroundColor: "rgba(245, 158, 11, 0.12)",
          fill: true,
          tension: 0.35,
        },
      ],
    },
    options: chartOptions(),
  },
);

// ==========================================
// 3. CORE FUNCTIONS & EVENT HANDLERS
// ==========================================

function setStatus(message, isError = false) {
  if (elements.statusText) {
    elements.statusText.textContent = message;
    elements.statusText.className = `text-sm ${isError ? "text-red-600" : "text-slate-500"}`;
  }
}

// [แก้ไขจุดนี้]: ปรับปรุงฟังก์ชันบันทึกข้อมูลแปลงให้ดึงและแสดงผลเป็นรูป GeoJSON Polygon
function updateBboxFromLayer(layer) {
  const bounds = layer.getBounds();
  state.bbox = [
    roundCoord(bounds.getWest()),
    roundCoord(bounds.getSouth()),
    roundCoord(bounds.getEast()),
    roundCoord(bounds.getNorth()),
  ];

  // บันทึก Object ลงในตัวแปร state.polygon
  state.polygon = {
    type: "Polygon",
    coordinates: [getPolygonCoords(layer)],
  };

  // พ่นหน้าตาโครงสร้าง Polygon ออกทางหน้าจอหน้าเว็บ
  if (elements.bboxOutput) {
    elements.bboxOutput.textContent = JSON.stringify(state.polygon, null, 2);
  }

  map.fitBounds(bounds.pad(0.12));
  setStatus("บันทึกขอบเขตแปลงเป็นรูปแบบ Polygon (GeoJSON) แล้ว");
}

// [แก้ไขจุดนี้]: เพิ่มการสั่งล้างค่าโครงสร้างพิกัด polygon ทิ้ง
function clearField() {
  drawnItems.clearLayers();
  state.alertLayer.clearLayers();
  state.fieldLayer = null;
  state.bbox = null;
  state.polygon = null;
  state.resultPolygonLayer = null;
  if (elements.bboxOutput)
    elements.bboxOutput.textContent = "ยังไม่ได้เลือกแปลง";
  setStatus("ล้างขอบเขตแปลงแล้ว");
}

function makePinIcon(status) {
  return L.divIcon({
    className: "",
    html: `<div class="alert-marker ${status}"></div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 28],
    popupAnchor: [0, -28],
  });
}

function getSelectedTimeRange(startInput, endInput, shouldThrow = true) {
  const startDate = startInput.value;
  const endDate = endInput.value;
  const fallback = "2025-05-01/2025-06-01";

  if (!startDate || !endDate) {
    if (shouldThrow)
      throw new Error("กรุณาเลือกวันที่เริ่มต้นและวันที่สิ้นสุด");
    return fallback;
  }

  if (startDate > endDate) {
    if (shouldThrow)
      throw new Error("วันที่เริ่มต้นต้องมาก่อนหรือเท่ากับวันที่สิ้นสุด");
    return fallback;
  }

  return `${startDate}/${endDate}`;
}

function getPayloadCenter(payload) {
  const bbox = payload.bbox ?? state.bbox;
  if (Array.isArray(bbox) && bbox.length === 4) {
    return [
      (Number(bbox[1]) + Number(bbox[3])) / 2,
      (Number(bbox[0]) + Number(bbox[2])) / 2,
    ];
  }
  return state.fieldLayer ? state.fieldLayer.getBounds().getCenter() : null;
}

function bboxToPolygon(bbox) {
  if (!Array.isArray(bbox) || bbox.length !== 4) return null;
  const [minLon, minLat, maxLon, maxLat] = bbox.map(Number);
  if (![minLon, minLat, maxLon, maxLat].every(Number.isFinite)) return null;

  return {
    type: "Polygon",
    coordinates: [
      [
        [minLon, minLat],
        [maxLon, minLat],
        [maxLon, maxLat],
        [minLon, maxLat],
        [minLon, minLat],
      ],
    ],
  };
}

function getResultPolygon(payload) {
  if (payload.polygon?.type === "Polygon") return payload.polygon;
  if (payload.geometry?.type === "Polygon") return payload.geometry;
  if (Array.isArray(payload.coordinates)) {
    return { type: "Polygon", coordinates: payload.coordinates };
  }
  return bboxToPolygon(payload.bbox ?? state.bbox) ?? state.polygon;
}

function drawResultPolygon(payload) {
  const polygon = getResultPolygon(payload);
  if (!polygon) return null;

  if (state.resultPolygonLayer) {
    state.alertLayer.removeLayer(state.resultPolygonLayer);
    state.resultPolygonLayer = null;
  }

  state.resultPolygonLayer = L.geoJSON(polygon, {
    style: {
      color: "#2563eb",
      weight: 3,
      fillColor: "#38bdf8",
      fillOpacity: 0.16,
      dashArray: "8 5",
    },
  }).addTo(state.alertLayer);

  state.resultPolygonLayer.bindPopup(`
    <div>
      <p class="popup-title text-blue-700">Result polygon</p>
      <div class="popup-grid">
        <div class="popup-metric">NDVI<strong>${formatNumber(payload.ndvi_summary?.mean, 2)}</strong></div>
        <div class="popup-metric">LST<strong>${formatNumber(getMeanLst(payload), 1)} °C</strong></div>
        <div class="popup-metric">Pixels<strong>${payload.ndvi_summary?.valid_pixel_count ?? "--"}</strong></div>
        <div class="popup-metric">Anomaly<strong>${payload.anomaly_count ?? 0}</strong></div>
      </div>
    </div>
  `);

  if (elements.bboxOutput) {
    elements.bboxOutput.textContent = JSON.stringify(polygon, null, 2);
  }

  return state.resultPolygonLayer;
}

// ประมวลผลและเตรียมข้อมูลพิกเซลแจ้งเตือน
function normalizeAlert(raw) {
  const lat = Number(raw.lat ?? raw.latitude);
  const lon = Number(raw.lon ?? raw.lng ?? raw.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  return {
    lat,
    lon,
    ndvi: nullableNumber(raw.ndvi),
    ndvi_diff: nullableNumber(raw.ndvi_diff ?? raw.ndviDiff),
    lst_celsius: nullableNumber(raw.lst_celsius ?? raw.lstCelsius),
    rainfall_15d_mm:
      nullableNumber(raw.rainfall_15d_mm ?? raw.rainfall15dMm) ?? 0,
    is_anomaly: Number(raw.is_anomaly ?? raw.isAnomaly ?? 0),
    ndvi_series: raw.ndvi_series ?? buildNdviSeries(raw.ndvi, raw.ndvi_diff),
    rainfall_series:
      raw.rainfall_series ?? buildRainfallSeries(raw.rainfall_15d_mm),
  };
}

function normalizeAlerts(payload) {
  if (Array.isArray(payload.alerts)) {
    return payload.alerts.map(normalizeAlert).filter(Boolean);
  }

  if (Array.isArray(payload.pixels)) {
    const stride = Math.max(
      1,
      Math.floor(payload.pixels.length / MAX_DISPLAY_MARKERS),
    );
    return payload.pixels
      .filter((pixel, index) => pixel.is_anomaly === 1 || index % stride === 0)
      .map(normalizeAlert)
      .filter(Boolean);
  }

  return [];
}

function updateKpis(payload, alerts) {
  const meanNdvi =
    payload.ndvi_summary?.mean ?? average(alerts.map((item) => item.ndvi));
  const lstInfo = getLstInfo(payload, alerts);
  const meanLst = lstInfo.value;
  const anomalyCount = alerts.filter((item) => item.is_anomaly === 1).length;
  const damage = alerts.length ? (anomalyCount / alerts.length) * 100 : 0;

  if (elements.avgNdvi)
    elements.avgNdvi.textContent = formatNumber(meanNdvi, 2);
  if (elements.avgLst)
    elements.avgLst.textContent = `${formatNumber(meanLst, 1)} °C`;
  if (elements.avgLstHint) {
    elements.avgLstHint.textContent =
      meanLst === null
        ? `ไม่มีข้อมูล LST: ${lstInfo.message}`
        : `LST จาก ${lstInfo.source}`;
  }
  if (elements.damagePercent)
    elements.damagePercent.textContent = `${Math.round(damage)}%`;
  if (elements.alertCount)
    elements.alertCount.textContent = String(alerts.length);
}

function updatePlanner(payload, alerts) {
  const meanLst = getMeanLst(payload, alerts);
  const meanNdvi =
    payload.ndvi_summary?.mean ?? average(alerts.map((item) => item.ndvi));
  const stress = Number.isFinite(meanLst)
    ? clamp((meanLst - 24) / 16, 0, 1)
    : 0.4;
  const moisture = clamp(
    0.72 - stress * 0.38 + (meanNdvi || 0.5) * 0.12,
    0.1,
    0.95,
  );
  const moistureSeries = [
    0.52,
    0.58,
    moisture,
    moisture + 0.05,
    moisture - 0.03,
    moisture - 0.08,
  ].map((value) => roundMetric(clamp(value, 0.05, 0.95)));
  const stressSeries = moistureSeries.map((value) =>
    roundMetric(clamp(1 - value, 0.05, 0.95)),
  );
  const bestIndex = moistureSeries.indexOf(Math.max(...moistureSeries));

  soilMoistureChart.data.datasets[0].data = moistureSeries;
  soilMoistureChart.data.datasets[1].data = stressSeries;
  soilMoistureChart.update();

  if (elements.plantingWindow)
    elements.plantingWindow.textContent = `สัปดาห์ที่ ${bestIndex + 1}`;
  if (elements.plannerRecommendation) {
    elements.plannerRecommendation.textContent =
      meanLst > 33
        ? "ควรเลื่อนการปลูกจนกว่าอุณหภูมิบริเวณทรงพุ่มจะลดลงและฝนช่วยเติมความชื้นผิวดิน"
        : `ช่วงปลูกที่แนะนำคือสัปดาห์ที่ ${bestIndex + 1} เมื่อแบบจำลองคาดว่าความชื้นสูงสุดและความเครียดจาก LST ต่ำสุด`;
  }
}

function buildPopupHtml(alert, index) {
  const status = alert.is_anomaly
    ? "เสี่ยงพืชเครียดหรือโรครุนแรง"
    : "พื้นที่ปกติหรือคงที่";
  const statusClass = alert.is_anomaly ? "text-red-600" : "text-emerald-700";

  return `
    <div>
      <p class="popup-title ${statusClass}">${status}</p>
      <div class="popup-grid">
        <div class="popup-metric">NDVI<strong>${formatNumber(alert.ndvi, 2)}</strong></div>
        <div class="popup-metric">LST<strong>${formatNumber(alert.lst_celsius, 1)} °C</strong></div>
        <div class="popup-metric">ความชัน NDVI<strong>${formatNumber(alert.ndvi_diff, 2)}</strong></div>
        <div class="popup-metric">ฝน 15 วัน<strong>${formatNumber(alert.rainfall_15d_mm, 0)} mm</strong></div>
      </div>
      <canvas id="ndviChart-${index}" height="145"></canvas>
      <canvas id="rainChart-${index}" height="120" class="mt-3"></canvas>
    </div>
  `;
}

function mountPopupCharts(alert, index) {
  const ndviCanvas = document.getElementById(`ndviChart-${index}`);
  const rainCanvas = document.getElementById(`rainChart-${index}`);
  if (!ndviCanvas || !rainCanvas || state.popupCharts.has(index)) return;

  const labels = ["มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค."];
  const ndviChart = new Chart(ndviCanvas, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "แนวโน้ม NDVI",
          data: alert.ndvi_series,
          borderColor: alert.is_anomaly ? "#ef4444" : "#059669",
          backgroundColor: alert.is_anomaly
            ? "rgba(239,68,68,0.12)"
            : "rgba(5,150,105,0.12)",
          fill: true,
          tension: 0.35,
        },
      ],
    },
    options: chartOptions(),
  });

  const rainChart = new Chart(rainCanvas, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "ฝนสะสม",
          data: alert.rainfall_series,
          backgroundColor: "#38bdf8",
          borderRadius: 5,
        },
      ],
    },
    options: chartOptions(),
  });

  state.popupCharts.set(index, {
    destroy() {
      ndviChart.destroy();
      rainChart.destroy();
    },
  });
}

function addSummaryMarker(payload) {
  const center = getPayloadCenter(payload);
  if (!center) return;

  const ndvi = payload.ndvi_summary?.mean ?? payload.mean_ndvi;
  const lst = getMeanLst(payload);
  const marker = L.marker(center, {
    icon: makePinIcon("healthy"),
    title: "Summary result",
  }).addTo(state.alertLayer);

  marker.bindPopup(`
    <div>
      <p class="popup-title text-emerald-700">ผลสรุปจากการวิเคราะห์</p>
      <div class="popup-grid">
        <div class="popup-metric">NDVI<strong>${formatNumber(ndvi, 2)}</strong></div>
        <div class="popup-metric">LST<strong>${formatNumber(lst, 1)} °C</strong></div>
        <div class="popup-metric">Pixels<strong>${payload.ndvi_summary?.valid_pixel_count ?? "--"}</strong></div>
        <div class="popup-metric">Anomaly<strong>${payload.anomaly_count ?? 0}</strong></div>
      </div>
    </div>
  `);
  map.setView(center, Math.max(map.getZoom(), 13));
}

function renderAnalysisPayload(payload) {
  const alerts = normalizeAlerts(payload);
  state.alertLayer.clearLayers();
  state.resultPolygonLayer = null;
  state.popupCharts.forEach((chart) => chart.destroy());
  state.popupCharts.clear();
  state.latestPayload = payload;
  console.debug("avgLst debug", {
    lst_summary: payload.lst_summary,
    lst_status: payload.lst_status,
    lst_error: payload.lst_error,
    landsat_scene_ids: payload.landsat_scene_ids,
    derived: getLstInfo(payload, alerts),
  });
  drawResultPolygon(payload);

  alerts.forEach((alert, index) => {
    const marker = L.marker([alert.lat, alert.lon], {
      icon: makePinIcon(alert.is_anomaly ? "critical" : "healthy"),
      title: alert.is_anomaly ? "เสี่ยงพืชเครียดรุนแรง" : "พื้นที่พืชปกติ",
    }).addTo(state.alertLayer);

    marker.bindPopup(buildPopupHtml(alert, index), {
      maxWidth: 360,
      className: "crop-alert-popup",
    });

    marker.on("popupopen", () => mountPopupCharts(alert, index));
  });

  if (state.alertLayer.getLayers().length) {
    const group = L.featureGroup(state.alertLayer.getLayers());
    map.fitBounds(group.getBounds().pad(0.18));
  } else {
    addSummaryMarker(payload);
  }

  updateKpis(payload, alerts);
  updatePlanner(payload, alerts);
  return alerts.length;
}

async function postAnalysis(body) {
  let lastError = null;

  for (const url of API_URLS) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));

    if (response.ok) return payload;
    const detail = formatApiDetail(payload.detail || payload.message || "");
    const isRouteMissing =
      response.status === 404 && (!detail || detail === "Not Found");

    if (!isRouteMissing) {
      if (response.status === 422) {
        throw new Error(
          detail
            ? `ไม่สามารถวิเคราะห์ได้: ${detail}`
            : "ไม่สามารถวิเคราะห์ได้ กรุณาตรวจสอบแปลง วันที่ และเมฆปกคลุม",
        );
      }
      throw new Error(
        detail || `การวิเคราะห์จากแบ็กเอนด์ล้มเหลวด้วย HTTP ${response.status}`,
      );
    }
    lastError = `ไม่พบ Route ${url} (404)`;
  }

  throw new Error(`${lastError} กรุณารีสตาร์ต FastAPI เพื่อโหลด routes ล่าสุด`);
}

// [แก้ไขจุดนี้]: เปลี่ยนเงื่อนไขการตรวจสอบมาที่ state.polygon และเปลี่ยนส่งค่า payload เป็น polygon แทน bbox
async function analyzeSelectedField() {
  if (!state.polygon) {
    setStatus("กรุณาวาดขอบเขตแปลงก่อนเริ่มวิเคราะห์", true);
    return;
  }

  elements.analyzeBtn.disabled = true;
  elements.analyzeBtn.textContent = "กำลังวิเคราะห์...";
  setStatus(`กำลังส่งข้อมูล Polygon ไปยัง API วิเคราะห์ที่ ${API_URLS[0]}...`);

  try {
    const timeRange = getSelectedTimeRange(
      elements.startDate,
      elements.endDate,
    );
    const payload = await postAnalysis({
      bbox: state.bbox,
      polygon: state.polygon,
      time_range: timeRange,
      start_date: elements.startDate.value,
      end_date: elements.endDate.value,
      rainfall_15d_mm: Number(elements.rainfallInput.value || 0),
    });

    const renderedCount = renderAnalysisPayload(payload);
    setStatus(
      renderedCount
        ? `วิเคราะห์เสร็จแล้ว แสดงผล ${renderedCount} จุดบนแผนที่`
        : "วิเคราะห์เสร็จแล้ว แต่ไม่มี pixel ที่แสดงเป็นหมุดได้ ระบบแสดงเฉพาะค่า summary",
    );
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    elements.analyzeBtn.disabled = false;
    elements.analyzeBtn.textContent = "วิเคราะห์แปลง";
  }
}

function handleJsonUpload(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    try {
      renderAnalysisPayload(JSON.parse(reader.result));
      setStatus(`นำเข้า ${file.name} และแสดงหมุดแจ้งเตือนแล้ว`);
    } catch (error) {
      setStatus(`ไฟล์ JSON ไม่ถูกต้อง: ${error.message}`, true);
    }
  };
  reader.readAsText(file);
  event.target.value = "";
}

function processManualCoordinates() {
  const lat = Number(elements.manualLat.value);
  const lon = Number(elements.manualLon.value);

  // ตรวจสอบความถูกต้องของพิกัดความต่าง
  if (
    !elements.manualLat.value ||
    !elements.manualLon.value ||
    isNaN(lat) ||
    isNaN(lon)
  ) {
    setStatus(
      "กรุณากรอกพิกัด Latitude และ Longitude ให้ครบถ้วนและถูกต้อง",
      true,
    );
    return;
  }
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    setStatus("ค่าพิกัดไม่อยู่ในขอบเขตที่ถูกต้องของโลก", true);
    return;
  }

  // ล้างภาพแปลงเก่าบนแผนที่ออกก่อน
  drawnItems.clearLayers();

  // กำหนดขนาดบล็อกพื้นที่รอบจุดพิกัด (Offset ประมาณ 500 เมตร เพื่อสร้าง Polygon ปิด)
  const offset = 0.0025;
  const minLat = roundCoord(lat - offset);
  const maxLat = roundCoord(lat + offset);
  const minLon = roundCoord(lon - offset);
  const maxLon = roundCoord(lon + offset);

  // 1. จำลองสร้าง Layer รูปสี่เหลี่ยมบนแผนที่ Leaflet
  const bounds = [
    [minLat, minLon],
    [maxLat, maxLon],
  ];
  state.fieldLayer = L.rectangle(bounds, {
    color: "#059669",
    weight: 3,
    fillOpacity: 0.12,
  });
  drawnItems.addLayer(state.fieldLayer);

  // 2. บันทึกค่าลงในตัวแปรระบบหลัก (state)
  state.bbox = [minLon, minLat, maxLon, maxLat];
  state.polygon = {
    type: "Polygon",
    coordinates: [
      [
        [minLon, minLat],
        [maxLon, minLat],
        [maxLon, maxLat],
        [minLon, maxLat],
        [minLon, minLat], // จุดปิดวง
      ],
    ],
  };

  // 3. แสดงผลโครงสร้างข้อมูลบนหน้าจอและขยับแผนที่ไปยังพิกัดนั้น
  if (elements.bboxOutput) {
    elements.bboxOutput.textContent = JSON.stringify(state.polygon, null, 2);
  }
  map.fitBounds(state.fieldLayer.getBounds().pad(0.2));
  setStatus(
    `สร้างพื้นที่วิเคราะห์รอบพิกัด [${lat.toFixed(4)}, ${lon.toFixed(4)}] เรียบร้อยแล้ว`,
  );
}

function processManualPolygon() {
  const rawText = elements.manualCoordsInput.value.trim();
  if (!rawText) {
    setStatus("กรุณากรอกชุดพิกัดก่อนเริ่มประมวลผล", true);
    return;
  }

  const lines = rawText.split(/\r?\n/);
  const leafletCoords = [];
  const geoJsonCoords = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const parts = line.split(/[\s,]+/);
    const lat = Number(parts[0]);
    const lon = Number(parts[1]);

    if (
      isNaN(lat) ||
      isNaN(lon) ||
      lat < -90 ||
      lat > 90 ||
      lon < -180 ||
      lon > 180
    ) {
      setStatus(
        `ข้อผิดพลาดในบรรทัดที่ ${i + 1}: พิกัดไม่ถูกต้อง ("${line}")`,
        true,
      );
      return;
    }

    leafletCoords.push([lat, lon]);
    geoJsonCoords.push([roundCoord(lon), roundCoord(lat)]);
  }

  if (leafletCoords.length < 3) {
    setStatus(
      "รูปหลายเหลี่ยม (Polygon) ต้องประกอบด้วยพิกัดอย่างน้อย 3 จุดขึ้นไป",
      true,
    );
    return;
  }

  drawnItems.clearLayers();

  state.fieldLayer = L.polygon(leafletCoords, {
    color: "#059669",
    weight: 3,
    fillOpacity: 0.12,
  });
  drawnItems.addLayer(state.fieldLayer);

  const firstPoint = geoJsonCoords[0];
  const lastPoint = geoJsonCoords[geoJsonCoords.length - 1];
  if (firstPoint[0] !== lastPoint[0] || firstPoint[1] !== lastPoint[1]) {
    geoJsonCoords.push([firstPoint[0], firstPoint[1]]);
  }

  const bounds = state.fieldLayer.getBounds();
  state.bbox = [
    roundCoord(bounds.getWest()),
    roundCoord(bounds.getSouth()),
    roundCoord(bounds.getEast()),
    roundCoord(bounds.getNorth()),
  ];

  state.polygon = {
    type: "Polygon",
    coordinates: [geoJsonCoords],
  };

  if (elements.bboxOutput) {
    elements.bboxOutput.textContent = JSON.stringify(state.polygon, null, 2);
  }
  map.fitBounds(bounds.pad(0.15));
  setStatus(
    `สร้างพื้นที่วิเคราะห์รูปหลายเหลี่ยมจำนวน ${leafletCoords.length} จุดเรียบร้อยแล้ว`,
  );
}

// ==========================================
// 4. MAP EVENTS & LISTENERS REGISTER
// ==========================================

map.on(L.Draw.Event.CREATED, (event) => {
  drawnItems.clearLayers();
  state.fieldLayer = event.layer;
  drawnItems.addLayer(state.fieldLayer);
  updateBboxFromLayer(state.fieldLayer);
});

map.on(L.Draw.Event.EDITED, (event) => {
  event.layers.eachLayer((layer) => updateBboxFromLayer(layer));
});

map.on(L.Draw.Event.DELETED, clearField);

if (elements.clearFieldBtn)
  elements.clearFieldBtn.addEventListener("click", clearField);
if (elements.analyzeBtn)
  elements.analyzeBtn.addEventListener("click", analyzeSelectedField);
if (elements.jsonUpload)
  elements.jsonUpload.addEventListener("change", handleJsonUpload);

if (elements.mobilePanelBtn && elements.sidebar) {
  elements.mobilePanelBtn.addEventListener("click", () => {
    elements.sidebar.classList.toggle("open");
    setTimeout(() => map.invalidateSize(), 260);
  });
}

if (elements.plotManualBtn) {
  elements.plotManualBtn.addEventListener("click", processManualCoordinates);
}

if (elements.plotManualPolygonBtn) {
  elements.plotManualPolygonBtn.addEventListener("click", processManualPolygon);
}

window.addEventListener("resize", () => map.invalidateSize());
