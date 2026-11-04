import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readDurableComparison } from "./comparison";
import { Store } from "../store";
import { DurableRepository } from "./repository";
import type { Page, Unit } from "./types";
import { providerReader } from "./provider";
import { runDurableScan } from "./runner";
import { materializeProducts } from "../saved-products";
import { collectPage, planUnits } from "./adapters";
import {
  beginLegacyScan,
  reconcileDurableScan,
  beginDurableScan,
  reconcileDurableOperations,
} from "./service";

const databases: DatabaseSync[] = [];
function database() {
  const sqlite = new DatabaseSync(":memory:");
  databases.push(sqlite);
  for (const name of readdirSync("migrations")
    .filter((n) => n.endsWith(".sql"))
    .sort())
    sqlite.exec(readFileSync(`migrations/${name}`, "utf8"));
  const wrap = (sql: string, args: (string | number | null)[] = []) => ({
    bind: (...v: (string | number | null)[]) => wrap(sql, v),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
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
        const result = [];
        for (const stmt of statements) result.push(await stmt.run());
        sqlite.exec("COMMIT");
        return result;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
  return { db, sqlite };
}
afterEach(() => {
  databases.splice(0).forEach((d) => d.close());
  vi.useRealTimers();
});
describe("durable scan persistence", () => {
  it("persists and resumes hinted category pagination beyond eight pages", async () => {
    const { db } = database(),
      store = new Store(db, "tenant", "key"),
      repo = new DurableRepository(db, "key");
    const location = await store.createLocation({
      name: "Fixture",
      latitude: 35.7,
      longitude: 51.4,
    });
    const scan = await repo.reserve(
      "tenant",
      {
        locationId: location!.id,
        source: "snappmarket",
        threshold: 40,
        mode: "partial",
      },
      crypto.randomUUID(),
      true
    );
    await repo.started(scan.id);
    const scope = {
      vendorId: 61,
      vendorCode: "branch",
      collectionId: 71,
      source: "discounted_category" as const,
      expectedPageSize: 1,
      maxPages: 11,
      bounded: true,
    };
    const unit: Unit = {
      id: "category",
      kind: "store_campaign",
      title: "Store",
      ...scope,
    };
    await repo.freeze(scan.id, [unit], {
      ...scan.context!.manifest,
      feedKinds: ["discounted_category"],
      storeCampaigns: [scope],
    });
    const read = async (url: URL) => {
      const page = Number(url.searchParams.get("page"));
      return page === 10
        ? { status: 204 }
        : {
            status: true,
            data: {
              count: 10,
              finalResult: [
                {
                  type: "PRODUCT",
                  data: {
                    id: page + 1,
                    vendor_id: 61,
                    document_id: `${page + 1}-61`,
                    title: "Item",
                    price: 100000,
                    discount: 50000,
                    discountRatio: 50,
                    stock: 3,
                  },
                },
              ],
            },
          };
    };
    for (let page = 0; page <= 10; page++) {
      // Reload the frozen unit and checkpoints on every iteration, as on resume.
      const persisted = (await repo.units(scan.id))[0]!;
      const data = await collectPage(
        (await repo.load(scan.id))!,
        persisted,
        page,
        await repo.pages(scan.id, persisted.id),
        read
      );
      expect(data.terminal).toBe(page === 10);
      await repo.stage(scan.id, persisted, page, data);
    }
    await materializeProducts(db, "tenant", scan.id);
    await repo.publish(scan.id);
    expect(await store.scan(scan.id)).toMatchObject({
      status: "succeeded",
      dealCount: 10,
      context: { coverage: "complete", manifest: { storeCampaigns: [scope] } },
    });
  });
  it.each([false, true])(
    "persists bounded category coverage and caches 204 terminals across resume, partial=%s",
    async (partial) => {
      const { db } = database(),
        store = new Store(db, "tenant", "key"),
        repo = new DurableRepository(db, "key");
      const location = await store.createLocation({
        name: "Fixture",
        latitude: 35.7,
        longitude: 51.4,
      });
      const scan = await repo.reserve(
        "tenant",
        {
          locationId: location!.id,
          source: "snappmarket",
          threshold: 40,
          mode: "partial",
        },
        crypto.randomUUID(),
        true
      );
      await repo.started(scan.id);
      const unit: Unit = {
        id: "category",
        kind: "store_campaign",
        source: "discounted_category",
        vendorId: 61,
        vendorCode: "branch",
        collectionId: 71,
        title: "Store",
        expectedPageSize: 2,
        ...(partial ? { bounded: true, maxPages: 1 } : {}),
      };
      await repo.freeze(scan.id, [unit], {
        ...scan.context!.manifest,
        feedKinds: ["discounted_category"],
        storeCampaigns: [
          {
            vendorId: 61,
            vendorCode: "branch",
            collectionId: 71,
            source: "discounted_category",
            ...(partial ? { bounded: true, maxPages: 1 } : {}),
          },
        ],
      });
      let requests = 0;
      const fetcher: typeof fetch = async (input) => {
        requests++;
        const url = new URL(String(input));
        if (url.pathname.endsWith("/token"))
          return Response.json({
            status: true,
            data: { access_token: "fixture", expires_in: 3600 },
          });
        if (url.searchParams.get("page") === "1")
          return new Response(null, { status: 204 });
        return Response.json({
          status: true,
          vendor_id: [61],
          data: {
            count: partial ? 9 : 2,
            finalResult: [1, 2].map((id) => ({
              type: "PRODUCT",
              data: {
                id,
                vendor_id: 61,
                document_id: `${id}-61`,
                title: "Item",
                price: 100000,
                discount: 50000,
                discountRatio: 50,
                stock: 3,
              },
            })),
          },
        });
      };
      const steps = {
        do: async <T extends Rpc.Serializable<T>>(
          _name: string,
          action: () => Promise<T>
        ) => action(),
        sleep: async () => {},
      };
      const read = providerReader(repo, scan.id, steps, fetcher);
      const first = await collectPage(
        (await repo.load(scan.id))!,
        unit,
        0,
        [],
        read
      );
      await repo.stage(scan.id, unit, 0, first);
      if (!partial) {
        const terminal = await collectPage(
          (await repo.load(scan.id))!,
          unit,
          1,
          await repo.pages(scan.id, unit.id),
          read
        );
        expect(terminal.terminalEvidence).toBe("verified_empty_campaign_page");
        await repo.stage(scan.id, unit, 1, terminal);
        const before = requests;
        await providerReader(
          repo,
          scan.id,
          steps,
          fetcher
        )(
          new URL(
            "https://svc.snapp.market/express-search/product-list/vendor"
          ),
          "category-1"
        );
        expect(requests).toBe(before);
      }
      if (partial) {
        expect(first.terminal).toBe(false);
        await expect(repo.publish(scan.id)).rejects.toMatchObject({
          code: "INCOMPLETE_PAGINATION",
        });
        return;
      }
      await materializeProducts(db, "tenant", scan.id);
      await repo.publish(scan.id);
      expect(await store.scan(scan.id)).toMatchObject({
        status: "succeeded",
        dealCount: 2,
        context: { coverage: partial ? "incomplete" : "complete" },
      });
      expect(await readDurableComparison(db, "tenant", scan.id)).toMatchObject({
        complete: !partial,
        campaigns: [
          {
            terminal: !partial,
            coverage: partial ? "incomplete" : "complete",
            outcome: partial ? "incomplete" : "net_new",
          },
        ],
      });
      if (partial)
        expect(
          (await store.deals(scan.id)).every((d) => d.state === "current")
        ).toBe(true);
    }
  );
  it("publishes legacy partial observations without certifying disappearance", async () => {
    const { db } = database(),
      store = new Store(db, "tenant", "key");
    const location = await store.createLocation({
      name: "Fixture",
      latitude: 35.7,
      longitude: 51.4,
    });
    const id = await store.createScan(
      location!.id,
      40,
      "snappmarket",
      "partial"
    );
    await store.markRunning(id);
    await store.freezeSnappManifest(id, [
      {
        vendorId: 61,
        vendorCode: "branch",
        collectionId: 71,
        source: "discounted_category",
        maxPages: 1,
        bounded: true,
      },
    ]);
    await store.succeed(
      id,
      { vendorCount: 0, productCount: 0, coverage: "incomplete" },
      []
    );
    expect(await store.scan(id)).toMatchObject({
      status: "succeeded",
      context: {
        coverage: "incomplete",
        manifest: { feedKinds: ["market_party", "discounted_category"] },
      },
    });
  });
  it.each([false, true])(
    "uses deterministic priority and feed identity for equal-time tuples, reversed=%s",
    async (reversed) => {
      const { db } = database(),
        store = new Store(db, "tenant", "key"),
        repo = new DurableRepository(db, "key");
      const location = await store.createLocation({
        name: "Fixture",
        latitude: 35.7,
        longitude: 51.4,
      });
      const scan = await repo.reserve(
        "tenant",
        {
          locationId: location!.id,
          source: "snappmarket",
          threshold: 40,
          mode: "partial",
        },
        crypto.randomUUID(),
        true
      );
      await repo.started(scan.id);
      const units: Unit[] = [
        { id: "market-party", kind: "market_party" },
        { id: "campaign-a", kind: "store_campaign" },
        { id: "campaign-z", kind: "store_campaign" },
      ];
      await repo.freeze(scan.id, units, scan.context!.manifest);
      const offer = {
        key: "1:2",
        productVariationId: "2",
        vendorId: "1",
        title: "Milk 1 L",
        image: null,
        vendorTitle: "Shop",
        vendorCode: null,
        categoryTitle: null,
        priceRials: 100000,
        discountRials: 50000,
        finalPriceRials: 50000,
        discountRatio: 50,
        stock: 2,
        observedAt: "2026-10-10T08:00:00.000Z",
      };
      for (const unit of reversed ? [...units].reverse() : units) {
        const campaign = unit.kind === "store_campaign";
        const offers = campaign
          ? [
              {
                ...offer,
                ...(unit.id === "campaign-a"
                  ? {
                      priceRials: 200000,
                      discountRials: 100000,
                      finalPriceRials: 100000,
                      stock: 7,
                    }
                  : {}),
                provenance: [unit.id],
              },
              {
                ...offer,
                key: "1:3",
                productVariationId: "3",
                priceRials: 200000,
                discountRials: 100000,
                finalPriceRials: 100000,
                stock: 7,
                provenance: [unit.id],
              },
            ]
          : [
              {
                ...offer,
                key: "1:3",
                productVariationId: "3",
                provenance: [unit.id],
              },
            ];
        await repo.stage(scan.id, unit, 0, {
          offers,
          products: offers.map((row) => row.key),
          vendors: ["1"],
          identities: offers.map((row) => row.key),
          rowCount: offers.length,
          reportedTotal: offers.length,
          terminal: true,
          terminalEvidence: "fixture_terminal",
          fingerprint: unit.id,
        });
      }
      await materializeProducts(db, "tenant", scan.id);
      await repo.publish(scan.id);
      const offers = await store.deals(scan.id);
      expect(offers.find((row) => row.key === "1:2")).toMatchObject({
        priceRials: 200000,
        discountRials: 100000,
        finalPriceRials: 100000,
        stock: 7,
        provenance: ["campaign-a", "campaign-z"],
      });
      expect(offers.find((row) => row.key === "1:3")).toMatchObject({
        priceRials: 100000,
        discountRials: 50000,
        finalPriceRials: 50000,
        stock: 2,
        provenance: ["campaign-a", "campaign-z", "market-party"],
      });
    }
  );
  it("caps retained omission records while preserving complete reason totals", async () => {
    const { db } = database(),
      store = new Store(db, "tenant", "key"),
      repo = new DurableRepository(db, "key");
    const location = await store.createLocation({
      name: "Fixture",
      latitude: 35.7,
      longitude: 51.4,
    });
    const scan = await repo.reserve(
      "tenant",
      {
        locationId: location!.id,
        source: "snappmarket",
        threshold: 40,
        mode: "partial",
      },
      crypto.randomUUID(),
      true
    );
    await repo.savePlanningAudit(
      scan.id,
      Array.from({ length: 205 }, (_, index) => ({
        vendorCode: "store",
        collectionId: index + 1,
        sectionType: "category",
        reason: "UNSUPPORTED_SECTION_TYPE",
      }))
    );
    const audit = await readDurableComparison(db, "tenant", scan.id);
    expect(audit).toMatchObject({
      campaigns: [],
      planning: {
        complete: true,
        omittedCount: 205,
        truncatedCount: 105,
        reasonCounts: { UNSUPPORTED_SECTION_TYPE: 205 },
      },
    });
    expect(audit?.omitted).toHaveLength(100);
  });
  it("audits failed home discovery without inventing a zero-eligible campaign", async () => {
    const { db } = database(),
      store = new Store(db, "tenant", "key"),
      repo = new DurableRepository(db, "key");
    const location = await store.createLocation({
      name: "Fixture",
      latitude: 35.7,
      longitude: 51.4,
    });
    const scan = await repo.reserve(
      "tenant",
      {
        locationId: location!.id,
        source: "snappmarket",
        threshold: 40,
        mode: "partial",
      },
      crypto.randomUUID(),
      true
    );
    await repo.started(scan.id);
    const steps = {
      do: async <T extends Rpc.Serializable<T>>(
        _name: string,
        action: () => Promise<T>
      ) => action(),
      sleep: async () => {},
    };
    const fetcher: typeof fetch = async (input) =>
      String(input).includes("oauth2")
        ? Response.json({
            status: true,
            data: { access_token: "fixture-secret", expires_in: 3600 },
          })
        : String(input).includes("vendors-list")
          ? Response.json({
              status: true,
              data: {
                count: 1,
                finalResult: [{ type: "VENDOR", data: { code: "failedhome" } }],
              },
            })
          : new Response("fixture-secret coordinates=35.7", { status: 403 });
    await expect(
      planUnits(
        repo,
        await repo.check(scan.id),
        providerReader(repo, scan.id, steps, fetcher)
      )
    ).rejects.toMatchObject({ code: "UPSTREAM_FORBIDDEN" });
    expect(await readDurableComparison(db, "tenant", scan.id)).toMatchObject({
      complete: false,
      campaigns: [],
      planning: {
        complete: false,
        failureCode: "UPSTREAM_FORBIDDEN",
        omittedCount: 1,
        reasonCounts: { HOME_DISCOVERY_FAILED: 1 },
      },
      omitted: [{ vendorCode: "failedhome", reason: "HOME_DISCOVERY_FAILED" }],
    });
  });
  it("retains concrete omitted discovery candidates privately across frozen-plan resume", async () => {
    const { db } = database(),
      store = new Store(db, "tenant", "key"),
      repo = new DurableRepository(db, "key");
    const location = await store.createLocation({
      name: "Fixture",
      latitude: 35.7,
      longitude: 51.4,
    });
    const scan = await repo.reserve(
      "tenant",
      {
        locationId: location!.id,
        source: "snappmarket",
        threshold: 40,
        mode: "partial",
      },
      crypto.randomUUID(),
      true
    );
    await repo.started(scan.id);
    const steps = {
      do: async <T extends Rpc.Serializable<T>>(
        _name: string,
        action: () => Promise<T>
      ) => action(),
      sleep: async () => {},
    };
    const codes = [
      "badhome",
      "wrongowner",
      "sections",
      ...Array.from({ length: 17 }, (_, i) => `extra${i}`),
    ];
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname.includes("oauth2"))
        return Response.json({
          status: true,
          data: { access_token: "fixture-secret", expires_in: 3600 },
        });
      if (url.pathname.endsWith("vendors-list"))
        return Response.json({
          status: true,
          data: {
            count: codes.length,
            finalResult: codes.map((code) => ({
              type: "VENDOR",
              data: { code },
            })),
          },
        });
      const code = url.pathname.split("/").at(-1)!;
      if (code === "badhome")
        return Response.json({ vendorInfo: { secret: "fixture-secret" } });
      const id = codes.indexOf(code) + 1;
      return Response.json({
        vendorInfo: {
          id,
          code,
          title: "Store",
          deliveryData: {
            id: code === "wrongowner" ? 99 : id,
            doesDeliver: true,
            detail: { vendorId: id },
          },
        },
        sections:
          code === "sections"
            ? [
                { type: "category?token=fixture-secret&lat=35.7", value: 1 },
                {
                  type: "product-list",
                  value: 3,
                  collection_type: "default",
                  is_pro: true,
                },
                {
                  type: "product-list",
                  value: 4,
                  collection_type: "unsupported",
                },
              ]
            : [],
      });
    };
    const units = await planUnits(
      repo,
      await repo.check(scan.id),
      providerReader(repo, scan.id, steps, fetcher)
    );
    const audit = await readDurableComparison(db, "tenant", scan.id);
    expect(audit).toMatchObject({
      complete: false,
      campaigns: [],
      omitted: expect.arrayContaining([
        expect.objectContaining({
          vendorCode: "badhome",
          reason: "HOME_SCHEMA",
        }),
        { vendorCode: "wrongowner", reason: "HOME_DELIVERY_OWNER_MISMATCH" },
        {
          vendorCode: "sections",
          collectionId: 3,
          sectionType: "product-list",
          reason: "CONDITIONAL_OR_UNVERIFIED_SECTION_CONFIG",
        },
        {
          vendorCode: "sections",
          collectionId: 4,
          sectionType: "product-list",
          reason: "UNSUPPORTED_COLLECTION_TYPE",
        },
        { vendorCode: "extra16", reason: "NO_SUPPORTED_ORDINARY_COLLECTION" },
      ]),
    });
    expect(JSON.stringify(audit)).not.toContain("fixture-secret");
    expect(JSON.stringify(audit)).not.toContain("35.7");
    expect(
      await planUnits(repo, await repo.check(scan.id), async () => {
        throw new Error("frozen plan must not rediscover");
      })
    ).toEqual(units);
    expect(await readDurableComparison(db, "tenant", scan.id)).toEqual(audit);
    expect(await readDurableComparison(db, "other-tenant", scan.id)).toBeNull();
  });
  it("reuses the original observed time when a cached provider response is normalized after resume", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-10T08:00:00.000Z"));
    const { db } = database(),
      store = new Store(db, "tenant", "key"),
      repo = new DurableRepository(db, "key");
    const location = await store.createLocation({
      name: "Fixture",
      latitude: 35.7,
      longitude: 51.4,
    });
    const scan = await repo.reserve(
      "tenant",
      {
        locationId: location!.id,
        source: "snappmarket",
        threshold: 40,
        mode: "partial",
      },
      crypto.randomUUID(),
      false
    );
    await repo.started(scan.id);
    const unit: Unit = { id: "market-party", kind: "market_party" };
    await repo.freeze(scan.id, [unit], scan.context!.manifest);
    const steps = {
      do: async <T extends Rpc.Serializable<T>>(
        _name: string,
        action: () => Promise<T>
      ) => action(),
      sleep: async () => {},
    };
    let requests = 0;
    const fetcher: typeof fetch = async (input) => {
      requests++;
      if (String(input).includes("oauth2"))
        return Response.json({
          status: true,
          data: { access_token: "fixture", expires_in: 3600 },
        });
      vi.setSystemTime(new Date("2026-10-10T08:01:00.000Z"));
      return Response.json({
        status: true,
        data: {
          total_count: 1,
          vendors: [
            {
              vendor_id: 1,
              products: [
                {
                  productVariationId: 2,
                  vendorId: 1,
                  vendorTitle: "Shop",
                  title: "Milk 1 L",
                  price: 100000,
                  discount: 50000,
                  discountRatio: 50,
                  stock: 2,
                },
              ],
            },
          ],
        },
      });
    };
    await providerReader(
      repo,
      scan.id,
      steps,
      fetcher
    )(
      new URL("https://svc.snapp.market/market-party/35.7/51.4"),
      "market-party-0"
    );
    vi.setSystemTime(new Date("2026-10-10T08:03:00.000Z"));
    const page = await collectPage(
      await repo.check(scan.id),
      unit,
      0,
      [],
      providerReader(repo, scan.id, steps, fetcher)
    );
    await repo.stage(scan.id, unit, 0, page);
    await materializeProducts(db, "tenant", scan.id);
    await repo.publish(scan.id);
    expect(await store.deals(scan.id)).toMatchObject([
      { observedAt: "2026-10-10T08:01:00.000Z" },
    ]);
    expect(requests).toBe(2);
  });
  it("publishes the latest complete overlapping tuple and audits the conflict", async () => {
    const { db } = database(),
      store = new Store(db, "tenant", "key"),
      repo = new DurableRepository(db, "key");
    const location = await store.createLocation({
      name: "Fixture",
      latitude: 35.7,
      longitude: 51.4,
    });
    const scan = await repo.reserve(
      "tenant",
      {
        locationId: location!.id,
        source: "snappmarket",
        threshold: 40,
        mode: "partial",
      },
      crypto.randomUUID(),
      true
    );
    await repo.started(scan.id);
    const units: Unit[] = [
      { id: "market-party", kind: "market_party" },
      { id: "campaign-1-2", kind: "store_campaign" },
    ];
    await repo.freeze(scan.id, units, scan.context!.manifest);
    const offer = {
      key: "1:2",
      productVariationId: "2",
      vendorId: "1",
      title: "Milk 1 L",
      image: null,
      vendorTitle: "Shop",
      vendorCode: null,
      categoryTitle: null,
      priceRials: 100000,
      discountRials: 50000,
      finalPriceRials: 50000,
      discountRatio: 50,
      stock: 2,
      observedAt: "2026-10-10T08:00:00.000Z",
      provenance: ["snapp:market_party"],
    };
    const page: Page = {
      offers: [offer],
      products: ["1:2"],
      vendors: ["1"],
      identities: ["1:2"],
      rowCount: 1,
      reportedTotal: 1,
      terminal: true,
      terminalEvidence: "fixture_terminal",
      fingerprint: "baseline",
    };
    await repo.stage(scan.id, units[0]!, 0, page);
    await repo.stage(scan.id, units[1]!, 0, {
      ...page,
      fingerprint: "campaign",
      offers: [
        {
          ...offer,
          priceRials: 200000,
          discountRials: 100000,
          finalPriceRials: 100000,
          stock: 7,
          observedAt: "2026-10-10T08:01:00.000Z",
          provenance: ["snapp:store_campaign:1:2"],
        },
      ],
    });
    await materializeProducts(db, "tenant", scan.id);
    await repo.publish(scan.id);
    expect(await store.deals(scan.id)).toMatchObject([
      {
        priceRials: 200000,
        discountRials: 100000,
        finalPriceRials: 100000,
        discountRatio: 50,
        stock: 7,
        observedAt: "2026-10-10T08:01:00.000Z",
        provenance: ["snapp:market_party", "snapp:store_campaign:1:2"],
      },
    ]);
    expect(await readDurableComparison(db, "tenant", scan.id)).toMatchObject({
      conflictingOfferCount: 1,
      conflictingOfferIdentities: ["1:2"],
    });
  });
  it("quarantines a cross-page campaign conflict without replacing a valid baseline offer", async () => {
    const { db } = database(),
      store = new Store(db, "tenant", "key"),
      repo = new DurableRepository(db, "key");
    const location = await store.createLocation({
      name: "Fixture",
      latitude: 35.7,
      longitude: 51.4,
    });
    const scan = await repo.reserve(
      "tenant",
      {
        locationId: location!.id,
        source: "snappmarket",
        threshold: 40,
        mode: "partial",
      },
      crypto.randomUUID(),
      true
    );
    await repo.started(scan.id);
    const baselineUnit: Unit = { id: "market-party", kind: "market_party" };
    const campaignUnit: Unit = {
      id: "campaign-1-2",
      kind: "store_campaign",
      vendorId: 1,
      vendorCode: "shop",
      collectionId: 2,
      title: "Shop",
    };
    await repo.freeze(
      scan.id,
      [baselineUnit, campaignUnit],
      scan.context!.manifest
    );
    const offer = {
      key: "1:2",
      productVariationId: "2",
      vendorId: "1",
      title: "Milk",
      image: null,
      vendorTitle: "Shop",
      vendorCode: "shop",
      categoryTitle: null,
      priceRials: 100000,
      discountRials: 40000,
      finalPriceRials: 60000,
      discountRatio: 40,
      stock: 2,
      observedAt: "2026-10-10T08:00:00.000Z",
      provenance: ["snapp:market_party"],
    };
    await repo.stage(scan.id, baselineUnit, 0, {
      offers: [offer],
      products: ["1:2"],
      vendors: ["1"],
      identities: ["1:2"],
      eligibility: { "1:2": { eligible: true, excludedReason: null } },
      rowCount: 1,
      reportedTotal: 1,
      terminal: true,
      terminalEvidence: "fixture_terminal",
      fingerprint: "baseline",
    });
    const product = (productId: number, stock = 2) => ({
      id: productId,
      vendor_id: 1,
      document_id: `${productId}-1`,
      title: productId === 2 ? "Milk" : "Bread",
      price: 100000,
      discount: 40000,
      discountRatio: 40,
      stock,
    });
    const read = async (url: URL) => {
      const page = Number(url.searchParams.get("page"));
      const products =
        page === 0
          ? [product(2), product(3)]
          : page === 1
            ? [product(2, 3)]
            : [];
      return {
        status: true,
        data: {
          id: 2,
          type: "default",
          count: 3,
          finalResult: products.map((data) => ({ type: "PRODUCT", data })),
        },
      };
    };
    let previous = await repo.pages(scan.id, campaignUnit.id);
    for (let page = 0; page <= 2; page++) {
      const data = await collectPage(
        await repo.check(scan.id),
        campaignUnit,
        page,
        previous,
        read
      );
      if (page === 0)
        expect(data.offers.map((item) => item.key)).toEqual(["1:2", "1:3"]);
      if (page === 1) {
        expect(data.conflictingIdentities).toEqual(["1:2"]);
        expect(data.offers).toEqual([]);
      }
      await repo.stage(scan.id, campaignUnit, page, data);
      previous = await repo.pages(scan.id, campaignUnit.id);
    }
    await materializeProducts(db, "tenant", scan.id);
    await repo.publish(scan.id);
    expect(await store.scan(scan.id)).toMatchObject({
      status: "succeeded",
      context: { coverage: "incomplete" },
    });
    expect(await store.deals(scan.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          productVariationId: "3",
          provenance: ["snapp:store_campaign:1:2"],
        }),
        expect.objectContaining({
          productVariationId: "2",
          priceRials: 100000,
          provenance: ["snapp:market_party"],
        }),
      ])
    );
    expect(await readDurableComparison(db, "tenant", scan.id)).toMatchObject({
      complete: false,
      campaigns: [
        {
          coverage: "incomplete",
          excluded: { CONFLICTING_DUPLICATE: 1 },
        },
      ],
    });
  });
  it("comparison measures incremental union contributions and requires publication for completeness", async () => {
    const { db } = database(),
      store = new Store(db, "tenant", "key"),
      repo = new DurableRepository(db, "key");
    const location = await store.createLocation({
      name: "Fixture",
      latitude: 35.7,
      longitude: 51.4,
    });
    const scan = await repo.reserve(
      "tenant",
      {
        locationId: location!.id,
        source: "snappmarket",
        threshold: 40,
        mode: "partial",
      },
      crypto.randomUUID(),
      false
    );
    await repo.started(scan.id);
    const units: Unit[] = [
      { id: "baseline", kind: "market_party" },
      { id: "campaign-a", kind: "store_campaign" },
      { id: "campaign-b", kind: "store_campaign" },
      { id: "campaign-c", kind: "store_campaign" },
    ];
    await repo.freeze(scan.id, units, scan.context!.manifest);
    const eligible = { eligible: true, excludedReason: null };
    const excluded = { eligible: false, excludedReason: "BELOW_THRESHOLD" };
    expect(await readDurableComparison(db, "tenant", scan.id)).toMatchObject({
      complete: false,
      planning: null,
      omitted: null,
      campaigns: [
        { outcome: "incomplete" },
        { outcome: "incomplete" },
        { outcome: "incomplete" },
      ],
    });
    for (const [index, unit] of units.entries()) {
      const eligibility: NonNullable<Page["eligibility"]> =
        index === 0
          ? { "1:1": eligible }
          : index === 1
            ? { "1:1": eligible, "1:2": eligible, "1:3": excluded }
            : index === 2
              ? { "1:2": eligible }
              : { "1:3": excluded };
      const identities = Object.keys(eligibility);
      await repo.stage(scan.id, unit, 0, {
        offers: [],
        products: identities,
        vendors: ["1"],
        identities,
        eligibility,
        rowCount: identities.length,
        reportedTotal: identities.length,
        terminal: true,
        terminalEvidence: "fixture_terminal",
        fingerprint: unit.id,
      });
    }
    expect(await readDurableComparison(db, "tenant", scan.id)).toMatchObject({
      complete: false,
      baseline: 1,
      supplementary: 2,
      overlap: 1,
      union: 2,
      additional: 1,
      campaigns: [
        {
          overlap: 1,
          additional: 1,
          outcome: "net_new",
          excluded: { BELOW_THRESHOLD: 1 },
        },
        { overlap: 0, additional: 0, outcome: "all_duplicates" },
        { qualifying: 0, additional: 0, outcome: "zero_eligible" },
      ],
    });
    await repo.cancel(scan.id, "tenant");
    expect(await readDurableComparison(db, "tenant", scan.id)).toMatchObject({
      complete: false,
    });
  });

  it("one 401 guest refresh is persisted across an ephemeral session resume", async () => {
    const { db } = database(),
      store = new Store(db, "tenant", "key"),
      repo = new DurableRepository(db, "key");
    const location = await store.createLocation({
      name: "Fixture",
      latitude: 35.7,
      longitude: 51.4,
    });
    const scan = await repo.reserve(
      "tenant",
      {
        locationId: location!.id,
        source: "snappmarket",
        threshold: 40,
        mode: "partial",
      },
      crypto.randomUUID(),
      false
    );
    let access = 0,
      gets = 0;
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname.includes("oauth2")) {
        access++;
        return Response.json({
          status: true,
          data: { access_token: "fixture", expires_in: 1000 },
        });
      }
      gets++;
      return gets === 2
        ? Response.json({ fixture: true })
        : Response.json({ error: "expired" }, { status: 401 });
    };
    const steps = {
      do: async <T extends Rpc.Serializable<T>>(
        _n: string,
        a: () => Promise<T>
      ) => a(),
      sleep: async () => {},
    };
    const url = new URL("https://svc.snapp.market/fixture");
    expect(
      await providerReader(repo, scan.id, steps, fetcher)(url, "first-page")
    ).toEqual({ fixture: true });
    expect(access).toBe(2);
    await expect(
      providerReader(repo, scan.id, steps, fetcher)(url, "second-page")
    ).rejects.toMatchObject({ code: "GUEST_AUTH_REJECTED" });
    expect(access).toBe(3);
    expect(gets).toBe(3);
    expect((await repo.load(scan.id))!.runtime.attempt_count).toBe(6);
  });
  it("reuses a tenant start intent and rejects changed input without another reservation", async () => {
    const { db } = database(),
      store = new Store(db, "tenant", "key"),
      repo = new DurableRepository(db, "key");
    const loc = await store.createLocation({
      name: "Fixture",
      latitude: 35.7,
      longitude: 51.4,
    });
    const input = {
      locationId: loc!.id,
      source: "snappmarket" as const,
      threshold: 40,
      mode: "partial" as const,
    };
    const key = crypto.randomUUID();
    const first = await repo.reserve("tenant", input, key, false);
    expect((await repo.reserve("tenant", input, key, false)).id).toBe(first.id);
    await expect(
      repo.reserve("tenant", { ...input, threshold: 50 }, key, false)
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("admits independent users and continues requests beyond the former scan budget", async () => {
    const { db, sqlite } = database(),
      repo = new DurableRepository(db, "key");
    const input = async (user: string) => {
      const location = await new Store(db, user, "key").createLocation({
        name: "Fixture",
        latitude: 35.7,
        longitude: 51.4,
      });
      return {
        locationId: location!.id,
        source: "snappmarket" as const,
        threshold: 40,
        mode: "partial" as const,
      };
    };
    const a = await input("a"),
      b = await input("b");
    const first = await repo.reserve("a", a, crypto.randomUUID(), false);
    const second = await repo.reserve("b", b, crypto.randomUUID(), false);
    expect(second.status).toBe("queued");
    expect(
      sqlite.prepare("SELECT COUNT(*) AS n FROM scans").get()
    ).toMatchObject({ n: 2 });
    await repo.reserveAttempt(first.id, "get-page");
    await repo.reserveAttempt(first.id, "get-page");
    await repo.reserveAttempt(first.id, "get-page");
    await expect(
      repo.reserveAttempt(first.id, "get-page")
    ).rejects.toMatchObject({ code: "REQUEST_RETRIES_EXHAUSTED" });
    expect((await repo.load(first.id))!.runtime.attempt_count).toBe(3);
    for (let page = 0; page < 260; page++)
      await repo.reserveAttempt(first.id, `page-${page}`);
    expect((await repo.load(first.id))!.runtime.attempt_count).toBe(263);
    await repo.cancel(first.id, "a");
    await expect(
      repo.reserveAttempt(first.id, "another-page")
    ).rejects.toMatchObject({ code: "TERMINAL_SCAN" });
    await expect(
      repo.reserve("b", b, crypto.randomUUID(), false)
    ).rejects.toMatchObject({ code: "SCAN_IN_PROGRESS" });
  });
  it("replays staged pages without inflated counts, rejects conflicting content and never publishes unfinished units", async () => {
    const { db, sqlite } = database(),
      store = new Store(db, "tenant", "key"),
      repo = new DurableRepository(db, "key");
    sqlite.exec(
      "CREATE TABLE IF NOT EXISTS product_projection_scans(user_id TEXT,scan_id TEXT PRIMARY KEY,ready INTEGER)"
    );
    const loc = await store.createLocation({
      name: "Fixture",
      latitude: 35.7,
      longitude: 51.4,
    });
    const scan = await repo.reserve(
      "tenant",
      {
        locationId: loc!.id,
        source: "snappmarket",
        threshold: 40,
        mode: "partial",
      },
      crypto.randomUUID(),
      false
    );
    await repo.started(scan.id);
    const unit: Unit = { id: "baseline", kind: "market_party" };
    await repo.freeze(
      scan.id,
      [unit, { id: "extra", kind: "store_campaign" }],
      scan.context!.manifest
    );
    const offer = {
      key: "1:2",
      productVariationId: "2",
      vendorId: "1",
      title: "Milk 1 L",
      image: null,
      vendorTitle: "Shop",
      vendorCode: null,
      categoryTitle: null,
      priceRials: 100000,
      discountRials: 50000,
      finalPriceRials: 50000,
      discountRatio: 50,
      stock: 2,
    };
    const page: Page = {
      offers: [offer],
      products: ["1:2"],
      vendors: ["1"],
      identities: ["1"],
      rowCount: 1,
      reportedTotal: 1,
      terminal: true,
      terminalEvidence: "verified_total",
      fingerprint: "first",
    };
    await repo.stage(scan.id, unit, 0, page);
    await repo.stage(scan.id, unit, 0, page);
    expect(await store.deals(scan.id)).toEqual([]);
    expect(await store.scan(scan.id)).toMatchObject({
      status: "running",
      vendorCount: 1,
      productCount: 1,
      dealCount: 1,
    });
    await expect(
      repo.stage(scan.id, unit, 0, {
        ...page,
        offers: [{ ...offer, stock: 3 }],
      })
    ).rejects.toMatchObject({ code: "INCOMPLETE_PAGINATION" });
    await expect(repo.publish(scan.id)).rejects.toMatchObject({
      code: "INCOMPLETE_PAGINATION",
    });
    await repo.cancel(scan.id, "tenant");
    await expect(
      repo.stage(scan.id, { id: "extra", kind: "store_campaign" }, 0, page)
    ).rejects.toMatchObject({ code: "TERMINAL_SCAN" });
    expect(await store.scan(scan.id)).toMatchObject({ status: "cancelled" });
    expect(await store.deals(scan.id)).toEqual([]);
  });
  it("a resumed chunk ledger finishes the same page without duplicates, then publishes all completed units", async () => {
    const { db, sqlite } = database(),
      store = new Store(db, "tenant", "key"),
      repo = new DurableRepository(db, "key");
    sqlite.exec(
      "CREATE TABLE IF NOT EXISTS product_projection_scans(user_id TEXT,scan_id TEXT PRIMARY KEY,ready INTEGER)"
    );
    const loc = await store.createLocation({
      name: "Fixture",
      latitude: 35.7,
      longitude: 51.4,
    });
    const scan = await repo.reserve(
      "tenant",
      {
        locationId: loc!.id,
        source: "snappmarket",
        threshold: 40,
        mode: "partial",
      },
      crypto.randomUUID(),
      false
    );
    await repo.started(scan.id);
    const unit: Unit = { id: "baseline", kind: "market_party" };
    await repo.freeze(scan.id, [unit], scan.context!.manifest);
    const page: Page = {
      offers: Array.from({ length: 25 }, (_, n) => ({
        key: `1:${n}`,
        productVariationId: String(n),
        vendorId: "1",
        title: `Product ${n}`,
        image: null,
        vendorTitle: "Shop",
        vendorCode: null,
        categoryTitle: null,
        priceRials: 100000,
        discountRials: 50000,
        finalPriceRials: 50000,
        discountRatio: 50,
        stock: 2,
      })),
      products: Array.from({ length: 25 }, (_, n) => `1:${n}`),
      vendors: ["1"],
      identities: ["1"],
      rowCount: 1,
      reportedTotal: 1,
      terminal: true,
      terminalEvidence: "verified_total",
      fingerprint: "first",
    };
    const batch = db.batch.bind(db);
    let calls = 0;
    db.batch = async (statements) => {
      if (++calls === 2) throw new Error("simulated runtime interruption");
      return batch(statements);
    };
    await expect(repo.stage(scan.id, unit, 0, page)).rejects.toThrow(
      "interruption"
    );
    expect(await repo.checkpoint(scan.id, unit.id, 0)).toBeNull();
    db.batch = batch;
    await repo.stage(scan.id, unit, 0, page);
    expect(await store.scan(scan.id)).toMatchObject({
      dealCount: 25,
      productCount: 25,
      vendorCount: 1,
    });
    sqlite
      .prepare(
        "INSERT INTO product_projection_scans(user_id,scan_id,ready,baseline_reason,observed_at) VALUES(?,?,1,'scope_mismatch','2026-10-10T00:00:00.000Z')"
      )
      .run("tenant", scan.id);
    await repo.publish(scan.id);
    expect(await store.deals(scan.id)).toHaveLength(25);
    const another = new DurableRepository(db, "key");
    expect(await another.load(scan.id, "another")).toBeNull();
  });
  it("collects real provider pages with persisted retry attempts and preserves committed pages on replay", async () => {
    const { db, sqlite } = database(),
      store = new Store(db, "tenant", "key"),
      repo = new DurableRepository(db, "key");
    sqlite.exec(
      "CREATE TABLE IF NOT EXISTS product_projection_scans(user_id TEXT,scan_id TEXT PRIMARY KEY,ready INTEGER)"
    );
    const loc = await store.createLocation({
      name: "Fixture",
      latitude: 35.7,
      longitude: 51.4,
    });
    const scan = await repo.reserve(
      "tenant",
      {
        locationId: loc!.id,
        source: "snappmarket",
        threshold: 40,
        mode: "partial",
      },
      crypto.randomUUID(),
      false
    );
    let requests = 0,
      pageRequests = 0;
    const devices = new Set<string>();
    const fetcher: typeof fetch = async (input) => {
      requests++;
      const url = new URL(String(input));
      devices.add(url.searchParams.get("UDID")!);
      if (url.pathname.includes("oauth2"))
        return Response.json({
          status: true,
          data: { access_token: "fixture-only", expires_in: 1000 },
        });
      if (++pageRequests === 1)
        return new Response(null, {
          status: 503,
          headers: { "retry-after": "0" },
        });
      const p = Number(url.searchParams.get("page"));
      return Response.json({
        status: true,
        data: {
          total_count: 2,
          vendors: [
            {
              vendor_id: p + 1,
              products: [
                {
                  vendorId: p + 1,
                  productVariationId: p + 10,
                  price: 100000,
                  discount: 50000,
                  discountRatio: 50,
                  title: `Milk ${p}`,
                  vendorTitle: "Store",
                  stock: 3,
                },
              ],
            },
          ],
        },
      });
    };
    const outputs: unknown[] = [];
    const steps = {
      do: async <T extends Rpc.Serializable<T>>(
        _name: string,
        action: () => Promise<T>
      ) => {
        const value = await action();
        outputs.push(value);
        return value;
      },
      sleep: async () => {},
    };
    const materialize = async () => {
      await db
        .prepare(
          "INSERT INTO product_projection_scans(user_id,scan_id,ready,baseline_reason,observed_at) VALUES(?,?,1,'scope_mismatch','2026-10-10T00:00:00.000Z')"
        )
        .bind("tenant", scan.id)
        .run();
    };
    await runDurableScan(
      { scanId: scan.id, contractVersion: 1 },
      { repository: repo, steps, fetcher, materialize }
    );
    expect(await store.scan(scan.id)).toMatchObject({
      status: "succeeded",
      vendorCount: 2,
      productCount: 2,
      dealCount: 2,
    });
    expect(requests).toBe(4);
    expect(devices.size).toBe(1);
    expect((await repo.load(scan.id))!.runtime.attempt_count).toBe(4);
    expect(JSON.stringify(outputs)).not.toContain("fixture-only");
    expect(JSON.stringify(outputs)).not.toContain("priceRials");
    await runDurableScan(
      { scanId: scan.id, contractVersion: 1 },
      { repository: repo, steps, fetcher, materialize }
    );
    expect(requests).toBe(4);
  });
  it("uncertain engine reads and the legacy stale policy do not fail a healthy durable update", async () => {
    const { db, sqlite } = database(),
      store = new Store(db, "tenant", "key"),
      repo = new DurableRepository(db, "key");
    const loc = await store.createLocation({
      name: "Fixture",
      latitude: 35.7,
      longitude: 51.4,
    });
    const scan = await repo.reserve(
      "tenant",
      {
        locationId: loc!.id,
        source: "snappmarket",
        threshold: 40,
        mode: "partial",
      },
      crypto.randomUUID(),
      false
    );
    await repo.started(scan.id);
    await repo.dispatchState(scan.id, "dispatched");
    sqlite
      .prepare("UPDATE scans SET created_at=? WHERE id=?")
      .run(new Date(Date.now() - 30 * 60_000).toISOString(), scan.id);
    sqlite
      .prepare("UPDATE scan_execution SET queued_until=? WHERE scan_id=?")
      .run(new Date(Date.now() - 20 * 60_000).toISOString(), scan.id);
    await store.reconcileStale();
    await reconcileDurableScan(
      {
        DB: db,
        BOX_KEY: "key",
        SCAN_WORKFLOW: {
          get: async () => {
            throw new Error("network unavailable");
          },
          create: async () => {
            throw new Error("network unavailable");
          },
        },
      },
      "tenant",
      scan.id
    );
    expect(await store.scan(scan.id)).toMatchObject({ status: "running" });
  });
  it("legacy rollback reuses the same start intent and executes once with frozen coordinates", async () => {
    const { db } = database(),
      store = new Store(db, "tenant", "key");
    const loc = await store.createLocation({
      name: "Fixture",
      latitude: 35.7,
      longitude: 51.4,
    });
    const input = {
        locationId: loc!.id,
        source: "okala" as const,
        threshold: 20,
        mode: "partial" as const,
      },
      key = crypto.randomUUID();
    const first = await beginLegacyScan(
      { DB: db, BOX_KEY: "key" },
      "tenant",
      input,
      key
    );
    expect(first.job).toMatchObject({
      threshold: 30,
      location: { latitude: 35.7, longitude: 51.4 },
    });
    const repeated = await beginLegacyScan(
      { DB: db, BOX_KEY: "key" },
      "tenant",
      input,
      key
    );
    expect(repeated.scan!.id).toBe(first.scan!.id);
    expect(repeated.job).toBeNull();
  });
  it("campaign raw totals allow exact repeats and quarantine conflicting identities", async () => {
    for (const conflict of [false, true]) {
      const { db, sqlite } = database(),
        store = new Store(db, "tenant", "key"),
        repo = new DurableRepository(db, "key");
      sqlite.exec(
        "CREATE TABLE IF NOT EXISTS product_projection_scans(user_id TEXT,scan_id TEXT PRIMARY KEY,ready INTEGER)"
      );
      const loc = await store.createLocation({
        name: "Fixture",
        latitude: 35.7,
        longitude: 51.4,
      });
      const scan = await repo.reserve(
        "tenant",
        {
          locationId: loc!.id,
          source: "snappmarket",
          threshold: 40,
          mode: "partial",
        },
        crypto.randomUUID(),
        false
      );
      await repo.started(scan.id);
      const unit: Unit = {
        id: "campaign",
        kind: "store_campaign",
        vendorId: 9,
        vendorCode: "shop",
        collectionId: 12,
        title: "Store",
      };
      await repo.freeze(scan.id, [unit], {
        ...scan.context!.manifest,
        feedKinds: ["store_campaign"],
        storeCampaigns: [{ vendorId: 9, vendorCode: "shop", collectionId: 12 }],
      });
      const product = (id: number, price = 100000) => ({
        id,
        vendor_id: 9,
        document_id: `${id}-9`,
        title: `Product ${id}`,
        price,
        discount: price / 2,
        discountRatio: 50,
        stock: 1,
        no_stock: false,
      });
      const fetcher: typeof fetch = async (input) => {
        const url = new URL(String(input));
        if (url.pathname.includes("oauth2"))
          return Response.json({
            status: true,
            data: { access_token: "fixture", expires_in: 1000 },
          });
        const p = Number(url.searchParams.get("page"));
        const rows =
          p === 0
            ? [product(1), product(2)]
            : p === 1
              ? [product(2, conflict ? 200000 : 100000), product(3)]
              : [];
        return Response.json({
          data: {
            id: 12,
            type: "default",
            count: 4,
            finalResult: rows.map((data) => ({ type: "PRODUCT", data })),
          },
        });
      };
      const steps = {
        do: async <T extends Rpc.Serializable<T>>(
          _n: string,
          a: () => Promise<T>
        ) => a(),
        sleep: async () => {},
      };
      await runDurableScan(
        { scanId: scan.id, contractVersion: 1 },
        {
          repository: repo,
          steps,
          fetcher,
          materialize: async () => {
            await db
              .prepare(
                "INSERT INTO product_projection_scans(user_id,scan_id,ready,baseline_reason,observed_at) VALUES(?,?,1,'scope_mismatch','2026-10-10T00:00:00.000Z')"
              )
              .bind("tenant", scan.id)
              .run();
          },
        }
      );
      expect(await store.scan(scan.id)).toMatchObject(
        conflict
          ? {
              status: "succeeded",
              dealCount: 2,
              context: { coverage: "incomplete" },
            }
          : { status: "succeeded", productCount: 3, dealCount: 3 }
      );
      if (conflict) {
        expect(
          (await store.deals(scan.id)).map((deal) => deal.productVariationId)
        ).toEqual(["1", "3"]);
        expect(
          await readDurableComparison(db, "tenant", scan.id)
        ).toMatchObject({
          complete: false,
          campaigns: [
            {
              coverage: "incomplete",
              excluded: { CONFLICTING_DUPLICATE: 1 },
            },
          ],
        });
      } else {
        expect(
          await readDurableComparison(db, "tenant", scan.id)
        ).toMatchObject({
          baseline: 0,
          supplementary: 3,
          union: 3,
          additional: 3,
          campaigns: [
            {
              rawCount: 4,
              uniqueCount: 3,
              qualifying: 3,
              overlap: 0,
              additional: 3,
              outcome: "net_new",
            },
          ],
        });
        expect(await readDurableComparison(db, "other", scan.id)).toBeNull();
      }
    }
  });
  it("Okala durable units preserve threshold normalization and reject unverified additional pages", async () => {
    for (const hasNextPage of [false, true]) {
      const { db, sqlite } = database(),
        store = new Store(db, "tenant", "key"),
        repo = new DurableRepository(db, "key");
      sqlite.exec(
        "CREATE TABLE IF NOT EXISTS product_projection_scans(user_id TEXT,scan_id TEXT PRIMARY KEY,ready INTEGER)"
      );
      const loc = await store.createLocation({
        name: "Fixture",
        latitude: 35.7,
        longitude: 51.4,
      });
      const scan = await repo.reserve(
        "tenant",
        {
          locationId: loc!.id,
          source: "okala",
          threshold: 20,
          mode: "partial",
        },
        crypto.randomUUID(),
        false
      );
      const fetcher: typeof fetch = async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/nearby"))
          return Response.json({
            success: true,
            data: {
              stores: [
                { storeId: 5, isActive: true, isExist: true, isServes: true },
              ],
            },
          });
        if (url.pathname.endsWith("/multi-store"))
          return Response.json({
            carousel: { id: 7 },
            hasNextPage,
            entities: [
              {
                storeId: 5,
                storeName: "Store",
                products: [
                  {
                    id: 2,
                    storeId: 5,
                    name: "Milk 1 L",
                    storeName: "Store",
                    price: 10000,
                    okPrice: 7000,
                    discountPercent: 30,
                    hasQuantity: true,
                    quantity: 1,
                  },
                  {
                    id: 3,
                    storeId: 5,
                    name: "Surcharge item",
                    storeName: "Store",
                    price: 10000,
                    okPrice: 10700,
                    discountPercent: -7,
                    hasQuantity: true,
                    quantity: 1,
                  },
                ],
              },
            ],
          });
        return Response.json({
          success: true,
          carousels: [{ isMulti: true, id: 7 }],
        });
      };
      const steps = {
        do: async <T extends Rpc.Serializable<T>>(
          _n: string,
          a: () => Promise<T>
        ) => a(),
        sleep: async () => {},
      };
      await runDurableScan(
        { scanId: scan.id, contractVersion: 1 },
        {
          repository: repo,
          steps,
          fetcher,
          materialize: async () => {
            await db
              .prepare(
                "INSERT INTO product_projection_scans(user_id,scan_id,ready,baseline_reason,observed_at) VALUES(?,?,1,'scope_mismatch','2026-10-10T00:00:00.000Z')"
              )
              .bind("tenant", scan.id)
              .run();
          },
        }
      );
      expect(await store.scan(scan.id)).toMatchObject(
        hasNextPage
          ? {
              status: "failed",
              errorCode: "INCOMPLETE_PAGINATION",
              threshold: 30,
            }
          : { status: "succeeded", threshold: 30, dealCount: 1 }
      );
    }
  });
  it("ambiguous dispatch uses the same deterministic instance and a terminal scan is never recreated", async () => {
    const { db } = database(),
      store = new Store(db, "tenant", "key"),
      repo = new DurableRepository(db, "key");
    const loc = await store.createLocation({
      name: "Fixture",
      latitude: 35.7,
      longitude: 51.4,
    });
    const ids: string[] = [],
      payloads: unknown[] = [];
    let created = false;
    const instance = {
      status: async () => ({ status: "queued" }),
      terminate: async () => {},
    } as unknown as WorkflowInstance;
    const env = {
      DB: db,
      BOX_KEY: "key",
      SCAN_WORKFLOW: {
        get: async (id: string) => {
          ids.push(id);
          if (!created)
            throw Object.assign(new Error("missing"), { status: 404 });
          return instance;
        },
        create: async (options: { id: string; params: unknown }) => {
          ids.push(options.id);
          payloads.push(options.params);
          created = true;
          throw new Error("response lost");
        },
      },
    };
    const key = crypto.randomUUID(),
      input = {
        locationId: loc!.id,
        source: "snappmarket" as const,
        threshold: 40,
        mode: "partial" as const,
      };
    const first = await beginDurableScan(env, "tenant", input, key);
    await beginDurableScan(env, "tenant", input, key);
    expect(new Set(ids).size).toBe(1);
    expect(payloads).toEqual([{ scanId: first.id, contractVersion: 1 }]);
    await repo.cancel(first.id, "tenant");
    await reconcileDurableScan(env, "tenant", first.id);
    expect(payloads).toHaveLength(1);
  });
});
