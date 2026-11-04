import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { collectOkala } from "./collector";

const databases: DatabaseSync[] = [];
function database() {
  const sqlite = new DatabaseSync(":memory:");
  databases.push(sqlite);
  sqlite.exec("CREATE TABLE scans(id TEXT PRIMARY KEY,status TEXT NOT NULL)");
  sqlite.exec(readFileSync("migrations/0016_okala_shared_offers.sql", "utf8"));
  const wrap = (sql: string, args: (string | number | null)[] = []) => ({
    bind: (...values: (string | number | null)[]) => wrap(sql, values),
    first: async <T>() =>
      (sqlite.prepare(sql).get(...args) as T | undefined) ?? null,
    run: async () => ({
      success: true,
      meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) },
    }),
  });
  return {
    sqlite,
    db: { prepare: (sql: string) => wrap(sql) } as unknown as D1Database,
  };
}

afterEach(() => databases.splice(0).forEach((db) => db.close()));

describe("legacy Okala shared offer collection", () => {
  it("reuses an unfiltered response and applies each scan threshold privately", async () => {
    const { db, sqlite } = database();
    sqlite
      .prepare("INSERT INTO scans(id,status) VALUES(?, 'running')")
      .run("one");
    sqlite
      .prepare("INSERT INTO scans(id,status) VALUES(?, 'running')")
      .run("two");
    const calls = { nearby: 0, campaigns: 0, offers: 0 };
    const fetcher: typeof fetch = async (request) => {
      const url = new URL(String(request));
      if (url.pathname.endsWith("/nearby")) {
        calls.nearby++;
        return Response.json({
          success: true,
          data: {
            stores: [
              { storeId: 4, isActive: true, isServes: true, isExist: true },
            ],
          },
        });
      }
      if (url.pathname.endsWith("/carousel/v4/offers")) {
        calls.campaigns++;
        return Response.json({
          success: true,
          carousels: [
            { isMulti: true, id: 9, endTime: "2030-12-31T23:59:59Z" },
          ],
        });
      }
      calls.offers++;
      return Response.json({
        success: true,
        carousel: { id: 9 },
        entities: [
          {
            storeId: 4,
            storeName: "Store",
            products: [
              {
                id: 1,
                name: "Milk",
                discountPercent: 30,
                quantity: 1,
                hasQuantity: true,
                okPrice: 700,
                price: 1000,
                storeName: "Store",
                storeId: 4,
              },
            ],
          },
        ],
      });
    };
    const first = await Effect.runPromise(
      collectOkala({
        latitude: 35.7,
        longitude: 51.4,
        threshold: 30,
        db,
        scanId: "one",
        sharedOffersEnabled: true,
        fetcher,
      })
    );
    const second = await Effect.runPromise(
      collectOkala({
        latitude: 35.7005,
        longitude: 51.4,
        threshold: 80,
        db,
        scanId: "two",
        sharedOffersEnabled: true,
        fetcher,
      })
    );
    expect(calls).toEqual({ nearby: 2, campaigns: 2, offers: 1 });
    expect(first.deals).toHaveLength(1);
    expect(second.deals).toHaveLength(0);
    expect(first.deals[0]?.observedAt).toBeTruthy();
    expect(
      sqlite
        .prepare(
          "SELECT reused FROM scan_offer_observations WHERE scan_id='two'"
        )
        .get()
    ).toMatchObject({ reused: 1 });
  });
});
