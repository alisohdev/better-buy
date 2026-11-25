import config from "../../app.json";
import { readMonitorConfig } from "./schema.ts";
import { createObservability, type FetchLike } from "./service.ts";

const extra = "extra" in config.expo ? config.expo.extra : undefined;

const fetchImpl: FetchLike = (url, init) => globalThis.fetch(url, init);

export const observability = createObservability({
  runtime: { appVersion: config.expo.version },
  config: readMonitorConfig(extra),
  fetch: fetchImpl,
});

export { createObservability, normalizeEngineLog } from "./service.ts";
export {
  CODES,
  COVERAGE,
  EVENTS,
  JOURNAL_LIMIT,
  LEVELS,
  readMonitorConfig,
} from "./schema.ts";
export type {
  Coverage,
  DiagnosticEvent,
  ErrorCode,
  EventName,
  Level,
  MonitorConfig,
  RuntimeInfo,
} from "./schema.ts";
