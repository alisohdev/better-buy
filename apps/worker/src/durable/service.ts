import type { ScanRecord } from "@better-buy/shared";
import { Store } from "../store";
import type { ScanInput, ScanJob } from "../application/scans";
import { DurableRepository } from "./repository";
import { DurableError, type DurableEnv, type ScanEngineState } from "./types";
import { scanEngineFor } from "../runtime/scan-engine";

type LocalEnv = Pick<
  DurableEnv,
  "DB" | "BOX_KEY" | "SNAPP_STORE_CAMPAIGNS_ENABLED"
> & { SCAN_WORKFLOW_CONCURRENCY?: string };
export async function findStartIntent(
  env: LocalEnv,
  userId: string,
  key: string
) {
  const intent = await env.DB.prepare(
    "SELECT scan_id FROM scan_start_intents WHERE user_id=? AND idempotency_key=?"
  )
    .bind(userId, key)
    .first<{ scan_id: string }>();
  return intent
    ? new Store(env.DB, userId, env.BOX_KEY).scan(intent.scan_id)
    : null;
}
export async function beginLegacyScan(
  env: LocalEnv,
  userId: string,
  input: ScanInput,
  key: string | undefined
): Promise<{ scan: ScanRecord; job: ScanJob | null }> {
  const repo = new DurableRepository(env.DB, env.BOX_KEY);
  const scan = await repo.reserve(
    userId,
    input,
    key,
    env.SNAPP_STORE_CAMPAIGNS_ENABLED === "true",
    "legacy"
  );
  const claim = await env.DB.prepare(
    "UPDATE scan_execution SET dispatch_state='dispatched' WHERE scan_id=? AND user_id=? AND execution_kind='legacy' AND dispatch_state='dispatch_pending' AND EXISTS(SELECT 1 FROM scans WHERE id=? AND status='queued')"
  )
    .bind(scan.id, userId, scan.id)
    .run();
  if (!claim.meta.changes) return { scan, job: null };
  const runtime = await repo.load(scan.id, userId);
  if (!runtime)
    throw new DurableError(
      "PERSISTENCE_ERROR",
      "Start reservation missing",
      502
    );
  const location = await new Store(env.DB, userId, env.BOX_KEY).location(
    scan.locationId
  );
  if (!location)
    throw new DurableError(
      "LOCATION_NOT_FOUND",
      "Location is unavailable",
      404
    );
  const frozen = scan.context!.location;
  return {
    scan,
    job: {
      ...input,
      id: scan.id,
      threshold: scan.threshold,
      requestedThreshold: input.threshold,
      location: {
        ...location,
        name: frozen.name,
        latitude: frozen.latitude,
        longitude: frozen.longitude,
        coordinateRevision: frozen.revision,
      },
      access: null,
    },
  };
}
export async function beginDurableScan(
  env: DurableEnv & LocalEnv,
  userId: string,
  input: ScanInput,
  key: string | undefined
) {
  if (!scanEngineFor(env))
    throw new DurableError(
      "DURABLE_EXECUTION_UNAVAILABLE",
      "Durable execution is unavailable",
      502
    );
  const repo = new DurableRepository(env.DB, env.BOX_KEY);
  const scan = await repo.reserve(
    userId,
    input,
    key,
    env.SNAPP_STORE_CAMPAIGNS_ENABLED === "true",
    "workflow"
  );
  await reconcileDurableScan(env, userId, scan.id);
  return (await new Store(env.DB, userId, env.BOX_KEY).scan(scan.id))!;
}
export async function reconcileDurableScan(
  env: DurableEnv,
  userId: string,
  scanId: string
) {
  const engine = scanEngineFor(env);
  const repo = new DurableRepository(env.DB, env.BOX_KEY),
    job = await repo.load(scanId, userId);
  if (!job) return new Store(env.DB, userId, env.BOX_KEY).scan(scanId);
  if (
    !engine ||
    job.runtime.execution_kind !== "workflow" ||
    (job.scan.status !== "queued" && job.scan.status !== "running")
  )
    return job.scan;
  let state: ScanEngineState;
  try {
    state = await engine.inspect(job.runtime.instance_id);
  } catch (error) {
    console.warn("Durable scan engine status is unavailable", {
      scanId,
      error,
    });
    return job.scan;
  }
  const dispatchExpired = Date.now() > Date.parse(job.runtime.queued_until);
  if (state.kind === "missing" && !dispatchExpired) {
    try {
      await engine.ensure(job.runtime.instance_id, {
        scanId,
        contractVersion: 1,
      });
      await repo.dispatchState(scanId, "dispatched");
      state = await engine.inspect(job.runtime.instance_id);
    } catch (error) {
      console.warn("Durable scan dispatch will be retried", { scanId, error });
    }
  }
  if (
    state.kind === "stopped" ||
    (state.kind === "queued" && dispatchExpired) ||
    (state.kind === "missing" && dispatchExpired)
  ) {
    const current = await repo.load(scanId, userId);
    if (current?.scan.status === "queued" || current?.scan.status === "running")
      await repo.fail(
        scanId,
        state.kind === "stopped" ? "ENGINE_TERMINAL" : "DISPATCH_TIMEOUT"
      );
    if (state.kind === "queued") {
      try {
        await engine.terminate(job.runtime.instance_id);
      } catch {
        /* The durable repository owns the user-visible terminal state. */
      }
    }
  }
  return new Store(env.DB, userId, env.BOX_KEY).scan(scanId);
}
export async function cancelDurableScan(
  env: DurableEnv,
  userId: string,
  scanId: string
) {
  const engine = scanEngineFor(env);
  const repo = new DurableRepository(env.DB, env.BOX_KEY),
    job = await repo.load(scanId, userId);
  if (!job) return null;
  if (job.runtime.execution_kind !== "workflow" || !engine)
    throw new DurableError(
      "CANCEL_UNAVAILABLE",
      "Cancellation is unavailable for this update",
      409
    );
  const changed = await repo.cancel(scanId, userId);
  if (changed) {
    try {
      await engine.terminate(job.runtime.instance_id);
    } catch {
      /* Cooperative writes already reject work. */
    }
  }
  return new Store(env.DB, userId, env.BOX_KEY).scan(scanId);
}
export async function reconcileDurableOperations(env: DurableEnv) {
  if (!scanEngineFor(env)) return;
  let after = "";
  while (true) {
    const { results } = await env.DB.prepare(
      "SELECT e.scan_id,e.user_id FROM scan_execution e JOIN scans s ON s.id=e.scan_id WHERE e.execution_kind='workflow' AND s.status IN ('queued','running') AND e.scan_id>? ORDER BY e.scan_id LIMIT 100"
    )
      .bind(after)
      .all<{ scan_id: string; user_id: string }>();
    if (results.length === 0) return;
    for (const row of results) {
      await reconcileDurableScan(env, row.user_id, row.scan_id);
      after = row.scan_id;
    }
  }
}
