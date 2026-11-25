export const LEVELS = ["DEBUG", "INFO", "WARN", "ERROR"] as const;
export type Level = (typeof LEVELS)[number];

export const EVENTS = {
  scanStarted: "scan_started",
  scanCompleted: "scan_completed",
  scanFailed: "scan_failed",
  scanCancelled: "scan_cancelled",
  coverageIncomplete: "coverage_incomplete",
  authRejected: "auth_rejected",
  networkTimeout: "network_timeout",
  paginationFailed: "pagination_failed",
  databaseWriteFailed: "database_write_failed",
  fixturePersisted: "fixture_persisted",
  controlledError: "controlled_error",
  engineLog: "engine_log",
  lifecycle: "lifecycle",
  monitorDeliveryFailed: "monitor_delivery_failed",
} as const;

export type EventName = (typeof EVENTS)[keyof typeof EVENTS];

export const CODES = {
  OK: "OK",
  BUSY: "BUSY",
  ENGINE_INIT_FAILED: "ENGINE_INIT_FAILED",
  ENGINE_UNAVAILABLE: "ENGINE_UNAVAILABLE",
  FIXTURE_ERROR: "FIXTURE_ERROR",
  DIAGNOSTICS_READ_FAILED: "DIAGNOSTICS_READ_FAILED",
  DIAGNOSTICS_INIT_FAILED: "DIAGNOSTICS_INIT_FAILED",
  NATIVE_BRIDGE_FAILED: "NATIVE_BRIDGE_FAILED",
  EXPORT_FAILED: "EXPORT_FAILED",
  AUTH_REJECTED: "AUTH_REJECTED",
  NETWORK_TIMEOUT: "NETWORK_TIMEOUT",
  PAGINATION_FAILED: "PAGINATION_FAILED",
  DATABASE_WRITE_FAILED: "DATABASE_WRITE_FAILED",
  COVERAGE_INCOMPLETE: "COVERAGE_INCOMPLETE",
  MONITOR_DELIVERY_FAILED: "MONITOR_DELIVERY_FAILED",
  MONITOR_UNAVAILABLE: "MONITOR_UNAVAILABLE",
} as const;

export type ErrorCode = (typeof CODES)[keyof typeof CODES];

export const COVERAGE = ["complete", "incomplete", "unknown"] as const;
export type Coverage = (typeof COVERAGE)[number];

export type DiagnosticEvent = {
  time: string;
  level: Level;
  event: EventName;
  appVersion: string;
  code?: ErrorCode;
  scanId?: string;
  engineVersion?: string;
  osVersion?: string;
  durationMs?: number;
  requestCount?: number;
  provider?: string;
  stage?: string;
  httpStatus?: number;
  coverage?: Coverage;
  message?: string;
};

export type RuntimeInfo = {
  appVersion: string;
  engineVersion?: string;
  osVersion?: string;
};

export type MonitorProvider = "none" | "http" | "sentry" | "arvan";

export type MonitorConfig = {
  enabled: boolean;
  provider: MonitorProvider;
  endpoint?: string;
  sampleRate: number;
};

export type EventInput = {
  level: Level;
  event: EventName;
  code?: ErrorCode;
  scanId?: string;
  durationMs?: number;
  requestCount?: number;
  provider?: string;
  stage?: string;
  httpStatus?: number;
  coverage?: Coverage;
  message?: string;
  time?: string;
  engineVersion?: string;
  osVersion?: string;
  appVersion?: string;
};

export const JOURNAL_LIMIT = 32;

const EVENT_NAMES = new Set<string>(Object.values(EVENTS));
const ERROR_CODES = new Set<string>(Object.values(CODES));
const COVERAGES = new Set<string>(COVERAGE);

export function isEventName(value: string): value is EventName {
  return EVENT_NAMES.has(value);
}

export function isErrorCode(value: string): value is ErrorCode {
  return ERROR_CODES.has(value);
}

export function isCoverage(value: string): value is Coverage {
  return COVERAGES.has(value);
}

export function isLevel(value: string): value is Level {
  return (LEVELS as readonly string[]).includes(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  return value as Record<string, unknown>;
}

function clampRate(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export function readMonitorConfig(extra: unknown): MonitorConfig {
  const block = asRecord(asRecord(extra)?.observability);
  const provider = block?.provider;
  const known =
    provider === "none" ||
    provider === "http" ||
    provider === "sentry" ||
    provider === "arvan";
  const endpoint =
    typeof block?.endpoint === "string" ? block.endpoint : undefined;
  return {
    enabled: block?.enabled === true,
    provider: known ? provider : "none",
    endpoint: endpoint && /^https:\/\//.test(endpoint) ? endpoint : undefined,
    sampleRate: clampRate(block?.sampleRate, 1),
  };
}

export function disabledMonitorConfig(): MonitorConfig {
  return { enabled: false, provider: "none", sampleRate: 1 };
}
