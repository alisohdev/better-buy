import { beginDurableScan } from "./durable/service";
import { DurableError } from "./durable/types";
import type { WorkerEnv } from "./http/types";
import { scanEngineFor } from "./runtime/scan-engine";

type Slot = { date: string; name: "morning" | "evening" };
const BUDGET = 8;
const FRESH_MS = 2 * 60 * 60_000;
const SOURCES = ["snappmarket", "okala"] as const;
export type WishlistSource = (typeof SOURCES)[number];
const iso = (date: Date) => date.toISOString();

export function beginWishlistScan(
  env: WorkerEnv,
  input: {
    userId: string;
    locationId: string;
    source: WishlistSource;
    key: string;
  }
) {
  const engine = scanEngineFor(env);
  if (!engine)
    throw new DurableError(
      "DURABLE_EXECUTION_UNAVAILABLE",
      "Durable execution is unavailable",
      502
    );
  return beginDurableScan(
    { ...env, SCAN_ENGINE: engine },
    input.userId,
    {
      locationId: input.locationId,
      source: input.source,
      threshold: input.source === "okala" ? 30 : 40,
      mode: "full",
    },
    input.key
  );
}

export function tehranSlot(at: Date): Slot | null {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tehran",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const val = (type: string) => parts.find((part) => part.type === type)!.value;
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Tehran",
      hour: "2-digit",
      hourCycle: "h23",
    }).format(at)
  );
  const minute = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Tehran",
      minute: "2-digit",
    }).format(at)
  );
  if (minute !== 0 && minute !== 30) return null;
  if (hour === 9 && minute === 0)
    return {
      date: `${val("year")}-${val("month")}-${val("day")}`,
      name: "morning",
    };
  if (hour === 18 && minute === 0)
    return {
      date: `${val("year")}-${val("month")}-${val("day")}`,
      name: "evening",
    };
  return null;
}

async function idempotencyKey(
  user: string,
  date: string,
  slot: string,
  source: string
) {
  const bytes = new TextEncoder().encode(
    `${user}\0${date}\0${slot}\0${source}`
  );
  const hash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", bytes)
  ).slice(0, 16);
  hash[6] = ((hash[6] ?? 0) & 0x0f) | 0x50;
  hash[8] = ((hash[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...hash].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function runWishlistSchedule(
  env: WorkerEnv,
  scheduledTime: number | Date
) {
  const engine = scanEngineFor(env);
  if (env.WISHLIST_SCHEDULE_ENABLED !== "true" || !engine) return;
  const at =
    scheduledTime instanceof Date ? scheduledTime : new Date(scheduledTime);
  if (!Number.isFinite(at.getTime())) return;
  const now = new Date();
  const db = env.DB;
  const dueSlot = tehranSlot(at);
  const freshSince = iso(new Date(now.getTime() - FRESH_MS));
  if (dueSlot && Math.abs(now.getTime() - at.getTime()) <= 5 * 60_000) {
    await db
      .prepare(
        `INSERT OR IGNORE INTO wishlist_scan_schedule
      (user_id,schedule_date,schedule_slot,location_id,location_revision,latitude,longitude,created_at)
     SELECT p.user_id,?,?,l.id,l.coordinate_revision,l.latitude,l.longitude,?
     FROM wishlist_preferences p JOIN locations l ON l.id=p.default_location_id AND l.user_id=p.user_id
     WHERE EXISTS(SELECT 1 FROM wishlist_items i WHERE i.user_id=p.user_id)`
      )
      .bind(dueSlot.date, dueSlot.name, iso(at))
      .run();
    await db
      .prepare(
        `INSERT OR IGNORE INTO wishlist_scan_schedule_jobs
      (user_id,schedule_date,schedule_slot,source,retry_after,updated_at)
     SELECT user_id,schedule_date,schedule_slot,?, ?, ? FROM wishlist_scan_schedule
     WHERE schedule_date=? AND schedule_slot=?`
      )
      .bind(SOURCES[0], iso(now), iso(now), dueSlot.date, dueSlot.name)
      .run();
    await db
      .prepare(
        `INSERT OR IGNORE INTO wishlist_scan_schedule_jobs
      (user_id,schedule_date,schedule_slot,source,retry_after,updated_at)
     SELECT user_id,schedule_date,schedule_slot,?, ?, ? FROM wishlist_scan_schedule
     WHERE schedule_date=? AND schedule_slot=?`
      )
      .bind(SOURCES[1], iso(now), iso(now), dueSlot.date, dueSlot.name)
      .run();
  }
  await db
    .prepare(
      `UPDATE wishlist_scan_schedule_jobs SET state='pending',retry_after=?,updated_at=?
     WHERE state='running' AND updated_at<? AND EXISTS (
       SELECT 1 FROM wishlist_scan_schedule s WHERE s.user_id=wishlist_scan_schedule_jobs.user_id
       AND s.schedule_date=wishlist_scan_schedule_jobs.schedule_date
       AND s.schedule_slot=wishlist_scan_schedule_jobs.schedule_slot AND s.created_at>=?)`
    )
    .bind(
      iso(now),
      iso(now),
      iso(new Date(now.getTime() - 2 * 60_000)),
      freshSince
    )
    .run();
  await db
    .prepare(
      `UPDATE wishlist_scan_schedule_jobs SET state='skipped',last_error='schedule_expired',updated_at=?
     WHERE state IN ('pending','running') AND EXISTS (
       SELECT 1 FROM wishlist_scan_schedule s WHERE s.user_id=wishlist_scan_schedule_jobs.user_id
       AND s.schedule_date=wishlist_scan_schedule_jobs.schedule_date
       AND s.schedule_slot=wishlist_scan_schedule_jobs.schedule_slot AND s.created_at<?)`
    )
    .bind(iso(now), freshSince)
    .run();

  for (let n = 0; n < BUDGET; n++) {
    const job = await db
      .prepare(
        `SELECT j.user_id,j.schedule_date,j.schedule_slot,j.source,j.attempts,s.location_id,s.location_revision,s.latitude,s.longitude
       FROM wishlist_scan_schedule_jobs j JOIN wishlist_scan_schedule s USING(user_id,schedule_date,schedule_slot)
       WHERE j.state='pending' AND j.retry_after<=? AND s.created_at>=?
       ORDER BY j.attempts,j.retry_after,j.user_id,j.schedule_date,j.schedule_slot,j.source LIMIT 1`
      )
      .bind(iso(new Date()), freshSince)
      .first<{
        user_id: string;
        schedule_date: string;
        schedule_slot: string;
        source: "snappmarket" | "okala";
        attempts: number;
        location_id: string;
        location_revision: number;
        latitude: number;
        longitude: number;
      }>();
    if (!job) break;
    const claimed = await db
      .prepare(
        `UPDATE wishlist_scan_schedule_jobs SET state='running',attempts=attempts+1,updated_at=?
       WHERE user_id=? AND schedule_date=? AND schedule_slot=? AND source=? AND state='pending'`
      )
      .bind(
        iso(new Date()),
        job.user_id,
        job.schedule_date,
        job.schedule_slot,
        job.source
      )
      .run();
    if (!claimed.meta.changes) continue;
    try {
      const location = await db
        .prepare(
          "SELECT 1 FROM locations WHERE id=? AND user_id=? AND coordinate_revision=? AND latitude=? AND longitude=?"
        )
        .bind(
          job.location_id,
          job.user_id,
          job.location_revision,
          job.latitude,
          job.longitude
        )
        .first();
      const pref = await db
        .prepare(
          "SELECT 1 FROM wishlist_preferences WHERE user_id=? AND default_location_id=?"
        )
        .bind(job.user_id, job.location_id)
        .first();
      if (!location || !pref) {
        await finish(db, job, "skipped", null, "default_location_changed");
        continue;
      }
      const scan = await beginWishlistScan(
        { ...env, SCAN_ENGINE: engine },
        {
          userId: job.user_id,
          locationId: job.location_id,
          source: job.source,
          key: await idempotencyKey(
            job.user_id,
            job.schedule_date,
            job.schedule_slot,
            job.source
          ),
        }
      );
      await finish(db, job, "done", scan.id, null);
    } catch (error) {
      const code =
        typeof error === "object" && error && "code" in error
          ? String(error.code)
          : "DISPATCH_ERROR";
      const retryable = [
        "SCAN_IN_PROGRESS",
        "ACTIVE_SCAN_EXISTS",
        "SCAN_CAPACITY",
        "SCAN_CAPACITY_REACHED",
        "CONCURRENCY_LIMIT",
        "GLOBAL_CONCURRENCY_LIMIT",
        "DISPATCH_ERROR",
        "PERSISTENCE_ERROR",
      ].includes(code);
      if (retryable) {
        const delay = Math.min(
          10 * 60_000,
          30_000 * 2 ** Math.min(5, job.attempts)
        );
        await db
          .prepare(
            `UPDATE wishlist_scan_schedule_jobs SET state='pending',retry_after=?,last_error=?,updated_at=?
           WHERE user_id=? AND schedule_date=? AND schedule_slot=? AND source=? AND state='running'`
          )
          .bind(
            iso(new Date(Date.now() + delay)),
            code.slice(0, 100),
            iso(new Date()),
            job.user_id,
            job.schedule_date,
            job.schedule_slot,
            job.source
          )
          .run();
        continue;
      }
      await finish(db, job, "skipped", null, code.slice(0, 100));
    }
  }
}

async function finish(
  db: D1Database,
  job: {
    user_id: string;
    schedule_date: string;
    schedule_slot: string;
    source: string;
  },
  state: "done" | "skipped",
  scanId: string | null,
  error: string | null
) {
  await db
    .prepare(
      `UPDATE wishlist_scan_schedule_jobs SET state=?,scan_id=?,last_error=?,updated_at=?
     WHERE user_id=? AND schedule_date=? AND schedule_slot=? AND source=?`
    )
    .bind(
      state,
      scanId,
      error,
      iso(new Date()),
      job.user_id,
      job.schedule_date,
      job.schedule_slot,
      job.source
    )
    .run();
}
