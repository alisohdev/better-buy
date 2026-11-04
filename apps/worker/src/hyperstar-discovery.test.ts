import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { collectDeals } from "./providers/snapp/collector";
import {
  enrichStoreCampaigns,
  planStoreCampaigns,
  type SnappRead,
} from "./providers/snapp/storeCampaigns";

function fixture(
  options: {
    hint?: unknown;
    stores?: string[];
    delivery?: Record<string, unknown>;
    sections?: boolean;
    categoryCount?: number;
    categoryRows?: (page: number) => Record<string, unknown>[];
    campaignCount?: number;
    campaignIds?: number[];
    latitude?: number;
    enabled?: boolean;
    categoryTerminal204?: boolean;
    outOfArea?: boolean;
    ordinaryCampaigns?: boolean;
    nearbyStatus?: number;
    categoryReportedCount?: (page: number) => number;
  } = {}
) {
  const calls: URL[] = [];
  const scopes: unknown[] = [];
  const latitude = options.latitude ?? 35.7;
  const branch = latitude === 35.7 ? "branchA" : "branchB";
  const vendorId = latitude === 35.7 ? 61 : 62;
  const product = (id: number, extra: Record<string, unknown> = {}) => ({
    id,
    vendor_id: vendorId,
    document_id: `${id}-${vendorId}`,
    title: `Item ${id}`,
    price: 100000,
    discount: 50000,
    discountRatio: 50,
    stock: 3,
    root_category_id: 71,
    ...extra,
  });
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(url);
    if (url.pathname.endsWith("/token"))
      return Response.json({
        status: true,
        data: { access_token: "fixture", expires_in: 3600 },
      });
    if (url.pathname.startsWith("/market-party/"))
      return Response.json({
        status: true,
        data: { total_count: 0, vendors: [] },
      });
    expect(url.searchParams.get("lat")).toBe(String(latitude));
    expect(url.searchParams.get("long")).toBe("51.4");
    if (url.pathname.includes("vendors-list") && options.nearbyStatus)
      return new Response(null, {
        status: options.nearbyStatus,
        headers: { "retry-after": "0" },
      });
    if (url.pathname.includes("vendors-list"))
      return Response.json({
        status: true,
        data: {
          count: (options.stores ?? []).length,
          finalResult: (options.stores ?? []).map((code) => ({
            type: "VENDOR",
            data: { code, id: 999 },
          })),
          single_super_mall:
            "hint" in options
              ? options.hint
              : { code: branch, title: "Hint title" },
        },
      });
    if (url.pathname.includes("/express-home/")) {
      const code = url.pathname.split("/").at(-1)!;
      const homeId =
        code === branch ? vendorId : 90 + Number(code.replace("shop", ""));
      return Response.json({
        vendorInfo: {
          id: homeId,
          code,
          title: "Verified store",
          isOpen: true,
          isOutOfArea: options.outOfArea ?? false,
          deliveryData: options.delivery ?? {
            doesDeliver: true,
            id: homeId,
            isExpress: false,
            scheduleOption: {
              id: 5,
              start: "09:00",
              end: "12:00",
              date: "2026-10-12",
            },
          },
        },
        sections:
          options.sections === false ||
          (code !== branch && !options.ordinaryCampaigns)
            ? []
            : (options.campaignIds ?? [81]).map((value) => ({
                type: "product-list",
                value,
                collection_type: "default",
                config: null,
              })),
      });
    }
    if (url.pathname === "/mobile/search/categories") {
      expect(url.searchParams.get("vendorCode")).toBe(branch);
      return Response.json({
        status: true,
        items: [{ id: 71, sub_categories: [{ id: 72 }] }, { id: 71 }],
      });
    }
    const page = Number(url.searchParams.get("page"));
    const category = url.pathname === "/express-search/product-list/vendor";
    if (category && options.categoryTerminal204 && page > 0)
      return new Response(null, { status: 204 });
    if (category) {
      expect(url.searchParams.get("vendor_code")).toBe(branch);
      expect(url.searchParams.get("category_id")).toBe("71");
      expect(url.searchParams.get("filters")).toBe('["has_discount"]');
      expect(url.searchParams.get("pageSize")).toBe("100");
    }
    const count = category
      ? (options.categoryReportedCount?.(page) ?? options.categoryCount ?? 2)
      : (options.campaignCount ?? 1);
    const rows = category
      ? (options.categoryRows?.(page) ?? (page ? [] : [product(1), product(2)]))
      : count > 700
        ? Array.from(
            { length: Math.min(100, Math.max(0, count - page * 100)) },
            (_, i) => product(page * 100 + i + 1)
          )
        : page
          ? []
          : [product(1)];
    return Response.json({
      status: true,
      ...(category ? { vendor_id: [vendorId] } : {}),
      data: {
        ...(category
          ? {}
          : { id: Number(url.pathname.split("/").at(-3)), type: "default" }),
        count,
        finalResult: rows.map((data) => {
          const code = url.pathname.split("/").at(-1)!;
          const actualOwner =
            category || code === branch
              ? vendorId
              : 90 + Number(code.replace("shop", ""));
          return {
            type: "PRODUCT",
            data: {
              ...data,
              ...(category || code === branch
                ? {}
                : {
                    vendor_id: actualOwner,
                    document_id: `${data.id}-${actualOwner}`,
                  }),
            },
          };
        }),
      },
    });
  };
  return {
    calls,
    scopes,
    product,
    fetcher,
    run: () =>
      Effect.runPromise(
        collectDeals({
          latitude,
          longitude: 51.4,
          threshold: 40,
          storeCampaigns: options.enabled ?? true,
          fetcher,
          onManifest: (values) =>
            Effect.sync(() => {
              scopes.push(values);
            }),
        })
      ),
  };
}

describe("location-scoped super-mall discovery", () => {
  it("discovers every supported hinted campaign before category supplements without a two-scope cap", async () => {
    const f = fixture({ campaignIds: [81, 82, 83, 84] });
    const r = await f.run();
    expect(
      "campaignResearch" in r &&
        r.campaignResearch.reports.map((p) => p.collectionId)
    ).toEqual([81, 82, 83, 84, 71]);
    expect(
      f.calls
        .filter(
          (u) =>
            u.pathname.includes("product-list") &&
            u.searchParams.get("page") === "0"
        )
        .map((u) => u.pathname)
    ).toEqual([
      ...[81, 82, 83, 84].map(
        (id) => `/express-search/product-list/${id}/vendor/branchA`
      ),
      "/express-search/product-list/vendor",
    ]);
    expect(r.deals[0]?.provenance).toHaveLength(5);
  });
  it("uses the shared request budget beyond twelve planning reads for the hinted branch", async () => {
    const f = fixture({
      campaignIds: Array.from({ length: 14 }, (_, i) => 81 + i),
    });
    const r = await f.run();
    expect("campaignResearch" in r && r.campaignResearch.reports).toHaveLength(
      15
    );
    expect(f.calls.length).toBeLessThanOrEqual(40);
  });
  it("retains a valid hint code when optional title metadata is null", async () => {
    expect(
      (await fixture({ hint: { code: "branchA", title: null } }).run()).deals
    ).toHaveLength(2);
  });
  it("keeps all ordinary campaigns alongside the targeted branch supplement", async () => {
    const f = fixture({
      ordinaryCampaigns: true,
      stores: ["shop0", "shop1", "shop2"],
    });
    const r = await f.run();
    expect(r.deals.map((d) => d.key).sort()).toEqual([
      "61:1",
      "61:2",
      "90:1",
      "91:1",
      "92:1",
    ]);
    expect("campaignResearch" in r && r.campaignResearch.reports).toHaveLength(
      5
    );
    expect(f.calls.length).toBeLessThanOrEqual(40);
  });
  it("fails gateway discovery as unknown rather than returning an empty available feed", async () => {
    const f = fixture({ nearbyStatus: 502 });
    await expect(f.run()).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
    expect(f.scopes).toEqual([]);
    expect(f.calls.some((u) => u.pathname.startsWith("/market-party/"))).toBe(
      false
    );
  });
  it("rejects a discounted category count that changes during pagination", async () => {
    await expect(
      fixture({ categoryReportedCount: (page) => (page ? 3 : 2) }).run()
    ).rejects.toThrow("count drift");
  });
  it("preserves a hint title and resolves its scopes regardless of the old budget", async () => {
    const f = fixture();
    const read: SnappRead = (url) =>
      Effect.promise(async () => {
        const response = await f.fetcher(url);
        return { status: response.status, body: await response.json() };
      });
    const r = await Effect.runPromise(
      planStoreCampaigns(read, { latitude: 35.7, longitude: 51.4 })
    );
    expect(r.plans.length).toBeGreaterThan(0);
    expect(r.discoveredCandidates).toEqual([
      {
        vendorCode: "branchA",
        sources: ["single_super_mall"],
        hintTitle: "Hint title",
      },
    ]);
    expect(r.omitted).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: "DISCOVERY_REQUEST_BUDGET" }),
      ])
    );
    expect(f.calls.length).toBeGreaterThan(1);
  });
  it("continues enumeration until the verified empty terminal", async () => {
    const f = fixture();
    let reads = 0;
    const r = await Effect.runPromise(
      enrichStoreCampaigns(
        () => {
          reads++;
          return Effect.succeed({
            status: 200,
            body: {
              status: true,
              data: { id: 81, type: "default", count: 1, finalResult: [] },
            },
          });
        },
        { latitude: 35.7, longitude: 51.4, threshold: 40 },
        [
          {
            vendorId: 61,
            vendorCode: "branchA",
            collectionId: 81,
            title: "Store",
            first: {
              id: 81,
              type: "default",
              count: 1,
              finalResult: [{ type: "PRODUCT", data: f.product(1) }],
            },
          },
        ],
        { vendorCount: 0, productCount: 0, deals: [] },
        new Set(),
        new Set(),
        []
      )
    );
    expect(reads).toBe(1);
    expect(r.deals).toHaveLength(1);
    expect(r.coverage).toBe("complete");
    expect(r.campaignResearch.reports[0]).toMatchObject({
      terminal: true,
      coverage: "complete",
    });
  });
  it("resolves a separate hint and merges campaign/category duplicates with provenance", async () => {
    const f = fixture();
    const r = await f.run();
    expect(r.deals.map((d) => d.key)).toEqual(["61:1", "61:2"]);
    expect(r.deals[0]?.vendorTitle).toBe("Verified store");
    expect(r.deals[0]?.provenance).toEqual([
      "snapp:discounted_category:61:71",
      "snapp:store_campaign:61:81",
    ]);
    expect("campaignResearch" in r && r.campaignResearch).toMatchObject({
      reports: [{ additional: 1 }, { additional: 1 }],
      enrichedEligible: 2,
    });
  });
  it("resolves a hint duplicated in ordinary rows exactly once and gives it budget priority", async () => {
    const f = fixture({
      stores: [
        ...Array.from({ length: 20 }, (_, i) => `shop${i}`),
        "branchA",
        "branchA",
      ],
    });
    await f.run();
    const homes = f.calls.filter((u) => u.pathname.includes("/express-home/"));
    expect(homes[0]?.pathname).toBe("/express-home/vendor/branchA");
    expect(homes.filter((u) => u.pathname.endsWith("/branchA"))).toHaveLength(
      1
    );
    expect(f.calls.length).toBeLessThanOrEqual(40);
  });
  it.each([undefined, null, {}, { code: "bad/code" }])(
    "keeps ordinary discovery when hint is absent/malformed: %j",
    async (hint) => {
      const f = fixture({ hint, stores: ["branchA"] });
      const r = await f.run();
      expect(r.deals).toHaveLength(1);
      expect(
        f.calls.some((u) => u.pathname === "/mobile/search/categories")
      ).toBe(false);
    }
  );
  it("refreshes identity and delivery at a second location", async () => {
    const a = fixture(),
      b = fixture({ latitude: 35.8, delivery: { doesDeliver: false, id: 62 } });
    expect((await a.run()).deals).toHaveLength(2);
    expect((await b.run()).deals).toEqual([]);
    expect(b.calls.some((u) => u.pathname.endsWith("/branchB"))).toBe(true);
    expect(b.calls.some((u) => u.pathname.endsWith("/branchA"))).toBe(false);
    expect(b.calls.some((u) => u.pathname.includes("product-list"))).toBe(
      false
    );
  });
  it("uses discounted categories when no ordinary collection is available", async () => {
    const f = fixture({ sections: false });
    expect((await f.run()).deals).toHaveLength(2);
  });
  it("accepts a live category 204 terminal only after covering the prior reported count", async () => {
    const f = fixture({ categoryTerminal204: true });
    const r = await f.run();
    expect(r.deals).toHaveLength(2);
    expect("campaignResearch" in r && r.campaignResearch).toMatchObject({
      reports: [{ terminal: true }, { terminal: true, pageSizes: [2, 0] }],
    });
    await expect(
      fixture({ categoryTerminal204: true, categoryCount: 3 }).run()
    ).rejects.toThrow("empty terminal before");
  });
  it("rejects an explicitly out-of-area home despite a positive delivery flag", async () => {
    expect((await fixture({ outOfArea: true }).run()).deals).toEqual([]);
  });
  it.each([
    { doesDeliver: true, isExpress: false, scheduleOption: null },
    { doesDeliver: true, deliveryStatus: "NOT_OPEN" },
  ])(
    "rejects explicit unavailable scheduled delivery: %j",
    async (delivery) => {
      expect((await fixture({ delivery }).run()).deals).toEqual([]);
    }
  );
  it("continues short category pages beyond three pages to the verified terminal", async () => {
    const f = fixture({
      categoryCount: 12,
      categoryRows: (page) =>
        page >= 6
          ? []
          : Array.from({ length: 2 }, (_, i) => ({
              id: 200 + page * 2 + i,
              vendor_id: 61,
              document_id: `${200 + page * 2 + i}-61`,
              title: "Item",
              price: 100000,
              discount: 50000,
              discountRatio: 50,
              stock: 3,
            })),
    });
    const r = await f.run();
    expect("coverage" in r && r.coverage).toBe("complete");
    expect("campaignResearch" in r && r.campaignResearch).toMatchObject({
      reports: [
        { terminal: true },
        {
          reportedCount: 12,
          rawCount: 12,
          pageSizes: [2, 2, 2, 2, 2, 2, 0],
          terminal: true,
          coverage: "complete",
        },
      ],
    });
  });
  it("fails category replay, drift and owner contradictions", async () => {
    const replay = fixture({
      categoryCount: 4,
      categoryRows: () => [replay.product(2), replay.product(3)],
    });
    await expect(replay.run()).rejects.toThrow("replayed page");
    const wrong = fixture({
      categoryRows: (page) =>
        page ? [] : [wrong.product(2, { vendor_id: 999 })],
    });
    await expect(wrong.run()).rejects.toThrow("ownership");
  });
  it.each([
    { doesDeliver: true, id: 999 },
    { doesDeliver: true, detail: { vendorId: 999 } },
    { doesDeliver: false, isExpress: false, scheduleOption: { id: 5 } },
    { isExpress: false, scheduleOption: { id: 5 } },
  ])(
    "rejects contradictory owners and delivery that is false or unknown: %j",
    async (delivery) => {
      const f = fixture({ delivery });
      expect((await f.run()).deals).toEqual([]);
      expect(f.calls.some((u) => u.pathname.includes("product-list"))).toBe(
        false
      );
    }
  );
  it("continues hinted collections beyond eight pages to the verified terminal", async () => {
    const f = fixture({ campaignCount: 2000 });
    const r = await f.run();
    expect(r.deals.length).toBeGreaterThan(0);
    expect("coverage" in r && r.coverage).toBe("complete");
    expect("campaignResearch" in r && r.campaignResearch).toMatchObject({
      reports: [
        {
          reportedCount: 2000,
          rawCount: 2000,
          terminal: true,
          coverage: "complete",
        },
        { terminal: true },
      ],
    });
    expect(
      f.calls.filter((u) => u.pathname.includes("/81/vendor/"))
    ).toHaveLength(21);
    expect(f.calls.length).toBeLessThanOrEqual(40);
  });
  it("completes a 5000-row hinted collection beyond the former shared request budget", async () => {
    const f = fixture({ campaignCount: 5000 });
    const r = await f.run();
    expect(r.deals.length).toBeGreaterThan(0);
    expect("coverage" in r && r.coverage).toBe("complete");
    expect(
      "campaignResearch" in r && r.campaignResearch.reports[0]
    ).toMatchObject({
      reportedCount: 5000,
      terminal: true,
      coverage: "complete",
    });
    expect(f.calls.length).toBeGreaterThan(40);
    expect(
      f.calls.filter((u) => u.pathname.includes("/81/vendor/"))
    ).toHaveLength(51);
  });
  it("rejects a discount-filter response containing undiscounted products", async () => {
    const f = fixture({
      categoryRows: (page) =>
        page
          ? []
          : [
              {
                id: 2,
                vendor_id: 61,
                document_id: "2-61",
                title: "Item",
                price: 100000,
                discount: 0,
                discountRatio: null,
                stock: 3,
              },
            ],
    });
    const r = await f.run();
    expect(r.deals).toHaveLength(1);
    expect("campaignResearch" in r && r.campaignResearch).toMatchObject({
      omitted: expect.arrayContaining([
        expect.objectContaining({
          reason: expect.stringContaining("DISCOUNT_FILTER"),
        }),
      ]),
    });
  });
  it("rollback performs only the existing baseline", async () => {
    const f = fixture({ enabled: false });
    await f.run();
    expect(f.calls.some((u) => u.pathname.includes("vendors-list"))).toBe(
      false
    );
  });
});
