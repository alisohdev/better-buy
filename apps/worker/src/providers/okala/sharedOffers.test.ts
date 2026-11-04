import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { campaignExpiry, readOkalaOffers } from "./sharedOffers";

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

const payload = (campaignId = 50, storeId = 1) => ({
  success: true,
  carousel: { id: campaignId },
  entities: [
    {
      storeId,
      storeName: "Store",
      products: [
        {
          id: 7,
          name: "Tea",
          discountPercent: 10,
          quantity: 2,
          hasQuantity: true,
          okPrice: 900,
          price: 1000,
          storeName: "Store",
          storeId,
        },
      ],
    },
  ],
});

afterEach(() => {
  databases.splice(0).forEach((db) => db.close());
  vi.useRealTimers();
});

describe("shared Okala offer observations", () => {
  it("reuses complete unfiltered offers for a canonical request with reordered stores", async () => {
    const { db } = database();
    let physicalRequests = 0;
    const load = async (onAttempt: () => Promise<void>) => {
      physicalRequests++;
      await onAttempt();
      return {
        ...payload(),
        entities: [
          ...payload().entities,
          { ...payload().entities[0]!, storeId: 2, products: [] },
        ],
      };
    };
    const first = await readOkalaOffers({
      db,
      enabled: true,
      campaignId: 50,
      storeIds: [2, 1],
      campaignExpiry: { kind: "unknown" },
      load,
    });
    const second = await readOkalaOffers({
      db,
      enabled: true,
      campaignId: 50,
      storeIds: [1, 2],
      campaignExpiry: { kind: "unknown" },
      load,
    });
    expect(physicalRequests).toBe(1);
    expect(second.reused).toBe(true);
    expect(second.observedAt).toBe(first.observedAt);
    expect(second.collection.entities).toHaveLength(2);
  });

  it("joins a healthy in-flight request instead of issuing a duplicate", async () => {
    const { db } = database();
    let physicalRequests = 0;
    let markStarted = () => {};
    let releaseOwner = () => {};
    const ownerStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const ownerHold = new Promise<void>((resolve) => {
      releaseOwner = resolve;
    });
    const owner = readOkalaOffers({
      db,
      enabled: true,
      campaignId: 50,
      storeIds: [1],
      campaignExpiry: { kind: "unknown" },
      load: async (onAttempt) => {
        physicalRequests++;
        await onAttempt();
        markStarted();
        await ownerHold;
        return payload();
      },
    });
    await ownerStarted;
    const follower = readOkalaOffers({
      db,
      enabled: true,
      campaignId: 50,
      storeIds: [1],
      campaignExpiry: { kind: "unknown" },
      load: async (onAttempt) => {
        physicalRequests++;
        await onAttempt();
        return payload();
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    releaseOwner();
    const [first, second] = await Promise.all([owner, follower]);
    expect(physicalRequests).toBe(1);
    expect(first.observedAt).toBe(second.observedAt);
    expect(second.reused).toBe(true);
  });

  it("fences a late publisher after a lease takeover", async () => {
    const { db, sqlite } = database();
    let releaseOwner = () => {};
    let markStarted = () => {};
    const ownerStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const ownerHold = new Promise<void>((resolve) => {
      releaseOwner = resolve;
    });
    const owner = readOkalaOffers({
      db,
      enabled: true,
      campaignId: 50,
      storeIds: [1],
      campaignExpiry: { kind: "unknown" },
      load: async (onAttempt) => {
        await onAttempt();
        markStarted();
        await ownerHold;
        return payload(50, 1);
      },
    });
    await ownerStarted;
    sqlite
      .prepare(
        "UPDATE okala_offer_cache SET lease_until='2000-01-01T00:00:00.000Z'"
      )
      .run();
    const replacement = await readOkalaOffers({
      db,
      enabled: true,
      campaignId: 50,
      storeIds: [1],
      campaignExpiry: { kind: "unknown" },
      load: async (onAttempt) => {
        await onAttempt();
        return {
          ...payload(),
          entities: [
            {
              ...payload().entities[0]!,
              products: [
                { ...payload().entities[0]!.products[0]!, name: "Replacement" },
              ],
            },
          ],
        };
      },
    });
    releaseOwner();
    await owner;
    const cached = await readOkalaOffers({
      db,
      enabled: true,
      campaignId: 50,
      storeIds: [1],
      campaignExpiry: { kind: "unknown" },
      load: async () => {
        throw new Error("fresh cache should not fetch");
      },
    });
    expect(replacement.collection.entities[0]?.products[0]?.name).toBe(
      "Replacement"
    );
    expect(cached.collection.entities[0]?.products[0]?.name).toBe(
      "Replacement"
    );
  });

  it("shortens reuse to fresh campaign discovery and rejects the exact deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-27T10:00:00.000Z"));
    const { db } = database();
    let physicalRequests = 0;
    const load = async (onAttempt: () => Promise<void>) => {
      physicalRequests++;
      await onAttempt();
      return payload();
    };
    const first = await readOkalaOffers({
      db,
      enabled: true,
      campaignId: 50,
      storeIds: [1],
      campaignExpiry: campaignExpiry("2026-10-27T10:05:00.000Z"),
      load,
    });
    expect(first.reusableUntil).toBe("2026-10-27T10:02:00.000Z");
    const shortened = await readOkalaOffers({
      db,
      enabled: true,
      campaignId: 50,
      storeIds: [1],
      campaignExpiry: campaignExpiry("2026-10-27T10:01:20.000Z"),
      load,
    });
    expect(shortened.reused).toBe(true);
    expect(shortened.reusableUntil).toBe("2026-10-27T10:01:05.000Z");
    vi.setSystemTime(new Date("2026-10-27T10:01:05.000Z"));
    const boundary = await readOkalaOffers({
      db,
      enabled: true,
      campaignId: 50,
      storeIds: [1],
      campaignExpiry: { kind: "unknown" },
      load,
    });
    expect(boundary.reused).toBe(false);
    expect(physicalRequests).toBe(2);
  });

  it("does not publish malformed or incomplete provider responses", async () => {
    const { db, sqlite } = database();
    await expect(
      readOkalaOffers({
        db,
        enabled: true,
        campaignId: 50,
        storeIds: [1],
        campaignExpiry: { kind: "unknown" },
        load: async (onAttempt) => {
          await onAttempt();
          return { ...payload(), hasNextPage: true };
        },
      })
    ).rejects.toMatchObject({ code: "INCOMPLETE_PAGINATION" });
    expect(sqlite.prepare("SELECT state FROM okala_offer_cache").all()).toEqual(
      [{ state: "failed" }]
    );
  });

  it("marks oversized results temporary noncacheable", async () => {
    const { db, sqlite } = database();
    let physicalRequests = 0;
    const largePayload = {
      ...payload(),
      entities: [
        {
          ...payload().entities[0]!,
          products: [
            {
              ...payload().entities[0]!.products[0]!,
              name: "x".repeat(1024 * 1024),
            },
          ],
        },
      ],
    };
    const load = async (onAttempt: () => Promise<void>) => {
      physicalRequests++;
      await onAttempt();
      return largePayload;
    };
    await readOkalaOffers({
      db,
      enabled: true,
      campaignId: 50,
      storeIds: [1],
      campaignExpiry: { kind: "unknown" },
      load,
    });
    expect(
      sqlite.prepare("SELECT state FROM okala_offer_cache").get()
    ).toMatchObject({
      state: "noncacheable",
    });
    const directAfterOversize = await readOkalaOffers({
      db,
      enabled: true,
      campaignId: 50,
      storeIds: [1],
      campaignExpiry: { kind: "unknown" },
      load,
    });
    expect(directAfterOversize.reused).toBe(false);
    expect(physicalRequests).toBe(2);
  });

  it("returns the fetched result when publishing it to D1 fails", async () => {
    const { db } = database();
    let physicalRequests = 0;
    const failingDb = {
      prepare(sql: string) {
        const statement = db.prepare(sql);
        return {
          bind(...values: (string | number | null)[]) {
            const bound = statement.bind(...values);
            if (!sql.includes("SET state='ready'")) return bound;
            return new Proxy(bound, {
              get(target, property, receiver) {
                if (property === "run")
                  return async () => {
                    throw new Error("cache write unavailable");
                  };
                return Reflect.get(target, property, receiver);
              },
            });
          },
        };
      },
      withSession: undefined,
    } as unknown as D1Database;
    const result = await readOkalaOffers({
      db: failingDb,
      enabled: true,
      campaignId: 50,
      storeIds: [1],
      campaignExpiry: { kind: "unknown" },
      load: async (onAttempt) => {
        physicalRequests++;
        await onAttempt();
        return payload();
      },
    });
    expect(result.collection.entities).toHaveLength(1);
    expect(result.reused).toBe(false);
    expect(physicalRequests).toBe(1);
  });

  it("rejects offsetless campaign expiry for sharing", () => {
    expect(campaignExpiry("2026-10-27T10:00:00")).toEqual({
      kind: "unshareable",
    });
  });
});
