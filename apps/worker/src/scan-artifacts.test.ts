import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "./store";
import { DurableRepository } from "./durable/repository";
import { reconcileDurableOperations } from "./durable/service";
import { terminalScanArtifactStatements } from "./scan-artifacts";

const tables = [
  "deals",
  "scan_units",
  "scan_pages",
  "scan_chunks",
  "scan_observations",
  "scan_discovery",
  "scan_attempts",
  "saved_products",
  "saved_product_offers",
  "product_projection_scans",
];
const databases: DatabaseSync[] = [];
function database() {
  const sqlite = new DatabaseSync(":memory:");
  databases.push(sqlite);
  for (const file of readdirSync("migrations")
    .filter((n) => n.endsWith(".sql"))
    .sort())
    sqlite.exec(readFileSync(`migrations/${file}`, "utf8"));
  const wrap = (sql: string, args: (string | number | null)[] = []) => ({
    bind: (...values: (string | number | null)[]) => wrap(sql, values),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    run: async () => ({
      meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) },
    }),
  });
  const db = {
    prepare: (sql: string) => wrap(sql),
    batch: async (statements: { run: () => Promise<unknown> }[]) => {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
  const store = new Store(db, "owner", "key");
  const repo = new DurableRepository(db, "key");
  const reserve = async (
    owner = "owner",
    kind: "legacy" | "workflow" = "legacy"
  ) => {
    const location = await new Store(db, owner, "key").createLocation({
      name: "Fixture",
      latitude: 35.7,
      longitude: 51.4,
    });
    return repo.reserve(
      owner,
      {
        locationId: location!.id,
        source: "snappmarket",
        threshold: 40,
        mode: "partial",
      },
      crypto.randomUUID(),
      false,
      kind
    );
  };
  return { sqlite, db, store, repo, reserve };
}
function seed(sqlite: DatabaseSync, id: string, owner = "owner") {
  sqlite
    .prepare(
      "INSERT INTO deals(id,scan_id,deal_key,product_variation_id,vendor_id,title,vendor_title,price_rials,discount_rials,final_price_rials,discount_ratio,stock) VALUES(?,?,'key','product','vendor','title','vendor',100,40,60,40,1)"
    )
    .run(`deal-${id}`, id);
  sqlite.prepare("INSERT INTO scan_units VALUES(?,'unit','{}',0,NULL)").run(id);
  sqlite
    .prepare("INSERT INTO scan_pages VALUES(?,'unit',1,'digest','{}',1,0)")
    .run(id);
  sqlite
    .prepare("INSERT INTO scan_chunks VALUES(?,'unit',1,0,'digest')")
    .run(id);
  sqlite
    .prepare("INSERT INTO scan_observations VALUES(?,'kind','identity')")
    .run(id);
  sqlite
    .prepare(
      "INSERT INTO scan_discovery(scan_id,request_key,body_json) VALUES(?,'key','{}')"
    )
    .run(id);
  sqlite
    .prepare("INSERT INTO scan_attempts VALUES(?,'operation',1,'2026-01-01')")
    .run(id);
  sqlite
    .prepare(
      "INSERT INTO saved_products VALUES(?,?,'group','','',0,0,0,100,-100,'{}')"
    )
    .run(owner, id);
  sqlite
    .prepare(
      "INSERT INTO saved_product_offers VALUES(?,?,'group','offer',0,0,100,'vendor','{}')"
    )
    .run(owner, id);
  sqlite
    .prepare(
      "INSERT INTO product_projection_scans(user_id,scan_id,baseline_reason,observed_at) VALUES(?,?,'none','2026-01-01')"
    )
    .run(owner, id);
}
function expectArtifacts(sqlite: DatabaseSync, id: string, count: number) {
  for (const table of tables)
    expect(
      sqlite
        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE scan_id=?`)
        .get(id),
      table
    ).toMatchObject({ n: count });
}
afterEach(() => databases.splice(0).forEach((db) => db.close()));
describe("atomic terminal scan artifact deletion", () => {
  it.each([
    "legacy failure",
    "workflow failure",
    "cancellation",
    "stale queued",
  ])(
    "deletes all partial artifacts for %s and retains successful results and control records",
    async (path) => {
      const { sqlite, store, repo, reserve } = database();
      const successful = await reserve();
      sqlite
        .prepare("UPDATE scans SET status='succeeded' WHERE id=?")
        .run(successful.id);
      seed(sqlite, successful.id);
      const scan = await reserve();
      seed(sqlite, scan.id);
      if (path === "legacy failure")
        await store.fail(scan.id, "TEST_FAILURE", "Fixture failure");
      else if (path === "workflow failure")
        await repo.fail(scan.id, "TEST_FAILURE");
      else if (path === "cancellation") await repo.cancel(scan.id, "owner");
      else {
        sqlite
          .prepare(
            "UPDATE scans SET status=?,created_at='2026-01-01' WHERE id=?"
          )
          .run("queued", scan.id);
        await store.reconcileStale();
      }
      expectArtifacts(sqlite, scan.id, 0);
      expectArtifacts(sqlite, successful.id, 1);
      expect(
        sqlite.prepare("SELECT status FROM scans WHERE id=?").get(scan.id)
      ).toMatchObject({
        status: path === "cancellation" ? "cancelled" : "failed",
      });
      expect(
        sqlite
          .prepare(
            "SELECT COUNT(*) AS n FROM scan_start_intents WHERE scan_id=?"
          )
          .get(scan.id)
      ).toMatchObject({ n: 1 });
      expect(
        sqlite
          .prepare("SELECT COUNT(*) AS n FROM scan_execution WHERE scan_id=?")
          .get(scan.id)
      ).toMatchObject({ n: 1 });
      await expect(
        repo.saveDiscovery(scan.id, "late", {})
      ).rejects.toMatchObject({ code: "TERMINAL_SCAN" });
      await expect(repo.reserveAttempt(scan.id, "late")).rejects.toMatchObject({
        code: "TERMINAL_SCAN",
      });
      expectArtifacts(sqlite, scan.id, 0);
    }
  );
  it("rolls the failure back when deletion fails, allowing a retry", async () => {
    const { sqlite, store, reserve } = database();
    const scan = await reserve();
    seed(sqlite, scan.id);
    sqlite.exec(
      "CREATE TRIGGER reject_artifact_delete BEFORE DELETE ON saved_products BEGIN SELECT RAISE(ABORT,'fixture deletion failure'); END"
    );
    await expect(
      store.fail(scan.id, "TEST_FAILURE", "Fixture")
    ).rejects.toThrow("fixture deletion failure");
    expect(
      sqlite.prepare("SELECT status FROM scans WHERE id=?").get(scan.id)
    ).toMatchObject({ status: "queued" });
    expectArtifacts(sqlite, scan.id, 1);
    sqlite.exec("DROP TRIGGER reject_artifact_delete");
    await store.fail(scan.id, "TEST_FAILURE", "Fixture");
    expectArtifacts(sqlite, scan.id, 0);
  });
  it("recovery deletes artifacts when the workflow engine confirms interruption", async () => {
    const { sqlite, db, reserve } = database();
    const scan = await reserve("owner", "workflow");
    seed(sqlite, scan.id);
    await new Store(db, "owner", "key").reconcileStale();
    expectArtifacts(sqlite, scan.id, 1);
    await reconcileDurableOperations({
      DB: db,
      BOX_KEY: "key",
      SCAN_WORKFLOW: {
        get: async () =>
          ({ status: async () => ({ status: "errored" }) }) as WorkflowInstance,
        create: async () => {
          throw Error("must not dispatch an existing workflow");
        },
      },
    });
    expectArtifacts(sqlite, scan.id, 0);
    expect(
      sqlite
        .prepare("SELECT status,error_code FROM scans WHERE id=?")
        .get(scan.id)
    ).toMatchObject({ status: "failed", error_code: "ENGINE_TERMINAL" });
  });
  it("does not recreate an attempt receipt after a concurrent cancellation", async () => {
    const { sqlite, repo, reserve } = database();
    const scan = await reserve();
    seed(sqlite, scan.id);
    const check = repo.check.bind(repo);
    vi.spyOn(repo, "check").mockImplementationOnce(async (id) => {
      const job = await check(id);
      // Another attempt advances the counter before this stale writer resumes.
      sqlite
        .prepare("UPDATE scan_execution SET attempt_count=1 WHERE scan_id=?")
        .run(id);
      await repo.cancel(id, "owner");
      return job;
    });
    await expect(repo.reserveAttempt(scan.id, "late")).rejects.toMatchObject({
      code: "TERMINAL_SCAN",
    });
    expectArtifacts(sqlite, scan.id, 0);
  });
  it("protects successful scans, healthy active scans, and other owners", async () => {
    const { sqlite, db, store, repo, reserve } = database();
    const other = await reserve("other");
    seed(sqlite, other.id, "other");
    await store.fail(other.id, "TEST_FAILURE", "Fixture");
    await repo.cancel(other.id, "owner");
    expectArtifacts(sqlite, other.id, 1);
    const successful = await reserve();
    seed(sqlite, successful.id);
    sqlite
      .prepare("UPDATE scans SET status='succeeded' WHERE id=?")
      .run(successful.id);
    await store.fail(successful.id, "TEST_FAILURE", "Fixture");
    await repo.fail(successful.id, "TEST_FAILURE");
    await repo.cancel(successful.id, "owner");
    expectArtifacts(sqlite, successful.id, 1);
    const healthy = await reserve();
    seed(sqlite, healthy.id);
    await store.reconcileStale();
    await db.batch(terminalScanArtifactStatements(db, healthy.id, "owner"));
    expectArtifacts(sqlite, healthy.id, 1);
    const prepare = vi.spyOn(db, "prepare");
    await reconcileDurableOperations({
      DB: db,
      BOX_KEY: "key",
      SCAN_WORKFLOW: {
        get: async () => {
          throw Error("no workflow");
        },
        create: async () => {
          throw Error("no workflow");
        },
      },
    });
    expect(prepare.mock.calls).toHaveLength(1);
    expect(prepare.mock.calls[0]?.[0]).toContain("FROM scan_execution");
    expectArtifacts(sqlite, healthy.id, 1);
  });
  it("does not expire a running collector based on its age", async () => {
    const { sqlite, store, reserve } = database();
    const scan = await reserve();
    seed(sqlite, scan.id);
    sqlite
      .prepare(
        "UPDATE scans SET status='running',created_at='2000-01-01' WHERE id=?"
      )
      .run(scan.id);
    await store.reconcileStale();
    expectArtifacts(sqlite, scan.id, 1);
    expect(
      sqlite.prepare("SELECT status FROM scans WHERE id=?").get(scan.id)
    ).toMatchObject({ status: "running" });
  });
  it("uses existing indexes for terminal deletes and stale lookup", async () => {
    const { sqlite, db, store, reserve } = database();
    const scan = await reserve();
    const prepare = vi.spyOn(db, "prepare");
    terminalScanArtifactStatements(db, scan.id, "owner");
    await store.reconcileStale();
    for (const [sql] of prepare.mock.calls) {
      const bindings = sql.startsWith("DELETE")
        ? [scan.id, scan.id, "owner"]
        : ["owner", new Date().toISOString()];
      if (
        sql.startsWith("DELETE FROM saved_") ||
        sql.startsWith("DELETE FROM product_projection")
      )
        bindings.unshift("owner");
      const plan = sqlite
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...bindings) as { detail: string }[];
      expect(
        plan.some(({ detail }) => /^SCAN\b/.test(detail)),
        sql
      ).toBe(false);
    }
  });
});
