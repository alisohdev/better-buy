import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Store } from "../store";
import { DurableRepository } from "./repository";
import { runDurableScan } from "./runner";

function database() {
  const sqlite = new DatabaseSync(":memory:");
  for (const name of readdirSync("migrations")
    .filter((file) => file.endsWith(".sql"))
    .sort())
    sqlite.exec(readFileSync(`migrations/${name}`, "utf8"));
  const wrap = (sql: string, args: (string | number | null)[] = []) => ({
    bind: (...values: (string | number | null)[]) => wrap(sql, values),
    first: async <T>() =>
      (sqlite.prepare(sql).get(...args) as T | undefined) ?? null,
    all: async <T>() => ({ results: sqlite.prepare(sql).all(...args) as T[] }),
    run: async () => ({
      success: true,
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
  return { db, sqlite };
}

describe("durable Okala offer sharing", () => {
  it("keeps user scans private while reusing the same unfiltered public collection", async () => {
    const { db, sqlite } = database();
    const physical = { nearby: 0, campaigns: 0, offers: 0 };
    const fetcher: typeof fetch = async (request) => {
      const url = new URL(String(request));
      if (url.pathname.endsWith("/nearby")) {
        physical.nearby++;
        return Response.json({
          success: true,
          data: {
            stores: [
              { storeId: 5, isActive: true, isExist: true, isServes: true },
            ],
          },
        });
      }
      if (url.pathname === "/api/carousel/v4/offers") {
        physical.campaigns++;
        return Response.json({
          success: true,
          carousels: [
            { isMulti: true, id: 7, endTime: "2030-12-31T23:59:59Z" },
          ],
        });
      }
      if (url.pathname.endsWith("/multi-store")) {
        physical.offers++;
        return Response.json({
          success: true,
          carousel: { id: 7 },
          entities: [
            {
              storeId: 5,
              storeName: "Store",
              products: [
                {
                  id: 9,
                  name: "Milk",
                  discountPercent: 30,
                  quantity: 1,
                  hasQuantity: true,
                  okPrice: 7000,
                  price: 10000,
                  storeName: "Store",
                  storeId: 5,
                },
              ],
            },
          ],
        });
      }
      throw new Error(`Unexpected upstream request ${url.pathname}`);
    };
    const steps = {
      do: async <T extends Rpc.Serializable<T>>(
        _name: string,
        action: () => Promise<T>
      ) => action(),
      sleep: async () => {},
    };
    const scans = [];
    for (const [userId, threshold, latitude] of [
      ["one", 30, 35.7],
      ["two", 80, 35.7005],
    ] as const) {
      const store = new Store(db, userId, "fixture");
      const location = await store.createLocation({
        name: "Fixture",
        latitude,
        longitude: 51.4,
      });
      const repository = new DurableRepository(db, "fixture");
      const scan = await repository.reserve(
        userId,
        {
          locationId: location!.id,
          source: "okala",
          threshold,
          mode: "full",
        },
        crypto.randomUUID(),
        false
      );
      scans.push(scan);
      await runDurableScan(
        { scanId: scan.id, contractVersion: 1 },
        {
          repository,
          steps,
          fetcher,
          sharedOkalaOffersEnabled: true,
          materialize: async (id, scanId) => {
            await db
              .prepare(
                "INSERT INTO product_projection_scans(user_id,scan_id,ready,baseline_reason,observed_at) VALUES(?,?,1,'scope_mismatch','2030-01-01T00:00:00.000Z')"
              )
              .bind(id, scanId)
              .run();
          },
        }
      );
    }
    const first = await new Store(db, "one", "fixture").scan(scans[0]!.id);
    const second = await new Store(db, "two", "fixture").scan(scans[1]!.id);
    expect(physical).toEqual({ nearby: 2, campaigns: 2, offers: 1 });
    expect(first).toMatchObject({
      status: "succeeded",
      threshold: 30,
      dealCount: 1,
    });
    expect(second).toMatchObject({
      status: "succeeded",
      threshold: 80,
      dealCount: 0,
    });
    expect(first?.observation?.reusedRequestCount).toBe(0);
    expect(second?.observation?.reusedRequestCount).toBe(1);
    const receipts = sqlite
      .prepare(
        "SELECT scan_id,observed_at,reused FROM scan_offer_observations ORDER BY scan_id"
      )
      .all() as { scan_id: string; observed_at: string; reused: number }[];
    expect(receipts).toHaveLength(2);
    expect(receipts[0]?.observed_at).toBe(receipts[1]?.observed_at);
    expect(receipts.map((receipt) => receipt.reused)).toContain(1);
  });
});
