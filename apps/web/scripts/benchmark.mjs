import { chromium, devices } from "@playwright/test";
import { gzipSync } from "node:zlib";

const baseURL = process.env.BENCHMARK_URL ?? "http://127.0.0.1:3100";
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.PLAYWRIGHT_CHROME_PATH ??
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
});
const context = await browser.newContext({ ...devices["Pixel 7"] });
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send("Network.enable");
await cdp.send("Performance.enable");
await cdp.send("Network.emulateNetworkConditions", {
  offline: false,
  latency: 150,
  downloadThroughput: (1.6 * 1024 * 1024) / 8,
  uploadThroughput: (750 * 1024) / 8,
  connectionType: "cellular3g",
});
await page.addInitScript(() => {
  window.__benchmarkLcp = 0;
  new PerformanceObserver((entries) => {
    for (const entry of entries.getEntries()) {
      window.__benchmarkLcp = {
        time: entry.startTime,
        tag: entry.element?.tagName,
        className: entry.element?.getAttribute("class"),
        text: entry.element?.textContent?.trim().slice(0, 160),
        url: entry.url,
        renderTime: entry.renderTime,
        loadTime: entry.loadTime,
      };
    }
  }).observe({ type: "largest-contentful-paint", buffered: true });
});
await page.route("**/api/**", async (route) => {
  const path = new URL(route.request().url()).pathname;
  const body =
    path === "/api/auth/get-session"
      ? {
          session: {
            id: "benchmark-session",
            userId: "benchmark-user",
            expiresAt: "2099-01-01T00:00:00.000Z",
            createdAt: "2026-11-18T00:00:00.000Z",
            updatedAt: "2026-11-18T00:00:00.000Z",
          },
          user: {
            id: "benchmark-user",
            name: "Benchmark",
            phone: "09120000000",
            phoneVerified: true,
            image: null,
            createdAt: "2026-11-18T00:00:00.000Z",
            updatedAt: "2026-11-18T00:00:00.000Z",
          },
        }
      : { data: [] };
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
});
const requests = new Set();
const responses = [];
page.on("request", (request) => requests.add(request.url()));
page.on("response", async (response) => {
  if (response.request().resourceType() === "script") {
    const body = await response.body();
    responses.push({
      url: response.url(),
      bytes: body.byteLength,
      gzipBytes: gzipSync(body).byteLength,
    });
  }
});
await page.goto(baseURL, { waitUntil: "networkidle" });
await page.waitForTimeout(500);
const result = await page.evaluate(() => ({
  lcp: window.__benchmarkLcp,
  ttfbMs: Math.round(
    performance.getEntriesByType("navigation")[0].responseStart
  ),
  resources: performance.getEntriesByType("resource").map((entry) => ({
    path: new URL(entry.name).pathname,
    type: entry.initiatorType,
    start: Math.round(entry.startTime),
    responseStart: Math.round(entry.responseStart),
    end: Math.round(entry.responseEnd),
    transferSize: entry.transferSize,
  })),
  documentReadyMs: Math.round(
    performance.getEntriesByType("navigation")[0].domContentLoadedEventEnd
  ),
}));
const { metrics } = await cdp.send("Performance.getMetrics");
const cpuMs = Object.fromEntries(
  metrics
    .filter(({ name }) =>
      [
        "ScriptDuration",
        "TaskDuration",
        "LayoutDuration",
        "RecalcStyleDuration",
      ].includes(name)
    )
    .map(({ name, value }) => [name, Math.round(value * 1000)])
);
console.log(
  JSON.stringify(
    {
      viewport: "Pixel 7",
      throttling: "150 ms RTT, 1.6 Mbps down, 750 Kbps up",
      api: "deterministic local JSON fixtures",
      requestCount: requests.size,
      javascriptResponseBytes: responses.reduce(
        (total, response) => total + response.bytes,
        0
      ),
      javascriptGzipBytes: responses.reduce(
        (total, response) => total + response.gzipBytes,
        0
      ),
      javascriptResponses: responses,
      cpuMs,
      ...result,
    },
    null,
    2
  )
);
await browser.close();
