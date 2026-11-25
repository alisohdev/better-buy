import {
  CODES,
  EVENTS,
  JOURNAL_LIMIT,
  type Coverage,
  type DiagnosticEvent,
  type ErrorCode,
  type EventInput,
  type EventName,
  type Level,
  type MonitorConfig,
  type RuntimeInfo,
  disabledMonitorConfig,
  isCoverage,
  isErrorCode,
  isEventName,
  isLevel,
} from "./schema.ts";
import {
  boundedInt,
  labelOrDrop,
  scanIdOrDrop,
  scrubMessage,
} from "./redact.ts";

export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  }
) => Promise<{ ok: boolean; status: number }>;

export type Monitor = {
  capture(event: DiagnosticEvent): void;
};

export type ObservabilityOptions = {
  clock?: () => Date;
  random?: () => number;
  fetch?: FetchLike;
  capacity?: number;
  config?: MonitorConfig;
  runtime?: RuntimeInfo;
  monitor?: Monitor;
};

type Listener = (event: DiagnosticEvent) => void;

function utc(clock: () => Date, supplied?: string): string {
  if (supplied) {
    const parsed = new Date(supplied);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return clock().toISOString();
}

function buildEvent(
  input: EventInput,
  runtime: RuntimeInfo,
  clock: () => Date
): DiagnosticEvent | undefined {
  if (!isEventName(input.event) || !isLevel(input.level)) return undefined;
  const appVersion = input.appVersion || runtime.appVersion;
  if (!appVersion) return undefined;
  const event: DiagnosticEvent = {
    time: utc(clock, input.time),
    level: input.level,
    event: input.event,
    appVersion,
  };
  const code = input.code && isErrorCode(input.code) ? input.code : undefined;
  const scanId = scanIdOrDrop(input.scanId);
  const engineVersion = input.engineVersion || runtime.engineVersion;
  const osVersion = input.osVersion || runtime.osVersion;
  const durationMs = boundedInt(input.durationMs, 86_400_000);
  const requestCount = boundedInt(input.requestCount, 1_000_000);
  const provider = labelOrDrop(input.provider);
  const stage = labelOrDrop(input.stage);
  const httpStatus = boundedInt(input.httpStatus, 599);
  const coverage =
    input.coverage && isCoverage(input.coverage) ? input.coverage : undefined;
  const message =
    typeof input.message === "string" ? scrubMessage(input.message) : undefined;
  if (code) event.code = code;
  if (scanId) event.scanId = scanId;
  if (engineVersion && /^[0-9A-Za-z.+_-]{1,32}$/.test(engineVersion))
    event.engineVersion = engineVersion;
  if (osVersion && /^[a-z0-9 ._-]{1,40}$/i.test(osVersion))
    event.osVersion = osVersion;
  if (durationMs !== undefined) event.durationMs = durationMs;
  if (requestCount !== undefined) event.requestCount = requestCount;
  if (provider) event.provider = provider;
  if (stage) event.stage = stage;
  if (httpStatus !== undefined && httpStatus >= 100)
    event.httpStatus = httpStatus;
  if (coverage) event.coverage = coverage;
  if (message && message !== "[redacted]") event.message = message;
  else if (message === "[redacted]") event.message = "[redacted]";
  return event;
}

class HttpMonitor implements Monitor {
  readonly queue: DiagnosticEvent[] = [];
  private sending = false;
  private readonly endpoint: string;
  private readonly fetchImpl: FetchLike;
  private readonly capacity: number;

  constructor(endpoint: string, fetchImpl: FetchLike, capacity: number) {
    this.endpoint = endpoint;
    this.fetchImpl = fetchImpl;
    this.capacity = capacity;
  }

  capture(event: DiagnosticEvent): void {
    this.queue.push(event);
    if (this.queue.length > this.capacity)
      this.queue.splice(0, this.queue.length - this.capacity);
    void this.flush();
  }

  async flush(): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      while (this.queue.length > 0) {
        const batch = this.queue.slice(0, 10);
        const signal = AbortSignal.timeout?.(3_000);
        const response = await this.fetchImpl(this.endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ events: batch }),
          signal,
        });
        if (!response.ok) return;
        this.queue.splice(0, batch.length);
      }
    } catch {
      return;
    } finally {
      this.sending = false;
    }
  }
}

class IsolatingMonitor implements Monitor {
  private readonly inner: Monitor;

  constructor(inner: Monitor) {
    this.inner = inner;
  }

  capture(event: DiagnosticEvent): void {
    try {
      this.inner.capture(event);
    } catch {
      return;
    }
  }
}

export function createObservability(options: ObservabilityOptions = {}) {
  const clock = options.clock ?? (() => new Date());
  const random = options.random ?? Math.random;
  const capacity = options.capacity ?? JOURNAL_LIMIT;
  let runtime: RuntimeInfo = options.runtime ?? { appVersion: "unknown" };
  let config = options.config ?? disabledMonitorConfig();
  let monitor: Monitor = new IsolatingMonitor(
    options.monitor ?? { capture() {} }
  );
  let http: HttpMonitor | undefined;
  let warnedUnavailable = false;
  const journal: DiagnosticEvent[] = [];
  const listeners = new Set<Listener>();

  function installMonitor(next: MonitorConfig) {
    config = next;
    http = undefined;
    warnedUnavailable = false;
    if (options.monitor) {
      monitor = new IsolatingMonitor(options.monitor);
      return;
    }
    if (
      next.enabled &&
      (next.provider === "http" || next.provider === "arvan") &&
      next.endpoint &&
      options.fetch
    ) {
      http = new HttpMonitor(next.endpoint, options.fetch, capacity);
      monitor = new IsolatingMonitor(http);
      return;
    }
    monitor = new IsolatingMonitor({ capture() {} });
  }

  installMonitor(config);

  function append(event: DiagnosticEvent, emit: boolean) {
    journal.push(event);
    if (journal.length > capacity) journal.splice(0, journal.length - capacity);
    if (!emit) return;
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        continue;
      }
    }
    ship(event);
  }

  function noteUnavailable() {
    if (warnedUnavailable) return;
    warnedUnavailable = true;
    const notice = buildEvent(
      {
        level: "WARN",
        event: EVENTS.monitorDeliveryFailed,
        code: CODES.MONITOR_UNAVAILABLE,
        message: "remote monitor is not linked",
      },
      runtime,
      clock
    );
    if (notice) append(notice, false);
  }

  function ship(event: DiagnosticEvent) {
    if (!config.enabled || config.provider === "none") return;
    if (event.event === EVENTS.monitorDeliveryFailed) return;
    const linked = Boolean(options.monitor || http);
    if (!linked || config.provider === "sentry") {
      noteUnavailable();
      return;
    }
    const rate = event.level === "ERROR" ? 1 : config.sampleRate;
    if (random() > rate) return;
    monitor.capture(event);
  }

  function record(input: EventInput): DiagnosticEvent | undefined {
    try {
      const event = buildEvent(input, runtime, clock);
      if (!event) return undefined;
      append(event, true);
      return event;
    } catch {
      return undefined;
    }
  }

  function fields(
    input: Omit<EventInput, "level" | "event">,
    level: Level,
    event: EventName
  ) {
    return record({ ...input, level, event });
  }

  return {
    configure(update: { runtime?: RuntimeInfo; monitor?: MonitorConfig }) {
      if (update.runtime) runtime = { ...runtime, ...update.runtime };
      if (update.monitor) installMonitor(update.monitor);
    },
    record,
    hydrate(rows: unknown[]) {
      journal.length = 0;
      for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        const source = row as Partial<DiagnosticEvent>;
        if (!source.event || !source.level) continue;
        const event = buildEvent(
          {
            level: source.level,
            event: source.event,
            code: source.code,
            scanId: source.scanId,
            durationMs: source.durationMs,
            requestCount: source.requestCount,
            provider: source.provider,
            stage: source.stage,
            httpStatus: source.httpStatus,
            coverage: source.coverage,
            message: source.message,
            time: source.time,
            appVersion: source.appVersion,
            engineVersion: source.engineVersion,
            osVersion: source.osVersion,
          },
          runtime,
          clock
        );
        if (event) append(event, false);
      }
    },
    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    list(): DiagnosticEvent[] {
      return journal.map((event) => ({ ...event }));
    },
    runtime(): RuntimeInfo {
      return { ...runtime };
    },
    monitoring() {
      return {
        enabled: config.enabled,
        provider: config.provider,
        outbound: http?.queue.length ?? 0,
      };
    },
    async flush(): Promise<void> {
      await http?.flush();
    },
    scanStarted(input: Omit<EventInput, "level" | "event">) {
      return fields(input, "INFO", EVENTS.scanStarted);
    },
    scanCompleted(
      input: Omit<EventInput, "level" | "event" | "coverage"> & {
        coverage: Coverage;
      }
    ) {
      const level = input.coverage === "incomplete" ? "WARN" : "INFO";
      const code =
        input.coverage === "incomplete"
          ? CODES.COVERAGE_INCOMPLETE
          : input.code;
      const completed = fields({ ...input, code }, level, EVENTS.scanCompleted);
      if (input.coverage === "incomplete") {
        fields(
          { ...input, code: CODES.COVERAGE_INCOMPLETE },
          "WARN",
          EVENTS.coverageIncomplete
        );
      }
      return completed;
    },
    scanFailed(
      input: Omit<EventInput, "level" | "event"> & { code: ErrorCode }
    ) {
      return fields(input, "ERROR", EVENTS.scanFailed);
    },
    scanCancelled(input: Omit<EventInput, "level" | "event">) {
      return fields(input, "INFO", EVENTS.scanCancelled);
    },
    authRejected(input: Omit<EventInput, "level" | "event" | "code">) {
      return fields(
        {
          ...input,
          code: CODES.AUTH_REJECTED,
          httpStatus: input.httpStatus ?? 401,
        },
        "ERROR",
        EVENTS.authRejected
      );
    },
    networkTimeout(input: Omit<EventInput, "level" | "event" | "code">) {
      return fields(
        { ...input, code: CODES.NETWORK_TIMEOUT },
        "ERROR",
        EVENTS.networkTimeout
      );
    },
    paginationFailed(input: Omit<EventInput, "level" | "event" | "code">) {
      return fields(
        { ...input, code: CODES.PAGINATION_FAILED },
        "ERROR",
        EVENTS.paginationFailed
      );
    },
    databaseWriteFailed(input: Omit<EventInput, "level" | "event" | "code">) {
      return fields(
        { ...input, code: CODES.DATABASE_WRITE_FAILED },
        "ERROR",
        EVENTS.databaseWriteFailed
      );
    },
    fixturePersisted(input: Omit<EventInput, "level" | "event">) {
      return fields(input, "INFO", EVENTS.fixturePersisted);
    },
    controlledError(input: Omit<EventInput, "level" | "event" | "code"> = {}) {
      return fields(
        { ...input, code: CODES.FIXTURE_ERROR },
        "ERROR",
        EVENTS.controlledError
      );
    },
    exportDiagnostics(engineLogs: unknown) {
      const engineEvents: DiagnosticEvent[] = [];
      const rows = Array.isArray(engineLogs) ? engineLogs : [];
      for (const row of rows) {
        const normalized = normalizeEngineLog(row, runtime, clock);
        if (normalized) engineEvents.push(normalized);
      }
      return {
        appVersion: runtime.appVersion,
        engineVersion: runtime.engineVersion ?? "",
        osVersion: runtime.osVersion ?? "",
        monitoring: { enabled: config.enabled, provider: config.provider },
        events: journal.map((event) => ({ ...event })),
        engineEvents,
      };
    },
  };
}

export function normalizeEngineLog(
  row: unknown,
  runtime: RuntimeInfo,
  clock: () => Date
): DiagnosticEvent | undefined {
  if (!row || typeof row !== "object") return undefined;
  const source = row as Record<string, unknown>;
  const message =
    typeof source.msg === "string"
      ? source.msg
      : typeof source.message === "string"
        ? source.message
        : "";
  const state = typeof source.state === "string" ? source.state : "";
  let event: EventName = EVENTS.engineLog;
  if (message === "fixture started") event = EVENTS.scanStarted;
  else if (message === "fixture finished" && state === "cancelled")
    event = EVENTS.scanCancelled;
  else if (message === "fixture finished") event = EVENTS.scanCompleted;
  else if (message === "controlled error") event = EVENTS.controlledError;
  const level =
    typeof source.level === "string" ? source.level.toUpperCase() : "INFO";
  const coverage =
    state === "complete"
      ? "complete"
      : state === "cancelled"
        ? "unknown"
        : undefined;
  return buildEvent(
    {
      level: isLevel(level) ? level : "INFO",
      event,
      code:
        typeof source.code === "string" && isErrorCode(source.code)
          ? source.code
          : undefined,
      scanId: typeof source.scanId === "string" ? source.scanId : undefined,
      time: typeof source.time === "string" ? source.time : undefined,
      engineVersion:
        typeof source.engineVersion === "string"
          ? source.engineVersion
          : runtime.engineVersion,
      durationMs:
        typeof source.durationMs === "number" ? source.durationMs : undefined,
      requestCount:
        typeof source.requestCount === "number"
          ? source.requestCount
          : undefined,
      provider: event === EVENTS.engineLog ? undefined : "fixture",
      stage: event === EVENTS.engineLog ? undefined : "fixture",
      coverage,
      message,
      appVersion: runtime.appVersion,
      osVersion: runtime.osVersion,
    },
    runtime,
    clock
  );
}

export type Observability = ReturnType<typeof createObservability>;
