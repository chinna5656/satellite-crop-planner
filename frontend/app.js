const API_URLS = [window.CROP_API_URL || "/api/analyze-field", "/analyze-field"];

const state = {
  bbox: null,
  fieldLayer: null,
  alertLayer: null,
  popupCharts: new Map(),
};

const map = L.map("map", {
  zoomControl: false,
}).setView([15.8700, 100.9925], 6);

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

const elements = {
  bboxOutput: document.getElementById("bboxOutput"),
  analyzeBtn: document.getElementById("analyzeBtn"),
  clearFieldBtn: document.getElementById("clearFieldBtn"),
  loadSampleBtn: document.getElementById("loadSampleBtn"),
  jsonUpload: document.getElementById("jsonUpload"),
  startDate: document.getElementById("startDate"),
  endDate: document.getElementById("endDate"),
  rainfallInput: document.getElementById("rainfallInput"),
  statusText: document.getElementById("statusText"),
  avgNdvi: document.getElementById("avgNdvi"),
  avgLst: document.getElementById("avgLst"),
  damagePercent: document.getElementById("damagePercent"),
  alertCount: document.getElementById("alertCount"),
  plantingWindow: document.getElementById("plantingWindow"),
  plannerRecommendation: document.getElementById("plannerRecommendation"),
  mobilePanelBtn: document.getElementById("mobilePanelBtn"),
  sidebar: document.querySelector(".sidebar"),
};

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

elements.clearFieldBtn.addEventListener("click", clearField);
elements.loadSampleBtn.addEventListener("click", () => renderAnalysisPayload(buildDemoPayload()));
elements.analyzeBtn.addEventListener("click", analyzeSelectedField);
elements.jsonUpload.addEventListener("change", handleJsonUpload);
elements.mobilePanelBtn.addEventListener("click", () => {
  elements.sidebar.classList.toggle("open");
  setTimeout(() => map.invalidateSize(), 260);
});

window.addEventListener("resize", () => map.invalidateSize());

const soilMoistureChart = new Chart(document.getElementById("soilMoistureChart"), {
  type: "line",
  data: {
    labels: ["W1", "W2", "W3", "W4", "W5", "W6"],
    datasets: [
      {
        label: "ดัชนีความชื้นดิน",
        data: [0.52, 0.57, 0.68, 0.73, 0.69, 0.62],
        borderColor: "#059669",
        backgroundColor: "rgba(5, 150, 105, 0.12)",
        fill: true,
        tension: 0.35,
      },
      {
        label: "ความเครียดจาก LST",
        data: [0.36, 0.32, 0.25, 0.22, 0.29, 0.38],
        borderColor: "#f59e0b",
        backgroundColor: "rgba(245, 158, 11, 0.12)",
        fill: true,
        tension: 0.35,
      },
    ],
  },
  options: chartOptions(),
});

renderAnalysisPayload(buildDemoPayload());

function updateBboxFromLayer(layer) {
  const bounds = layer.getBounds();
  state.bbox = [
    roundCoord(bounds.getWest()),
    roundCoord(bounds.getSouth()),
    roundCoord(bounds.getEast()),
    roundCoord(bounds.getNorth()),
  ];
  elements.bboxOutput.textContent = JSON.stringify(state.bbox, null, 2);
  map.fitBounds(bounds.pad(0.12));
  setStatus("บันทึกขอบเขตแปลงเป็นพิกัด WGS84 แล้ว");
}

function clearField() {
  drawnItems.clearLayers();
  state.fieldLayer = null;
  state.bbox = null;
  elements.bboxOutput.textContent = "ยังไม่ได้เลือกแปลง";
  setStatus("ล้างขอบเขตแปลงแล้ว");
}

async function analyzeSelectedField() {
  if (!state.bbox) {
    setStatus("กรุณาวาดขอบเขตแปลงก่อนเริ่มวิเคราะห์", true);
    return;
  }

  elements.analyzeBtn.disabled = true;
  elements.analyzeBtn.textContent = "กำลังวิเคราะห์...";
  setStatus(`กำลังส่ง bbox ไปยัง API วิเคราะห์ที่ ${API_URLS[0]}...`);

  try {
    const timeRange = getSelectedTimeRange(elements.startDate, elements.endDate);
    const payload = await postAnalysis({
      bbox: state.bbox,
      time_range: timeRange,
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

function renderAnalysisPayload(payload) {
  const alerts = normalizeAlerts(payload);
  state.alertLayer.clearLayers();
  state.popupCharts.forEach((chart) => chart.destroy());
  state.popupCharts.clear();

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

  if (alerts.length) {
    const group = L.featureGroup(state.alertLayer.getLayers());
    map.fitBounds(group.getBounds().pad(0.18));
  } else {
    addSummaryMarker(payload);
  }

  updateKpis(payload, alerts);
  updatePlanner(payload, alerts);
  return alerts.length;
}

function addSummaryMarker(payload) {
  const center = getPayloadCenter(payload);
  if (!center) return;

  const ndvi = payload.ndvi_summary?.mean ?? payload.mean_ndvi;
  const lst = payload.lst_summary?.mean ?? payload.mean_lst_celsius;
  const marker = L.marker(center, {
    icon: makePinIcon("healthy"),
    title: "Summary result",
  }).addTo(state.alertLayer);

  marker.bindPopup(`
    <div>
      <p class="popup-title text-emerald-700">ผลสรุปจากการวิเคราะห์</p>
      <div class="popup-grid">
        <div class="popup-metric">NDVI<strong>${formatNumber(ndvi, 2)}</strong></div>
        <div class="popup-metric">LST<strong>${formatNumber(lst, 1)} C</strong></div>
        <div class="popup-metric">Pixels<strong>${payload.ndvi_summary?.valid_pixel_count ?? "--"}</strong></div>
        <div class="popup-metric">Anomaly<strong>${payload.anomaly_count ?? 0}</strong></div>
      </div>
    </div>
  `);
  map.setView(center, Math.max(map.getZoom(), 13));
}

function getPayloadCenter(payload) {
  const bbox = payload.bbox ?? state.bbox;
  if (Array.isArray(bbox) && bbox.length === 4) {
    return [(Number(bbox[1]) + Number(bbox[3])) / 2, (Number(bbox[0]) + Number(bbox[2])) / 2];
  }
  return state.fieldLayer ? state.fieldLayer.getBounds().getCenter() : null;
}

function normalizeAlerts(payload) {
  if (Array.isArray(payload.alerts)) {
    return payload.alerts.map(normalizeAlert).filter(Boolean);
  }

  if (Array.isArray(payload.pixels)) {
    const stride = Math.max(1, Math.floor(payload.pixels.length / 260));
    return payload.pixels
      .filter((pixel, index) => pixel.is_anomaly === 1 || index % stride === 0)
      .map(normalizeAlert)
      .filter(Boolean);
  }

  return [];
}

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
    rainfall_15d_mm: nullableNumber(raw.rainfall_15d_mm ?? raw.rainfall15dMm) ?? 0,
    is_anomaly: Number(raw.is_anomaly ?? raw.isAnomaly ?? 0),
    ndvi_series: raw.ndvi_series ?? buildNdviSeries(raw.ndvi, raw.ndvi_diff),
    rainfall_series: raw.rainfall_series ?? buildRainfallSeries(raw.rainfall_15d_mm),
  };
}

function updateKpis(payload, alerts) {
  const meanNdvi = payload.ndvi_summary?.mean ?? average(alerts.map((item) => item.ndvi));
  const meanLst = payload.lst_summary?.mean ?? average(alerts.map((item) => item.lst_celsius));
  const anomalyCount = alerts.filter((item) => item.is_anomaly === 1).length;
  const damage = alerts.length ? (anomalyCount / alerts.length) * 100 : 0;

  elements.avgNdvi.textContent = formatNumber(meanNdvi, 2);
  elements.avgLst.textContent = `${formatNumber(meanLst, 1)} C`;
  elements.damagePercent.textContent = `${Math.round(damage)}%`;
  elements.alertCount.textContent = String(alerts.length);
}

function updatePlanner(payload, alerts) {
  const meanLst = payload.lst_summary?.mean ?? average(alerts.map((item) => item.lst_celsius));
  const meanNdvi = payload.ndvi_summary?.mean ?? average(alerts.map((item) => item.ndvi));
  const stress = Number.isFinite(meanLst) ? clamp((meanLst - 24) / 16, 0, 1) : 0.4;
  const moisture = clamp(0.72 - stress * 0.38 + (meanNdvi || 0.5) * 0.12, 0.1, 0.95);
  const moistureSeries = [0.52, 0.58, moisture, moisture + 0.05, moisture - 0.03, moisture - 0.08]
    .map((value) => roundMetric(clamp(value, 0.05, 0.95)));
  const stressSeries = moistureSeries.map((value) => roundMetric(clamp(1 - value, 0.05, 0.95)));
  const bestIndex = moistureSeries.indexOf(Math.max(...moistureSeries));

  soilMoistureChart.data.datasets[0].data = moistureSeries;
  soilMoistureChart.data.datasets[1].data = stressSeries;
  soilMoistureChart.update();

  elements.plantingWindow.textContent = `สัปดาห์ที่ ${bestIndex + 1}`;
  elements.plannerRecommendation.textContent =
    meanLst > 33
      ? "ควรเลื่อนการปลูกจนกว่าอุณหภูมิบริเวณทรงพุ่มจะลดลงและฝนช่วยเติมความชื้นผิวดิน"
      : `ช่วงปลูกที่แนะนำคือสัปดาห์ที่ ${bestIndex + 1} เมื่อแบบจำลองคาดว่าความชื้นสูงสุดและความเครียดจาก LST ต่ำสุด`;
}

function buildPopupHtml(alert, index) {
  const status = alert.is_anomaly ? "เสี่ยงพืชเครียดหรือโรครุนแรง" : "พื้นที่ปกติหรือคงที่";
  const statusClass = alert.is_anomaly ? "text-red-600" : "text-emerald-700";

  return `
    <div>
      <p class="popup-title ${statusClass}">${status}</p>
      <div class="popup-grid">
        <div class="popup-metric">NDVI<strong>${formatNumber(alert.ndvi, 2)}</strong></div>
        <div class="popup-metric">LST<strong>${formatNumber(alert.lst_celsius, 1)} C</strong></div>
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
          backgroundColor: alert.is_anomaly ? "rgba(239,68,68,0.12)" : "rgba(5,150,105,0.12)",
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

function makePinIcon(status) {
  return L.divIcon({
    className: "",
    html: `<div class="alert-marker ${status}"></div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 28],
    popupAnchor: [0, -28],
  });
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

function buildDemoPayload() {
  const center = state.bbox
    ? [(state.bbox[1] + state.bbox[3]) / 2, (state.bbox[0] + state.bbox[2]) / 2]
    : [15.8700, 100.9925];

  const points = [
    { offset: [0, 0], ndvi: 0.72, lst_celsius: 28.8, ndvi_diff: 0.04, is_anomaly: 0 },
    { offset: [0.008, -0.006], ndvi: 0.31, lst_celsius: 36.4, ndvi_diff: -0.18, is_anomaly: 1 },
    { offset: [-0.007, 0.007], ndvi: 0.67, lst_celsius: 29.6, ndvi_diff: 0.02, is_anomaly: 0 },
    { offset: [0.004, 0.009], ndvi: 0.28, lst_celsius: 37.1, ndvi_diff: -0.21, is_anomaly: 1 },
    { offset: [-0.006, -0.008], ndvi: 0.75, lst_celsius: 27.9, ndvi_diff: 0.05, is_anomaly: 0 },
  ];

  return {
    crs: "EPSG:4326",
    time_range: getSelectedTimeRange(elements.startDate, elements.endDate, false),
    ndvi_summary: { mean: 0.59, min: 0.28, max: 0.75, valid_pixel_count: 5 },
    lst_summary: { mean: 31.9, min: 27.9, max: 37.1, valid_pixel_count: 5 },
    pixels: points.map((point) => ({
      lat: center[0] + point.offset[0],
      lon: center[1] + point.offset[1],
      rainfall_15d_mm: 42,
      ndvi_series: buildNdviSeries(point.ndvi, point.ndvi_diff),
      rainfall_series: buildRainfallSeries(42),
      ...point,
    })),
  };
}

function buildNdviSeries(ndvi = 0.62, slope = 0.02) {
  const current = nullableNumber(ndvi) ?? 0.62;
  const diff = nullableNumber(slope) ?? 0.02;
  return [current - 0.18, current - 0.11, current - 0.06, current - diff, current, current + diff * 0.6]
    .map((value) => roundMetric(clamp(value, 0.05, 0.92)));
}

function buildRainfallSeries(total = 35) {
  const amount = nullableNumber(total) ?? 35;
  return [0.12, 0.18, 0.22, 0.16, 0.2, 0.12].map((share) => Math.round(amount * share));
}

function setStatus(message, isError = false) {
  elements.statusText.textContent = message;
  elements.statusText.className = `text-sm ${isError ? "text-red-600" : "text-slate-500"}`;
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
    const detail = payload.detail || payload.message || "";
    const isRouteMissing = response.status === 404 && (!detail || detail === "Not Found");

    if (!isRouteMissing) {
      if (response.status === 422) {
        throw new Error(
          detail
            ? `ไม่สามารถวิเคราะห์ได้: ${detail}`
            : "ไม่สามารถวิเคราะห์ได้ กรุณาตรวจสอบแปลง วันที่ และเมฆปกคลุม",
        );
      }
      throw new Error(detail || `การวิเคราะห์จากแบ็กเอนด์ล้มเหลวด้วย HTTP ${response.status}`);
    }
    lastError = `ไม่พบ Route ${url} (404)`;
  }

  throw new Error(`${lastError} กรุณารีสตาร์ต FastAPI เพื่อโหลด routes ล่าสุด`);
}

function getSelectedTimeRange(startInput, endInput, shouldThrow = true) {
  const startDate = startInput.value;
  const endDate = endInput.value;
  const fallback = "2025-05-01/2025-06-01";

  if (!startDate || !endDate) {
    if (shouldThrow) throw new Error("กรุณาเลือกวันที่เริ่มต้นและวันที่สิ้นสุด");
    return fallback;
  }

  if (startDate > endDate) {
    if (shouldThrow) throw new Error("วันที่เริ่มต้นต้องมาก่อนหรือเท่ากับวันที่สิ้นสุด");
    return fallback;
  }

  return `${startDate}/${endDate}`;
}

function average(values) {
  const clean = values.filter((value) => Number.isFinite(value));
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : null;
}

function nullableNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatNumber(value, digits) {
  return Number.isFinite(value) ? Number(value).toFixed(digits) : "--";
}

function roundCoord(value) {
  return Number(value.toFixed(6));
}

function roundMetric(value) {
  return Number(value.toFixed(3));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
