import { requireOptionalNativeModule } from "expo";
import { openDatabaseAsync } from "expo-sqlite";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";
import { Platform } from "react-native";
import config from "../app.json";
import {
  CODES,
  EVENTS,
  type DiagnosticEvent,
  observability,
  readMonitorConfig,
} from "./observability";

type Snapshot = {
  id: string;
  state: "idle" | "running" | "cancelled" | "complete";
  progress: number;
  durationMs: number;
  requests: number;
  offers?: { key: string; price: number }[];
};

type Engine = {
  version(): Promise<string>;
  start(): Promise<string>;
  cancel(): Promise<void>;
  status(): Promise<string>;
  logs(): Promise<string>;
  controlledError(): Promise<string>;
};

const engine = requireOptionalNativeModule<Engine>("BetterBuyEngine");
const appVersion = config.expo.version;
let database: ReturnType<typeof openStore> | undefined;
let readFailureNoted = false;
let journalHydrated = false;
let mirrorAttached = false;
const seenTransitions = new Set<string>();

export function getPersistenceEvents() {
  return observability
    .list()
    .filter((event) => event.event === EVENTS.fixturePersisted)
    .map((event) => ({
      scanId: event.scanId ?? "",
      event: event.event,
      durationMs: event.durationMs ?? 0,
    }));
}

async function openStore() {
  const db = await openDatabaseAsync("engine-lab.db");
  await db.execAsync(
    "CREATE TABLE IF NOT EXISTS last_fixture (slot INTEGER PRIMARY KEY CHECK (slot = 1), snapshot TEXT NOT NULL)"
  );
  await db.execAsync(
    "CREATE TABLE IF NOT EXISTS diagnostic_event (id INTEGER PRIMARY KEY AUTOINCREMENT, record TEXT NOT NULL)"
  );
  return db;
}

function store() {
  return (database ??= openStore());
}

function osVersion() {
  return Platform.OS === "android"
    ? `android ${String(Platform.Version)}`
    : Platform.OS;
}

async function mirror(event: DiagnosticEvent) {
  if (event.code === CODES.DATABASE_WRITE_FAILED) return;
  try {
    const db = await store();
    await db.runAsync(
      "INSERT INTO diagnostic_event (record) VALUES (?)",
      JSON.stringify(event)
    );
    await db.runAsync(
      "DELETE FROM diagnostic_event WHERE id NOT IN (SELECT id FROM diagnostic_event ORDER BY id DESC LIMIT 32)"
    );
  } catch {
    observability.databaseWriteFailed({
      scanId: event.scanId,
      stage: "diagnostic-log",
    });
  }
}

function useCoordinator() {
  const [version, setVersion] = useState("");
  const [status, setStatus] = useState<Snapshot>();
  const [saved, setSaved] = useState<Snapshot>();
  const [code, setCode] = useState("");
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (!mirrorAttached) {
      mirrorAttached = true;
      observability.subscribe((event) => {
        void mirror(event);
      });
    }
    async function initialize(native: Engine) {
      const db = await store();
      if (!journalHydrated) {
        journalHydrated = true;
        try {
          const stored = await db.getAllAsync<{ record: string }>(
            "SELECT record FROM diagnostic_event ORDER BY id ASC"
          );
          const parsed: unknown[] = [];
          for (const row of stored) {
            try {
              parsed.push(JSON.parse(row.record));
            } catch {
              continue;
            }
          }
          observability.hydrate(parsed);
        } catch {
          observability.databaseWriteFailed({ stage: "diagnostic-log" });
        }
      }
      const row = await db.getFirstAsync<{ snapshot: string }>(
        "SELECT snapshot FROM last_fixture WHERE slot = 1"
      );
      let persistedId = "";
      const currentVersion = await native.version();
      if (stopped) return;
      observability.configure({
        runtime: {
          appVersion,
          engineVersion: currentVersion,
          osVersion: osVersion(),
        },
        monitor: readMonitorConfig(config.expo.extra),
      });
      if (row) {
        const restored: Snapshot = JSON.parse(row.snapshot);
        persistedId = restored.id;
        setSaved(restored);
      }
      setVersion(currentVersion);
      function noteTransition(next: Snapshot) {
        if (!/^[0-9a-f]{32}$/.test(next.id)) return;
        const transition = `${next.id}:${next.state}`;
        if (seenTransitions.has(transition) || next.state === "idle") return;
        seenTransitions.add(transition);
        if (seenTransitions.size > 96) {
          const oldest = seenTransitions.values().next().value;
          if (oldest) seenTransitions.delete(oldest);
        }
        const common = {
          scanId: next.id,
          provider: "fixture",
          stage: "fixture",
          durationMs: next.durationMs,
          requestCount: next.requests,
        };
        if (next.state === "running") observability.scanStarted(common);
        if (next.state === "cancelled") observability.scanCancelled(common);
        if (next.state === "complete") {
          observability.scanCompleted({ ...common, coverage: "complete" });
        }
      }
      async function poll() {
        if (stopped) return;
        try {
          const next: Snapshot = JSON.parse(await native.status());
          noteTransition(next);
          if (next.state === "complete" && next.id !== persistedId) {
            const started = performance.now();
            try {
              await db.runAsync(
                "INSERT OR REPLACE INTO last_fixture (slot, snapshot) VALUES (1, ?)",
                JSON.stringify(next)
              );
              observability.fixturePersisted({
                scanId: next.id,
                durationMs: Math.round(performance.now() - started),
                stage: "persist",
              });
              persistedId = next.id;
              if (!stopped) setSaved(next);
            } catch {
              observability.databaseWriteFailed({
                scanId: next.id,
                stage: "persist",
              });
              if (!stopped) setCode(CODES.DATABASE_WRITE_FAILED);
            }
          }
          if (!stopped) {
            setStatus(next);
            setReady(true);
            readFailureNoted = false;
          }
        } catch {
          if (!stopped) setCode(CODES.DIAGNOSTICS_READ_FAILED);
          if (!readFailureNoted) {
            readFailureNoted = true;
            observability.record({
              level: "ERROR",
              event: EVENTS.lifecycle,
              code: CODES.DIAGNOSTICS_READ_FAILED,
              message: "status read failed",
            });
          }
        } finally {
          if (!stopped) timer = setTimeout(() => void poll(), 100);
        }
      }
      await poll();
    }
    if (engine) {
      void initialize(engine).catch(() => {
        if (stopped) return;
        setCode(CODES.DIAGNOSTICS_INIT_FAILED);
        observability.record({
          level: "ERROR",
          event: EVENTS.lifecycle,
          code: CODES.DIAGNOSTICS_INIT_FAILED,
          message: "diagnostics init failed",
        });
      });
    } else {
      observability.configure({
        runtime: { appVersion, osVersion: osVersion() },
        monitor: readMonitorConfig(config.expo.extra),
      });
      observability.record({
        level: "WARN",
        event: EVENTS.lifecycle,
        code: CODES.ENGINE_UNAVAILABLE,
        message: "native engine module unavailable",
      });
    }
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);

  async function act(fn: (native: Engine) => Promise<void>) {
    if (!engine) return;
    setPending(true);
    setCode("");
    try {
      await fn(engine);
    } catch {
      setCode(CODES.NATIVE_BRIDGE_FAILED);
      observability.record({
        level: "ERROR",
        event: EVENTS.lifecycle,
        code: CODES.NATIVE_BRIDGE_FAILED,
        message: "native bridge call failed",
      });
    } finally {
      setPending(false);
    }
  }

  return {
    appVersion,
    available: Boolean(engine),
    version,
    status,
    saved,
    code,
    setCode,
    ready,
    pending,
    act,
  };
}

const DiagnosticsContext = createContext<ReturnType<
  typeof useCoordinator
> | null>(null);

export function DiagnosticsProvider({ children }: { children: ReactNode }) {
  return (
    <DiagnosticsContext.Provider value={useCoordinator()}>
      {children}
    </DiagnosticsContext.Provider>
  );
}

export function useDiagnostics() {
  const state = useContext(DiagnosticsContext);
  if (!state) throw new Error("Diagnostics provider is unavailable");
  return state;
}
