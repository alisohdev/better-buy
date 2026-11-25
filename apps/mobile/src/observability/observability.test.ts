import assert from "node:assert/strict";
import { test } from "node:test";
import { CODES, EVENTS, JOURNAL_LIMIT, readMonitorConfig } from "./schema.ts";
import { createObservability, type FetchLike } from "./service.ts";

const clock = () => new Date("2026-01-02T03:04:05.000Z");
const scanId = "ab".repeat(16);

function lab() {
  return createObservability({
    clock,
    random: () => 0,
    runtime: {
      appVersion: "0.1.0",
      engineVersion: "0.1.0",
      osVersion: "android 35",
    },
  });
}

test("structured scan events keep correlation, versions, duration, and coverage apart", () => {
  const obs = lab();
  obs.scanStarted({
    scanId,
    provider: "fixture",
    stage: "fixture",
    requestCount: 0,
  });
  obs.scanCompleted({
    scanId,
    provider: "fixture",
    stage: "fixture",
    durationMs: 1216,
    requestCount: 0,
    coverage: "complete",
  });
  obs.scanCompleted({
    scanId,
    provider: "fixture",
    stage: "page",
    durationMs: 800,
    requestCount: 2,
    httpStatus: 200,
    coverage: "incomplete",
  });
  const events = obs.list();
  assert.equal(events[0]?.event, EVENTS.scanStarted);
  assert.equal(events[0]?.time, "2026-01-02T03:04:05.000Z");
  assert.equal(events[0]?.level, "INFO");
  assert.equal(events[0]?.osVersion, "android 35");
  assert.equal(events[1]?.event, EVENTS.scanCompleted);
  assert.equal(events[1]?.coverage, "complete");
  assert.equal(events[1]?.code, undefined);
  assert.equal(events[2]?.event, EVENTS.scanCompleted);
  assert.equal(events[2]?.coverage, "incomplete");
  assert.equal(events[2]?.code, CODES.COVERAGE_INCOMPLETE);
  assert.equal(events[3]?.event, EVENTS.coverageIncomplete);
  assert.equal(
    events.filter((event) => event.event === EVENTS.coverageIncomplete).length,
    1
  );
});

test("provider failures and controlled errors keep stable codes", () => {
  const obs = lab();
  obs.scanFailed({
    scanId,
    code: CODES.ENGINE_INIT_FAILED,
    provider: "fixture",
    stage: "fixture",
  });
  obs.authRejected({ scanId, provider: "fixture", stage: "auth" });
  obs.networkTimeout({
    scanId,
    provider: "fixture",
    stage: "list",
    durationMs: 3000,
  });
  obs.paginationFailed({
    scanId,
    provider: "fixture",
    stage: "page",
    httpStatus: 500,
  });
  obs.databaseWriteFailed({ scanId, stage: "persist" });
  obs.controlledError({ scanId });
  obs.scanCancelled({
    scanId,
    durationMs: 400,
    requestCount: 0,
    provider: "fixture",
    stage: "fixture",
  });
  const codes = obs.list().map((event) => event.code);
  assert.deepEqual(codes, [
    CODES.ENGINE_INIT_FAILED,
    CODES.AUTH_REJECTED,
    CODES.NETWORK_TIMEOUT,
    CODES.PAGINATION_FAILED,
    CODES.DATABASE_WRITE_FAILED,
    CODES.FIXTURE_ERROR,
    undefined,
  ]);
  assert.equal(obs.list()[1]?.httpStatus, 401);
  assert.equal(obs.list()[3]?.httpStatus, 500);
});

test("sensitive values are dropped or scrubbed before storage and export", () => {
  const obs = lab();
  obs.record({
    level: "ERROR",
    event: EVENTS.scanFailed,
    code: CODES.AUTH_REJECTED,
    scanId: "09120000000",
    provider: "Bearer secret-token",
    message:
      'user 09120000000 bearer abc.def {"token":"secret","phone":"09120000000","latitude":35.7}',
  });
  obs.record({
    level: "INFO",
    event: EVENTS.lifecycle,
    message: "authorization=abc cookie=session device stays out",
  });
  const [failed, lifecycle] = obs.list();
  assert.equal(failed?.scanId, undefined);
  assert.equal(failed?.provider, undefined);
  assert.equal(failed?.message, "[redacted]");
  assert.match(lifecycle?.message ?? "", /authorization \[redacted\]/);
  assert.doesNotMatch(
    JSON.stringify(obs.exportDiagnostics([])),
    /09120000000|secret-token|session/
  );
});

test("the journal keeps the newest 32 records", () => {
  const obs = lab();
  for (let i = 0; i < 40; i += 1) {
    obs.record({
      level: "DEBUG",
      event: EVENTS.lifecycle,
      message: `row ${i}`,
    });
  }
  const rows = obs.list();
  assert.equal(rows.length, JOURNAL_LIMIT);
  assert.equal(rows[0]?.message, "row 8");
  assert.equal(rows.at(-1)?.message, "row 39");
});

test("a failing monitor does not fail the scan path and queues while offline", async () => {
  let calls = 0;
  let online = false;
  const fetchImpl: FetchLike = async () => {
    calls += 1;
    if (!online) throw new Error("offline");
    return { ok: true, status: 204 };
  };
  const obs = createObservability({
    clock,
    random: () => 0,
    fetch: fetchImpl,
    runtime: {
      appVersion: "0.1.0",
      engineVersion: "0.1.0",
      osVersion: "android 35",
    },
    config: {
      enabled: true,
      provider: "http",
      endpoint: "https://diagnostics.example.test/ingest",
      sampleRate: 1,
    },
  });
  const scan = () => {
    obs.scanStarted({
      scanId,
      provider: "fixture",
      stage: "fixture",
      requestCount: 0,
    });
    obs.scanCompleted({
      scanId,
      provider: "fixture",
      stage: "fixture",
      durationMs: 10,
      requestCount: 0,
      coverage: "complete",
    });
    return "persisted";
  };
  assert.equal(scan(), "persisted");
  await obs.flush();
  assert.equal(obs.monitoring().outbound, 2);
  assert.equal(obs.list().length, 2);
  online = true;
  await obs.flush();
  assert.equal(calls >= 2, true);
  assert.equal(obs.monitoring().outbound, 0);
});

test("a throwing monitor and a disabled monitor stay off the scan path", () => {
  const throwing = createObservability({
    clock,
    runtime: { appVersion: "0.1.0" },
    config: {
      enabled: true,
      provider: "http",
      endpoint: "https://diagnostics.example.test/ingest",
      sampleRate: 1,
    },
    monitor: {
      capture() {
        throw new Error("monitor down");
      },
    },
  });
  assert.equal(
    (() => {
      throwing.scanFailed({
        code: CODES.NATIVE_BRIDGE_FAILED,
        message: "status read failed",
      });
      return "isolated";
    })(),
    "isolated"
  );
  assert.equal(throwing.list()[0]?.code, CODES.NATIVE_BRIDGE_FAILED);

  let fetches = 0;
  const disabled = createObservability({
    clock,
    fetch: async () => {
      fetches += 1;
      return { ok: true, status: 204 };
    },
    runtime: { appVersion: "0.1.0" },
  });
  disabled.scanStarted({ scanId, provider: "fixture", stage: "fixture" });
  assert.equal(fetches, 0);
  assert.equal(disabled.monitoring().enabled, false);
});

test("sampling skips non-errors and still ships errors", async () => {
  const seen: string[] = [];
  const obs = createObservability({
    clock,
    random: () => 0.9,
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body) as { events: { level: string }[] };
      seen.push(...body.events.map((event) => event.level));
      return { ok: true, status: 204 };
    },
    runtime: { appVersion: "0.1.0" },
    config: {
      enabled: true,
      provider: "arvan",
      endpoint: "https://diagnostics.example.test/ingest",
      sampleRate: 0.1,
    },
  });
  obs.scanStarted({ scanId, provider: "fixture", stage: "fixture" });
  obs.scanFailed({
    scanId,
    code: CODES.NETWORK_TIMEOUT,
    provider: "fixture",
    stage: "list",
  });
  await obs.flush();
  assert.deepEqual(seen, ["ERROR"]);
  assert.equal(obs.list().length, 2);
});

test("export normalizes engine logs and drops fields outside the schema", () => {
  const obs = lab();
  obs.fixturePersisted({ scanId, durationMs: 12 });
  const exported = obs.exportDiagnostics([
    {
      time: "2026-01-02T03:04:05.000Z",
      level: "INFO",
      msg: "fixture finished",
      scanId,
      state: "complete",
      durationMs: 1216,
      requestCount: 0,
      engineVersion: "0.1.0",
      offers: [{ key: "store-a:rice", price: 800 }],
      responseBody: '{"token":"secret"}',
    },
    {
      time: "2026-01-02T03:04:06.000Z",
      level: "ERROR",
      msg: "controlled error",
      code: "FIXTURE_ERROR",
      engineVersion: "0.1.0",
    },
  ]);
  assert.equal(exported.events[0]?.event, EVENTS.fixturePersisted);
  assert.equal(exported.engineEvents[0]?.event, EVENTS.scanCompleted);
  assert.equal(exported.engineEvents[0]?.coverage, "complete");
  assert.equal(exported.engineEvents[0]?.requestCount, 0);
  assert.equal(exported.engineEvents[1]?.code, CODES.FIXTURE_ERROR);
  const text = JSON.stringify(exported);
  assert.equal(text.includes("store-a"), false);
  assert.equal(text.includes("responseBody"), false);
  assert.equal(text.includes("secret"), false);
  assert.equal(exported.monitoring.enabled, false);
});

test("an enabled Sentry provider does not open a network connection", async () => {
  let fetches = 0;
  const obs = createObservability({
    clock,
    fetch: async () => {
      fetches += 1;
      return { ok: true, status: 204 };
    },
    runtime: { appVersion: "0.1.0" },
    config: { enabled: true, provider: "sentry", sampleRate: 1 },
  });
  obs.scanFailed({
    scanId,
    code: CODES.FIXTURE_ERROR,
    provider: "fixture",
    stage: "fixture",
  });
  await obs.flush();
  assert.equal(fetches, 0);
  assert.equal(
    obs.list().some((event) => event.code === CODES.MONITOR_UNAVAILABLE),
    true
  );
});

test("monitor config stays disabled unless explicitly enabled", () => {
  assert.deepEqual(readMonitorConfig(undefined), {
    enabled: false,
    provider: "none",
    endpoint: undefined,
    sampleRate: 1,
  });
  const enabled = readMonitorConfig({
    observability: {
      enabled: true,
      provider: "http",
      endpoint: "http://insecure.example/ingest",
      sampleRate: 4,
    },
  });
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.endpoint, undefined);
  assert.equal(enabled.sampleRate, 1);
});
