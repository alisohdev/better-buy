import { Effect, Exit } from "effect";
import {
  groupDeals,
  groupDealsV2,
  scanInputSchema,
  type DealRecord,
} from "@better-buy/shared";
import { executeScan } from "../application/scans";
import { scanServices } from "../composition";
import {
  beginDurableScan,
  beginLegacyScan,
  findStartIntent,
  cancelDurableScan,
  reconcileDurableScan,
} from "../durable/service";
import { DurableError } from "../durable/repository";
import { scanEngineFor } from "../runtime/scan-engine";
import { readScanHistory, HistoryInputError } from "./history";
import { Store } from "../store";
import type { Api, WorkerEnv } from "./types";
async function startErrorBody(
  env: Pick<WorkerEnv, "DB" | "BOX_KEY">,
  userId: string,
  error: DurableError
) {
  const store = new Store(env.DB, userId, env.BOX_KEY);
  const active =
    error.code === "ACTIVE_SCAN_EXISTS" || error.code === "SCAN_IN_PROGRESS"
      ? await store.activeScan()
      : null;
  return {
    error: error.code,
    message: error.message,
    ...(active ? { activeScan: await store.scan(active.id) } : {}),
  };
}
// V1 clients retain their original three-state vocabulary.
const legacyDeals = (deals: DealRecord[]) =>
  deals.map((deal) =>
    deal.state === "current"
      ? { ...deal, state: "still_available" as const }
      : deal
  );
export function registerScans(api: Api) {
  api.get("/api/scans", async (c) => {
    const intent = c.req.query("intent");
    if (intent !== undefined) {
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          intent
        )
      )
        return c.json({ error: "INVALID_IDEMPOTENCY_KEY" }, 400);
      const record = await findStartIntent(c.env, c.get("userId"), intent);
      return c.json({ data: record ? [record] : [] });
    }
    if (
      ["locationId", "source", "cursor", "limit"].some(
        (key) => c.req.query(key) !== undefined
      )
    ) {
      try {
        const page = await readScanHistory(
          c.env.DB,
          c.get("userId"),
          c.env.BOX_KEY,
          c.req.query()
        );
        return c.json({
          data: page.items,
          meta: { nextCursor: page.nextCursor, activeScan: page.activeScan },
        });
      } catch (error) {
        if (error instanceof HistoryInputError)
          return c.json({ error: error.message }, 400);
        return c.json({ error: "RESULT_READ_ERROR" }, 503);
      }
    }
    return c.json({
      data: await new Store(c.env.DB, c.get("userId"), c.env.BOX_KEY).scans(),
    });
  });
  api.get("/api/scans/:id", async (c) => {
    const engine = scanEngineFor(c.env);
    const v = engine
      ? await reconcileDurableScan(
          { ...c.env, SCAN_ENGINE: engine },
          c.get("userId"),
          c.req.param("id")
        )
      : await new Store(c.env.DB, c.get("userId"), c.env.BOX_KEY).scan(
          c.req.param("id")
        );
    return v ? c.json({ data: v }) : c.json({ error: "NOT_FOUND" }, 404);
  });
  api.post("/api/scans/:id/cancel", async (c) => {
    const scan = await new Store(c.env.DB, c.get("userId"), c.env.BOX_KEY).scan(
      c.req.param("id")
    );
    if (!scan) return c.json({ error: "NOT_FOUND" }, 404);
    const engine = scanEngineFor(c.env);
    if (!engine) return c.json({ error: "CANCELLATION_UNAVAILABLE" }, 409);
    try {
      const record = await cancelDurableScan(
        { ...c.env, SCAN_ENGINE: engine },
        c.get("userId"),
        scan.id
      );
      return record
        ? c.json({ data: record })
        : c.json({ error: "NOT_FOUND" }, 404);
    } catch (error) {
      if (error instanceof DurableError)
        return c.json(
          { error: error.code, message: error.message },
          error.status
        );
      return c.json({ error: "PERSISTENCE_ERROR" }, 500);
    }
  });
  api.get("/api/scans/:id/deals", async (c) => {
    const store = new Store(c.env.DB, c.get("userId"), c.env.BOX_KEY);
    const scan = await store.scan(c.req.param("id"));
    if (!scan) return c.json({ error: "NOT_FOUND" }, 404);
    return c.json({ data: legacyDeals(await store.deals(scan.id)) });
  });
  api.get("/api/scans/:id/deal-groups", async (c) => {
    const store = new Store(c.env.DB, c.get("userId"), c.env.BOX_KEY);
    const scan = await store.scan(c.req.param("id"));
    if (!scan) return c.json({ error: "NOT_FOUND" }, 404);
    const deals = legacyDeals(await store.deals(scan.id));
    const groups = groupDeals(scan.source, deals);
    return c.json({
      data: groups,
      meta: {
        groupKeyVersion: 1,
        groupedProductCount: groups.length,
        offerCount: deals.length,
      },
    });
  });
  // Retain the original v2 array contract for clients without page=1.
  api.get("/api/scans/:id/products", async (c) => {
    const store = new Store(c.env.DB, c.get("userId"), c.env.BOX_KEY);
    const scan = await store.scan(c.req.param("id"));
    if (!scan) return c.json({ error: "NOT_FOUND" }, 404);
    if (scan.status !== "succeeded")
      return c.json({ error: "SCAN_NOT_PUBLISHED" }, 409);
    const products = await groupDealsV2(
      scan.source,
      await store.deals(scan.id)
    );
    return c.json({
      data: products,
      meta: {
        groupKeyVersion: 2,
        historyContext: scan.context ? "verified" : "legacy_unverified",
        coverageSummary: "supported_discount_feeds",
      },
    });
  });

  api.post("/api/scans", async (c) => {
    const parsed = scanInputSchema.safeParse(
      await c.req.json().catch(() => null)
    );
    if (!parsed.success) return c.json({ error: "INVALID_INPUT" }, 400);
    const key = c.req.header("Idempotency-Key");
    if (
      key !== undefined &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        key
      )
    )
      return c.json({ error: "INVALID_IDEMPOTENCY_KEY" }, 400);
    if (c.env.SCAN_WORKFLOW_ENABLED === "true") {
      const engine = scanEngineFor(c.env);
      if (!engine)
        return c.json({ error: "DURABLE_EXECUTION_UNAVAILABLE" }, 503);
      try {
        const record = await beginDurableScan(
          { ...c.env, SCAN_ENGINE: engine },
          c.get("userId"),
          parsed.data,
          key
        );
        return c.json({ data: record }, 202);
      } catch (error) {
        if (error instanceof DurableError) {
          if (error.status === 429) c.header("Retry-After", "10");
          return c.json(
            await startErrorBody(c.env, c.get("userId"), error),
            error.status
          );
        }
        console.error("Durable start reservation failed");
        return c.json({ error: "PERSISTENCE_ERROR" }, 500);
      }
    }
    const services = scanServices(
      c.env.DB,
      c.get("userId"),
      c.env.BOX_KEY,
      c.env.SNAPP_STORE_CAMPAIGNS_ENABLED === "true",
      c.env.OKALA_SHARED_OFFERS_ENABLED === "true"
    );
    let reserved: Awaited<ReturnType<typeof beginLegacyScan>>;
    try {
      reserved = await beginLegacyScan(
        c.env,
        c.get("userId"),
        parsed.data,
        key
      );
    } catch (error) {
      if (error instanceof DurableError)
        return c.json(
          await startErrorBody(c.env, c.get("userId"), error),
          error.status
        );
      console.error("Scan preparation defect");
      return c.json(
        {
          error: "PERSISTENCE_ERROR",
          message: "شروع اسکن ممکن نشد؛ دوباره تلاش کنید.",
        },
        500
      );
    }
    const { job, scan: record } = reserved;
    if (!job) return c.json({ data: record }, 202);
    // waitUntil owns this one Promise. A fiber does not extend the Worker's lifetime.
    const running = Effect.runPromiseExit(
      executeScan(job).pipe(Effect.provide(services))
    ).then((exit) => {
      if (Exit.isFailure(exit))
        console.error("Scan finalization failed", { scanId: job.id });
    });
    c.executionCtx.waitUntil(running);
    return c.json({ data: record }, 202);
  });
}
