const ANALYZE_STRESS_URL = window.CROP_STRESS_API_URL || "/api/analyze-stress";
const THAILAND_CENTER = [15.8700, 100.9925];
const THAILAND_ZOOM = 6;

const rasterState = {
  drawnLayer: null,
  rasterTileLayer: null,
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
  demo: document.getElementById("rasterDemoBtn"),
  upload: document.getElementById("rasterJsonUpload"),
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
  rasterElements.bbox.textContent = JSON.stringify(geojson.geometry.coordinates, null, 2);
  rasterMap.fitBounds(rasterState.drawnLayer.getBounds().pad(0.12));
  setRasterStatus("บันทึกขอบเขตแปลงแล้ว กดวิเคราะห์เพื่อขอชั้นข้อมูลจาก Microsoft Planetary Computer");
});

rasterMap.on(L.Draw.Event.EDITED, (event) => {
  event.layers.eachLayer((layer) => {
    rasterState.drawnLayer = layer;
    const geojson = layer.toGeoJSON();
    rasterElements.bbox.textContent = JSON.stringify(geojson.geometry.coordinates, null, 2);
  });
});

rasterMap.on(L.Draw.Event.DELETED, () => {
  rasterState.drawnLayer = null;
  rasterElements.bbox.textContent = "ยังไม่ได้เลือกแปลง";
  removeRasterOverlay();
  setRasterStatus("ล้างขอบเขตแปลงแล้ว");
});

rasterElements.analyze?.addEventListener("click", analyzeStress);
rasterElements.mobilePanel?.addEventListener("click", () => {
  rasterElements.sidebar.classList.toggle("open");
  setTimeout(() => rasterMap.invalidateSize(), 260);
});

// Old raster-cell controls are optional on the page. They are hidden because this
// script renders Microsoft Planetary Computer tiles instead of local rectangle cells.
rasterElements.demo?.classList.add("hidden");
rasterElements.upload?.closest("label")?.classList.add("hidden");
document.querySelectorAll(".layer-toggle").forEach((button) => {
  button.disabled = true;
  button.title = "รูปแบบชั้นข้อมูลถูกกำหนดจากผลลัพธ์ Microsoft Planetary Computer";
});

window.addEventListener("resize", () => rasterMap.invalidateSize());
setRasterStatus("วาดรูปหลายเหลี่ยมหรือสี่เหลี่ยมหนึ่งแปลงในประเทศไทย");

async function analyzeStress() {
  if (!rasterState.drawnLayer) {
    setRasterStatus("กรุณาวาดรูปหลายเหลี่ยมหรือสี่เหลี่ยมก่อนเริ่มวิเคราะห์", true);
    return;
  }

  let dates;
  try {
    dates = getSelectedDates();
  } catch (error) {
    setRasterStatus(error.message, true);
    return;
  }

  const geojson = rasterState.drawnLayer.toGeoJSON();
  const requestBody = {
    geometry: geojson.geometry,
    coordinates: geojson.geometry.coordinates,
    start_date: dates.startDate,
    end_date: dates.endDate,
  };

  rasterElements.analyze.disabled = true;
  rasterElements.analyze.textContent = "กำลังวิเคราะห์...";
  setRasterStatus("กำลังส่งขอบเขตแปลงไปยัง API วิเคราะห์ Microsoft Planetary Computer...");

  try {
    const response = await fetch(ANALYZE_STRESS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.detail || payload.message || `การวิเคราะห์ล้มเหลวด้วย HTTP ${response.status}`);
    }
    if (!payload.tile_url) {
      throw new Error("ผลลัพธ์ API ไม่มี tile_url");
    }

    addRasterTileOverlay(payload.tile_url);
    updateSummaryCards(payload);
    setRasterStatus(
      `เพิ่มชั้นข้อมูลจาก ${payload.source || "Microsoft Planetary Computer"} แล้ว`,
    );
  } catch (error) {
    removeRasterOverlay();
    setRasterStatus(
      `${error.message} กรุณาตรวจสอบว่า route /api/analyze-stress ของแบ็กเอนด์ทำงานและส่งคืน { "tile_url": "..." }`,
      true,
    );
  } finally {
    rasterElements.analyze.disabled = false;
    rasterElements.analyze.textContent = "วิเคราะห์และแสดงราสเตอร์";
  }
}

function addRasterTileOverlay(tileUrl) {
  removeRasterOverlay();
  rasterState.rasterTileLayer = L.tileLayer(tileUrl, {
    opacity: 0.72,
    maxZoom: 19,
    zIndex: 450,
    crossOrigin: true,
    attribution: "Microsoft Planetary Computer",
  });

  rasterState.rasterTileLayer.on("tileerror", () => {
    setRasterStatus(
      "โหลด tile overlay ไม่สำเร็จ แต่ค่า summary จาก backend ยังแสดงอยู่ กรุณาลองช่วงวันที่กว้างขึ้นหรือ refresh token ของ tile",
      true,
    );
  });

  rasterState.rasterTileLayer.on("load", () => {
    setRasterStatus("แสดง tile overlay จาก Microsoft Planetary Computer บนแผนที่แล้ว");
  });

  rasterState.rasterTileLayer.addTo(rasterMap);

  if (rasterState.drawnLayer) {
    rasterMap.fitBounds(rasterState.drawnLayer.getBounds().pad(0.12));
  }
  if (rasterElements.subtitle) {
    rasterElements.subtitle.textContent = "ชั้นข้อมูลความเครียดจาก Microsoft Planetary Computer";
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
  setText(rasterElements.cells, payload.pixel_count ?? payload.tile_count ?? "ไทล์");
}

function getSelectedDates() {
  const startDate = rasterElements.startDate?.value;
  const endDate = rasterElements.endDate?.value;

  if (!startDate || !endDate) {
    throw new Error("กรุณาเลือกวันที่เริ่มต้นและวันที่สิ้นสุด");
  }
  if (startDate > endDate) {
    throw new Error("วันที่เริ่มต้นต้องมาก่อนหรือเท่ากับวันที่สิ้นสุด");
  }

  return { startDate, endDate };
}

function setRasterStatus(message, isError = false) {
  if (!rasterElements.status) return;
  rasterElements.status.textContent = message;
  rasterElements.status.className = `text-sm ${isError ? "text-red-600" : "text-slate-500"}`;
}

function setText(element, value) {
  if (element) element.textContent = String(value);
}

function formatMaybeNumber(value, digits, suffix = "") {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return "--";
  return `${numberValue.toFixed(digits)}${suffix}`;
}
