import type { Database } from "bun:sqlite";
import {
  DurableError,
  ScanEngineControl,
  type JsonValue,
  type ScanEngine,
  type ScanEngineState,
  type Steps,
  type WorkflowParams,
} from "../src/durable/types";

const MAX_STEP_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [1_000, 2_000] as const;
const MAX_RESULT_BYTES = 256 * 1024;

type JobRow = {
  instance_id: string;
  scan_id: string;
  state: "queued" | "running" | "waiting" | "stopped";
  stop_requested: number;
  stop_reason: "complete" | "errored" | "terminated" | null;
};
type StepRow = {
  state:
    "running" | "retry_wait" | "succeeded" | "sleeping" | "complete" | "failed";
  attempts: number;
  retry_at: number | null;
  wake_at: number | null;
  result_version: number | null;
  result_json: string | null;
  error_code: string | null;
};
export type StepObserver = (event: "start" | "finish", name: string) => void;

function terminalState(reason: JobRow["stop_reason"]): ScanEngineState {
  return { kind: "stopped", reason: reason ?? "errored" };
}

export class SqliteScanEngine implements ScanEngine {
  constructor(private readonly database: Database) {}

  async ensure(instanceId: string, params: WorkflowParams) {
    if (instanceId !== `scan-${params.scanId}`)
      throw new DurableError(
        "INVALID_ENGINE_ID",
        "Invalid scan engine id",
        409
      );
    const now = new Date().toISOString();
    this.database
      .prepare(
        `INSERT OR IGNORE INTO vps_scan_jobs
          (instance_id,scan_id,state,ready_at,created_at,updated_at)
         VALUES(?,?,'queued',?,?,?)`
      )
      .run(instanceId, params.scanId, Date.now(), now, now);
    const row = this.database
      .prepare("SELECT scan_id FROM vps_scan_jobs WHERE instance_id=?")
      .get(instanceId) as { scan_id: string } | undefined;
    if (row?.scan_id !== params.scanId)
      throw new DurableError(
        "ENGINE_RESERVATION_CONFLICT",
        "Scan engine reservation conflicts with existing work",
        409
      );
  }

  async inspect(instanceId: string): Promise<ScanEngineState> {
    const row = this.database
      .prepare(
        "SELECT instance_id,scan_id,state,stop_requested,stop_reason FROM vps_scan_jobs WHERE instance_id=?"
      )
      .get(instanceId) as JobRow | undefined;
    if (!row) return { kind: "missing" };
    if (row.state === "queued") return { kind: "queued" };
    if (row.state === "stopped") return terminalState(row.stop_reason);
    return { kind: "active" };
  }

  async terminate(instanceId: string) {
    const now = new Date().toISOString();
    this.database
      .prepare(
        `UPDATE vps_scan_jobs SET
           stop_requested=1,
           state=CASE WHEN state IN ('queued','waiting') THEN 'stopped' ELSE state END,
           stop_reason=CASE WHEN state IN ('queued','waiting') THEN 'terminated' ELSE stop_reason END,
           updated_at=?
         WHERE instance_id=?`
      )
      .run(now, instanceId);
  }

  cancellationRequested(scanId: string) {
    const row = this.database
      .prepare(
        `SELECT j.stop_requested,s.status FROM vps_scan_jobs j
         JOIN scans s ON s.id=j.scan_id WHERE j.scan_id=?`
      )
      .get(scanId) as { stop_requested: number; status: string } | undefined;
    return !row || row.stop_requested === 1 || row.status === "cancelled";
  }
}

export function createPersistentSteps(
  database: Database,
  scanId: string,
  engine: SqliteScanEngine,
  observe: StepObserver = () => undefined
): Steps {
  const checkCancellation = () => {
    if (engine.cancellationRequested(scanId))
      throw new ScanEngineControl("cancelled");
  };

  return {
    async do<T extends JsonValue>(name: string, action: () => Promise<T>) {
      checkCancellation();
      const existing = database
        .prepare(
          `SELECT state,attempts,retry_at,wake_at,result_version,result_json,error_code
           FROM vps_scan_steps WHERE scan_id=? AND step_name=?`
        )
        .get(scanId, name) as StepRow | undefined;
      if (existing?.state === "succeeded") {
        if (existing.result_version !== 1 || existing.result_json === null)
          throw new DurableError(
            "STEP_RESULT_INVALID",
            "Persisted step result is invalid",
            502
          );
        const parsed = JSON.parse(existing.result_json) as {
          version?: number;
          value?: T;
        };
        if (parsed.version !== 1 || !("value" in parsed))
          throw new DurableError(
            "STEP_RESULT_INVALID",
            "Persisted step result is invalid",
            502
          );
        return parsed.value as T;
      }
      if (existing?.state === "failed")
        throw new DurableError(
          existing.error_code ?? "STEP_FAILED",
          "A previous durable step attempt failed"
        );
      if (existing?.state === "sleeping" || existing?.state === "complete")
        throw new DurableError(
          "STEP_STATE_INVALID",
          "Persisted scan step has an incompatible state",
          502
        );
      if (
        existing?.state === "retry_wait" &&
        existing.retry_at !== null &&
        existing.retry_at > Date.now()
      )
        throw new ScanEngineControl(
          "suspended",
          new Date(existing.retry_at).toISOString()
        );

      const attempt = (existing?.attempts ?? 0) + 1;
      if (attempt > MAX_STEP_ATTEMPTS)
        throw new DurableError(
          "STEP_RETRIES_EXHAUSTED",
          "Scan step retry limit was reached"
        );
      const now = new Date().toISOString();
      database
        .prepare(
          `INSERT INTO vps_scan_steps
            (scan_id,step_name,state,attempts,updated_at)
           VALUES(?,?,'running',?,?)
           ON CONFLICT(scan_id,step_name) DO UPDATE SET
             state='running',attempts=excluded.attempts,retry_at=NULL,
             error_code=NULL,updated_at=excluded.updated_at`
        )
        .run(scanId, name, attempt, now);
      observe("start", name);
      try {
        const result = await action();
        checkCancellation();
        const resultJson = JSON.stringify({ version: 1, value: result });
        if (
          !resultJson ||
          Buffer.byteLength(resultJson, "utf8") > MAX_RESULT_BYTES
        )
          throw new DurableError(
            "STEP_RESULT_INVALID",
            "Durable step result is too large or not serializable",
            502
          );
        database
          .prepare(
            `UPDATE vps_scan_steps SET state='succeeded',result_version=1,
               result_json=?,updated_at=? WHERE scan_id=? AND step_name=? AND attempts=?`
          )
          .run(resultJson, new Date().toISOString(), scanId, name, attempt);
        observe("finish", name);
        return result;
      } catch (error) {
        observe("finish", name);
        if (error instanceof ScanEngineControl) throw error;
        const errorCode =
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          typeof error.code === "string"
            ? error.code
            : null;
        if (errorCode) {
          database
            .prepare(
              `UPDATE vps_scan_steps SET state='failed',error_code=?,
                 updated_at=? WHERE scan_id=? AND step_name=? AND attempts=?`
            )
            .run(errorCode, new Date().toISOString(), scanId, name, attempt);
          throw error;
        }
        if (attempt === MAX_STEP_ATTEMPTS) {
          database
            .prepare(
              `UPDATE vps_scan_steps SET state='failed',error_code='STEP_RETRIES_EXHAUSTED',
                 updated_at=? WHERE scan_id=? AND step_name=? AND attempts=?`
            )
            .run(new Date().toISOString(), scanId, name, attempt);
          throw new DurableError(
            "STEP_RETRIES_EXHAUSTED",
            "Scan step retry limit was reached"
          );
        }
        const retryAt = Date.now() + RETRY_DELAYS_MS[attempt - 1]!;
        database
          .prepare(
            `UPDATE vps_scan_steps SET state='retry_wait',retry_at=?,
               updated_at=? WHERE scan_id=? AND step_name=? AND attempts=?`
          )
          .run(retryAt, new Date().toISOString(), scanId, name, attempt);
        throw new ScanEngineControl(
          "suspended",
          new Date(retryAt).toISOString()
        );
      }
    },
    async sleep(name: string, durationMs: number) {
      checkCancellation();
      const existing = database
        .prepare(
          "SELECT state,wake_at FROM vps_scan_steps WHERE scan_id=? AND step_name=?"
        )
        .get(scanId, name) as Pick<StepRow, "state" | "wake_at"> | undefined;
      if (existing?.state === "complete") return;
      if (!existing) {
        const wakeAt = Date.now() + Math.max(0, durationMs);
        database
          .prepare(
            `INSERT INTO vps_scan_steps
              (scan_id,step_name,state,wake_at,updated_at)
             VALUES(?,?,'sleeping',?,?)`
          )
          .run(scanId, name, wakeAt, new Date().toISOString());
        if (wakeAt > Date.now())
          throw new ScanEngineControl(
            "suspended",
            new Date(wakeAt).toISOString()
          );
      } else if (existing.state !== "sleeping" || existing.wake_at === null) {
        throw new DurableError(
          "STEP_STATE_INVALID",
          "Persisted scan sleep has an incompatible state",
          502
        );
      } else if (existing.wake_at > Date.now()) {
        throw new ScanEngineControl(
          "suspended",
          new Date(existing.wake_at).toISOString()
        );
      }
      database
        .prepare(
          `UPDATE vps_scan_steps SET state='complete',wake_at=NULL,updated_at=?
           WHERE scan_id=? AND step_name=? AND state='sleeping'`
        )
        .run(new Date().toISOString(), scanId, name);
    },
  };
}
