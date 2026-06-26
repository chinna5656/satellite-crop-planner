import http from "k6/http";
import { check, group, sleep } from "k6";
import { Counter, Rate } from "k6/metrics";

const BASE_URL = (__ENV.BASE_URL || "http://127.0.0.1:8000").replace(/\/$/, "");
const RUN_ANALYSIS = ["1", "true", "yes"].includes(String(__ENV.RUN_ANALYSIS || "").toLowerCase());
const SMOKE_VUS = Number(__ENV.CROP_K6_VUS || 3);
const SMOKE_DURATION = __ENV.CROP_K6_DURATION || "30s";

export const webFailures = new Counter("web_failures");
export const apiAnalysisAttempted = new Counter("api_analysis_attempted");
export const apiAnalysisUsable = new Rate("api_analysis_usable");

export const options = {
  scenarios: {
    web_smoke: {
      executor: "constant-vus",
      vus: SMOKE_VUS,
      duration: SMOKE_DURATION,
      gracefulStop: "5s",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.05"],
    http_req_duration: ["p(95)<1500"],
    web_failures: ["count<1"],
  },
};

const headers = {
  "Content-Type": "application/json",
  Accept: "application/json, text/html",
};

export default function () {
  group("web pages", () => {
    expectOk(http.get(`${BASE_URL}/`, { tags: { name: "GET /" } }), "dashboard page");
    expectOk(http.get(`${BASE_URL}/raster`, { tags: { name: "GET /raster" } }), "raster page");
  });

  group("static assets", () => {
    expectOk(http.get(`${BASE_URL}/static/app.js`, { tags: { name: "GET app.js" } }), "app.js");
    expectOk(http.get(`${BASE_URL}/static/raster.js`, { tags: { name: "GET raster.js" } }), "raster.js");
    expectOk(http.get(`${BASE_URL}/static/styles.css`, { tags: { name: "GET styles.css" } }), "styles.css");
  });

  group("api health", () => {
    const response = http.get(`${BASE_URL}/api/health`, { headers, tags: { name: "GET /api/health" } });
    expectOk(response, "api health");
    check(response, {
      "health returns ok": (res) => {
        try {
          return res.json("status") === "ok";
        } catch {
          return false;
        }
      },
    }) || webFailures.add(1);
  });

  if (RUN_ANALYSIS) {
    group("optional analysis api", () => {
      testAnalyzeField();
      testAnalyzeStress();
    });
  }

  sleep(1);
}

function testAnalyzeField() {
  apiAnalysisAttempted.add(1);
  const payload = JSON.stringify({
    bbox: [100.45, 13.65, 100.55, 13.75],
    time_range: "2025-01-01/2025-03-31",
    rainfall_15d_mm: 42,
  });
  const response = http.post(`${BASE_URL}/api/analyze-field`, payload, {
    headers,
    timeout: "120s",
    tags: { name: "POST /api/analyze-field" },
  });

  const usable = check(response, {
    "analyze-field returns handled status": (res) => [200, 422].includes(res.status),
    "analyze-field has JSON detail or pixels": (res) => hasJsonKey(res, "pixels") || hasJsonKey(res, "detail"),
  });
  apiAnalysisUsable.add(usable);
  if (!usable) webFailures.add(1);
}

function testAnalyzeStress() {
  apiAnalysisAttempted.add(1);
  const payload = JSON.stringify({
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [100.45, 13.65],
          [100.55, 13.65],
          [100.55, 13.75],
          [100.45, 13.75],
          [100.45, 13.65],
        ],
      ],
    },
    coordinates: [
      [
        [100.45, 13.65],
        [100.55, 13.65],
        [100.55, 13.75],
        [100.45, 13.75],
        [100.45, 13.65],
      ],
    ],
    start_date: "2025-01-01",
    end_date: "2025-03-31",
  });
  const response = http.post(`${BASE_URL}/api/analyze-stress`, payload, {
    headers,
    timeout: "120s",
    tags: { name: "POST /api/analyze-stress" },
  });

  const usable = check(response, {
    "analyze-stress returns handled status": (res) => [200, 422].includes(res.status),
    "analyze-stress has JSON detail or tile": (res) => hasJsonKey(res, "tile_url") || hasJsonKey(res, "detail"),
  });
  apiAnalysisUsable.add(usable);
  if (!usable) webFailures.add(1);
}

function expectOk(response, label) {
  const passed = check(response, {
    [`${label} status is 200`]: (res) => res.status === 200,
    [`${label} body is not empty`]: (res) => Boolean(res.body && res.body.length > 0),
  });
  if (!passed) webFailures.add(1);
}

function hasJsonKey(response, key) {
  try {
    return response.json(key) !== undefined;
  } catch {
    return false;
  }
}

export function handleSummary(data) {
  return {
    stdout: textSummary(data),
    "k6-summary.json": JSON.stringify(data, null, 2),
  };
}

function textSummary(data) {
  const checksRate = data.metrics.checks?.values?.rate ?? 0;
  const reqFailed = data.metrics.http_req_failed?.values?.rate ?? 0;
  const p95 = data.metrics.http_req_duration?.values?.["p(95)"] ?? 0;
  return [
    "",
    "Satellite Crop Planner k6 summary",
    `Base URL: ${BASE_URL}`,
    `Checks passed: ${(checksRate * 100).toFixed(2)}%`,
    `HTTP failure rate: ${(reqFailed * 100).toFixed(2)}%`,
    `HTTP duration p95: ${p95.toFixed(2)} ms`,
    `Optional analysis enabled: ${RUN_ANALYSIS}`,
    "",
  ].join("\n");
}
