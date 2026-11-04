import { fileURLToPath } from "node:url";
import { DurableRepository } from "../src/durable/repository";
import { reconcileDurableOperations } from "../src/durable/service";
import { processWishlistNotifications } from "../src/wishlist";
import { cleanupOkalaOfferCache } from "../src/providers/okala/sharedOffers";
import { cleanupRateLimits } from "../src/http/rateLimit";
import { runWishlistSchedule } from "../src/wishlist-scheduler";
import { loadVpsConfig } from "./config";
import { createWorkerEnv } from "./environment";
import { SqliteScanEngine } from "./scan-engine";
import { SqliteD1Database } from "./sqlite-d1";

const RECONCILE_INTERVAL_MS = 60_000;
const SCHEDULE_INTERVAL_MS = 60_000;
const MAINTENANCE_INTERVAL_MS = 5 * 60_000;
const STEP_TIMEOUT_MS = 60_000;
const SCAN_IDLE_TIMEOUT_MS = 5 * 60_000;
const MAX_WORKER_FAILURES = 3;
const RETRY_DELAYS_MS = [1_000, 2_000] as const;

type ChildOutcome =
  | { kind: "complete" }
  | { kind: "suspended"; wakeAt: string }
  | { kind: "cancelled" }
  | { kind: "failed"; code: string };
type ClaimedJob = { instance_id: string; scan_id: string };
type ChildResult = {
  outcome?: ChildOutcome;
  timeoutStep?: string;
  idleTimeout?: boolean;
  exitCode: number | null;
};
type ScanSubprocess = ReturnType<typeof Bun.spawn>;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const iso = (at: number) => new Date(at).toISOString();
const errorKind = (error: unknown) =>
  error instanceof Error ? error.name : "UnknownError";

function setStopped(
  database: SqliteD1Database,
  job: ClaimedJob,
  reason: "complete" | "errored" | "terminated"
) {
  database.native
    .prepare(
      `UPDATE vps_scan_jobs SET state='stopped',stop_reason=?,owner_boot_id=NULL,
         updated_at=? WHERE instance_id=?`
    )
    .run(reason, new Date().toISOString(), job.instance_id);
}

function queueForRetry(
  database: SqliteD1Database,
  job: ClaimedJob,
  readyAt: number,
  failures = 0
) {
  database.native
    .prepare(
      `UPDATE vps_scan_jobs SET state='waiting',ready_at=?,owner_boot_id=NULL,
         worker_failures=?,updated_at=? WHERE instance_id=?`
    )
    .run(readyAt, failures, new Date().toISOString(), job.instance_id);
}

async function runMaintenanceTick(
  database: SqliteD1Database,
  task: string,
  scheduledAt: number,
  operation: () => Promise<unknown>
) {
  const timestamp = iso(scheduledAt);
  database.native
    .prepare(
      `INSERT OR IGNORE INTO vps_maintenance_ticks(task,scheduled_at,state,updated_at)
       VALUES(?,?,'running',?)`
    )
    .run(task, timestamp, new Date().toISOString());
  const row = database.native
    .prepare(
      "SELECT state FROM vps_maintenance_ticks WHERE task=? AND scheduled_at=?"
    )
    .get(task, timestamp) as { state: string };
  if (row.state === "complete") return;
  database.native
    .prepare(
      `UPDATE vps_maintenance_ticks SET state='running',updated_at=?
       WHERE task=? AND scheduled_at=?`
    )
    .run(new Date().toISOString(), task, timestamp);
  try {
    await operation();
    database.native
      .prepare(
        `UPDATE vps_maintenance_ticks SET state='complete',updated_at=?
         WHERE task=? AND scheduled_at=?`
      )
      .run(new Date().toISOString(), task, timestamp);
  } catch (error) {
    database.native
      .prepare(
        `UPDATE vps_maintenance_ticks SET state='failed',updated_at=?
         WHERE task=? AND scheduled_at=?`
      )
      .run(new Date().toISOString(), task, timestamp);
    console.error("VPS maintenance task failed", {
      task,
      error: errorKind(error),
    });
  }
}

async function maintenanceLoop(
  database: SqliteD1Database,
  env: ReturnType<typeof createWorkerEnv>,
  stopping: () => boolean
) {
  let nextReconcile = 0;
  let nextSchedule = 0;
  let nextMaintenance = 0;
  while (!stopping()) {
    const now = Date.now();
    if (now >= nextReconcile) {
      const bucket =
        Math.floor(now / RECONCILE_INTERVAL_MS) * RECONCILE_INTERVAL_MS;
      await runMaintenanceTick(database, "scan-reconciliation", bucket, () =>
        reconcileDurableOperations(env)
      );
      nextReconcile = now + RECONCILE_INTERVAL_MS;
    }
    if (now >= nextSchedule) {
      try {
        await runWishlistSchedule(env, now);
      } catch (error) {
        console.error("VPS wishlist schedule failed", {
          error: errorKind(error),
        });
      }
      nextSchedule = now + SCHEDULE_INTERVAL_MS;
    }
    if (now >= nextMaintenance) {
      const bucket =
        Math.floor(now / MAINTENANCE_INTERVAL_MS) * MAINTENANCE_INTERVAL_MS;
      await runMaintenanceTick(database, "wishlist-notifications", bucket, () =>
        processWishlistNotifications(env)
      );
      await runMaintenanceTick(database, "okala-offer-cache", bucket, () =>
        cleanupOkalaOfferCache(env.DB)
      );
      if (env.API_RATE_LIMITS_ENABLED === "true")
        await runMaintenanceTick(database, "rate-limit-cleanup", bucket, () =>
          cleanupRateLimits(env.DB)
        );
      await runMaintenanceTick(
        database,
        "vps-tick-cleanup",
        bucket,
        async () => {
          database.native
            .prepare(
              "DELETE FROM vps_maintenance_ticks WHERE updated_at < datetime('now','-14 days')"
            )
            .run();
        }
      );
      nextMaintenance = now + MAINTENANCE_INTERVAL_MS;
    }
    await pause(1_000);
  }
}

async function recoverInterruptedJobs(
  database: SqliteD1Database,
  repository: DurableRepository,
  bootId: string
) {
  const interrupted = database.native
    .prepare(
      `SELECT instance_id,scan_id,worker_failures FROM vps_scan_jobs
       WHERE state='running' ORDER BY created_at`
    )
    .all() as (ClaimedJob & { worker_failures: number })[];
  const now = Date.now();
  for (const job of interrupted) {
    const state = database.native
      .prepare("SELECT status FROM scans WHERE id=?")
      .get(job.scan_id) as { status: string } | undefined;
    if (state?.status === "cancelled") {
      setStopped(database, job, "terminated");
      continue;
    }
    if (state?.status === "succeeded" || state?.status === "failed") {
      setStopped(database, job, "complete");
      continue;
    }
    const failures = job.worker_failures + 1;
    if (failures >= MAX_WORKER_FAILURES) {
      await repository.fail(job.scan_id, "ENGINE_RESTART_EXHAUSTED");
      setStopped(database, job, "errored");
      continue;
    }
    database.native
      .prepare(
        `UPDATE vps_scan_jobs SET state='queued',ready_at=?,owner_boot_id=NULL,
           worker_failures=?,updated_at=? WHERE instance_id=?`
      )
      .run(now, failures, new Date().toISOString(), job.instance_id);
  }
  database.native
    .prepare(
      `UPDATE vps_scan_jobs SET state='queued',updated_at=?
       WHERE state='waiting' AND ready_at<=? AND stop_requested=0`
    )
    .run(new Date().toISOString(), now);
  database.native
    .prepare(
      `UPDATE vps_scan_jobs SET state='stopped',stop_reason='terminated',updated_at=?
       WHERE stop_requested=1 AND state IN ('queued','waiting')`
    )
    .run(new Date().toISOString());
  database.native
    .prepare(
      "UPDATE vps_scan_jobs SET owner_boot_id=NULL WHERE state<>'running'"
    )
    .run();
  console.info("VPS scan worker recovered prior process state", {
    bootId,
    interrupted: interrupted.length,
  });
}

function claimNextJob(
  database: SqliteD1Database,
  bootId: string
): ClaimedJob | undefined {
  const claim = database.native.transaction(() => {
    const now = Date.now();
    database.native
      .prepare(
        `UPDATE vps_scan_jobs SET state='queued',updated_at=?
         WHERE state='waiting' AND ready_at<=? AND stop_requested=0`
      )
      .run(new Date().toISOString(), now);
    database.native
      .prepare(
        `UPDATE vps_scan_jobs SET state='stopped',stop_reason='terminated',updated_at=?
         WHERE stop_requested=1 AND state IN ('queued','waiting')`
      )
      .run(new Date().toISOString());
    const row = database.native
      .prepare(
        `SELECT instance_id,scan_id FROM vps_scan_jobs
         WHERE state='queued' AND ready_at<=? AND stop_requested=0
         ORDER BY ready_at,created_at LIMIT 1`
      )
      .get(now) as ClaimedJob | undefined;
    if (!row) return undefined;
    const updated = database.native
      .prepare(
        `UPDATE vps_scan_jobs SET state='running',owner_boot_id=?,updated_at=?
         WHERE instance_id=? AND state='queued' AND stop_requested=0`
      )
      .run(bootId, new Date().toISOString(), row.instance_id);
    return updated.changes === 1 ? row : undefined;
  });
  return claim.immediate();
}

function runScanChild(
  job: ClaimedJob,
  engine: SqliteScanEngine,
  setActiveChild: (child: ScanSubprocess | undefined) => void
): Promise<ChildResult> {
  const childPath = fileURLToPath(new URL("./scan-child.ts", import.meta.url));
  let outcome: ChildOutcome | undefined;
  let activeStep: string | undefined;
  let timeoutStep: string | undefined;
  let idleTimeout = false;
  let child: ScanSubprocess;
  let idleTimer: NodeJS.Timeout | undefined;
  let stepTimer: NodeJS.Timeout | undefined;

  const clearStepTimer = () => {
    if (stepTimer) clearTimeout(stepTimer);
    stepTimer = undefined;
  };
  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimeout = true;
      child.kill("SIGKILL");
    }, SCAN_IDLE_TIMEOUT_MS);
  };
  const onChildMessage = (value: unknown) => {
    if (typeof value !== "object" || value === null || !("kind" in value))
      return;
    if (
      value.kind === "step-start" &&
      "name" in value &&
      typeof value.name === "string"
    ) {
      activeStep = value.name;
      resetIdleTimer();
      clearStepTimer();
      stepTimer = setTimeout(() => {
        timeoutStep = activeStep;
        child.kill("SIGKILL");
      }, STEP_TIMEOUT_MS);
    } else if (value.kind === "step-finish") {
      activeStep = undefined;
      resetIdleTimer();
      clearStepTimer();
    } else if (
      value.kind === "outcome" &&
      "outcome" in value &&
      typeof value.outcome === "object" &&
      value.outcome !== null
    ) {
      outcome = value.outcome as ChildOutcome;
    }
  };

  try {
    child = Bun.spawn([process.execPath, childPath, job.scan_id], {
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
      ipc: onChildMessage,
    });
  } catch (error) {
    console.warn("Unable to start VPS scan child", {
      scanId: job.scan_id,
      error: errorKind(error),
    });
    return Promise.resolve({
      outcome,
      timeoutStep,
      idleTimeout,
      exitCode: null,
    });
  }

  setActiveChild(child);
  resetIdleTimer();
  const cancelPoll = setInterval(() => {
    if (engine.cancellationRequested(job.scan_id)) child.kill("SIGTERM");
  }, 500);

  return child.exited
    .then(
      (exitCode) => ({
        outcome,
        timeoutStep,
        idleTimeout,
        exitCode: child.signalCode === null ? exitCode : null,
      }),
      () => ({ outcome, timeoutStep, idleTimeout, exitCode: null })
    )
    .finally(() => {
      if (idleTimer) clearTimeout(idleTimer);
      clearStepTimer();
      clearInterval(cancelPoll);
      setActiveChild(undefined);
    });
}

async function handleStepTimeout(
  database: SqliteD1Database,
  repository: DurableRepository,
  job: ClaimedJob,
  stepName: string
) {
  const row = database.native
    .prepare(
      "SELECT attempts FROM vps_scan_steps WHERE scan_id=? AND step_name=?"
    )
    .get(job.scan_id, stepName) as { attempts: number } | undefined;
  if (!row) {
    repository.fail(job.scan_id, "ENGINE_TIMEOUT");
    setStopped(database, job, "errored");
    return;
  }
  if (row.attempts >= MAX_WORKER_FAILURES) {
    database.native
      .prepare(
        `UPDATE vps_scan_steps SET state='failed',error_code='STEP_TIMEOUT',updated_at=?
         WHERE scan_id=? AND step_name=?`
      )
      .run(new Date().toISOString(), job.scan_id, stepName);
    repository.fail(job.scan_id, "STEP_TIMEOUT");
    setStopped(database, job, "errored");
    return;
  }
  const retryAt = Date.now() + RETRY_DELAYS_MS[row.attempts - 1]!;
  database.native
    .prepare(
      `UPDATE vps_scan_steps SET state='retry_wait',retry_at=?,error_code='STEP_TIMEOUT',updated_at=?
       WHERE scan_id=? AND step_name=?`
    )
    .run(retryAt, new Date().toISOString(), job.scan_id, stepName);
  queueForRetry(database, job, retryAt);
}

async function finishJob(
  database: SqliteD1Database,
  repository: DurableRepository,
  engine: SqliteScanEngine,
  job: ClaimedJob,
  result: ChildResult,
  stopping: boolean
) {
  if (stopping) {
    database.native
      .prepare(
        `UPDATE vps_scan_jobs SET state='queued',ready_at=?,owner_boot_id=NULL,updated_at=?
         WHERE instance_id=? AND state='running'`
      )
      .run(Date.now(), new Date().toISOString(), job.instance_id);
    return;
  }
  if (engine.cancellationRequested(job.scan_id)) {
    setStopped(database, job, "terminated");
    return;
  }
  if (result.timeoutStep) {
    await handleStepTimeout(database, repository, job, result.timeoutStep);
    return;
  }
  if (result.idleTimeout) {
    repository.fail(job.scan_id, "ENGINE_TIMEOUT");
    setStopped(database, job, "errored");
    return;
  }
  if (result.outcome?.kind === "suspended") {
    const readyAt = Date.parse(result.outcome.wakeAt);
    if (!Number.isFinite(readyAt)) {
      repository.fail(job.scan_id, "ENGINE_CONTROL_INVALID");
      setStopped(database, job, "errored");
    } else {
      queueForRetry(database, job, readyAt);
    }
    return;
  }
  if (result.outcome?.kind === "cancelled") {
    setStopped(database, job, "terminated");
    return;
  }
  if (result.outcome?.kind === "complete") {
    database.native
      .prepare(
        `UPDATE vps_scan_jobs SET state='stopped',stop_reason='complete',
           worker_failures=0,owner_boot_id=NULL,updated_at=? WHERE instance_id=?`
      )
      .run(new Date().toISOString(), job.instance_id);
    return;
  }
  if (result.outcome?.kind === "failed") {
    repository.fail(job.scan_id, result.outcome.code);
    setStopped(database, job, "errored");
    return;
  }
  const failures =
    (
      database.native
        .prepare(
          "SELECT worker_failures FROM vps_scan_jobs WHERE instance_id=?"
        )
        .get(job.instance_id) as { worker_failures: number } | undefined
    )?.worker_failures ?? 0;
  const nextFailure = failures + 1;
  if (nextFailure >= MAX_WORKER_FAILURES) {
    repository.fail(job.scan_id, "ENGINE_RESTART_EXHAUSTED");
    setStopped(database, job, "errored");
  } else {
    queueForRetry(
      database,
      job,
      Date.now() + RETRY_DELAYS_MS[nextFailure - 1]!,
      nextFailure
    );
  }
}

async function scanLoop(
  database: SqliteD1Database,
  repository: DurableRepository,
  engine: SqliteScanEngine,
  bootId: string,
  stopping: () => boolean,
  setActiveChild: (child: ScanSubprocess | undefined) => void
) {
  while (!stopping()) {
    const job = claimNextJob(database, bootId);
    if (!job) {
      await pause(500);
      continue;
    }
    const result = await runScanChild(job, engine, setActiveChild);
    await finishJob(database, repository, engine, job, result, stopping());
  }
}

async function main() {
  const config = loadVpsConfig();
  const database = new SqliteD1Database(config.databasePath);
  const env = createWorkerEnv(config, database);
  const engine = env.SCAN_ENGINE as SqliteScanEngine;
  const repository = new DurableRepository(env.DB, env.BOX_KEY);
  const bootId = crypto.randomUUID();
  let stopping = false;
  let activeChild: ScanSubprocess | undefined;
  const setActiveChild = (child: ScanSubprocess | undefined) => {
    activeChild = child;
    if (stopping) child?.kill("SIGTERM");
  };
  const stop = () => {
    stopping = true;
    activeChild?.kill("SIGTERM");
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    await recoverInterruptedJobs(database, repository, bootId);
    await reconcileDurableOperations(env);
    await Promise.all([
      scanLoop(
        database,
        repository,
        engine,
        bootId,
        () => stopping,
        setActiveChild
      ),
      maintenanceLoop(database, env, () => stopping),
    ]);
  } finally {
    activeChild?.kill("SIGTERM");
    database.close();
  }
}

void main().catch((error) => {
  console.error("VPS scan worker stopped unexpectedly", {
    error: errorKind(error),
  });
  process.exitCode = 1;
});
