import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectDeals } from "./providers/snapp/collector";

const home = () => ({
  vendorInfo: {
    id: 114458,
    code: "pz91qe",
    title: "Store",
    deliveryData: {
      doesDeliver: true,
      id: 114458,
      detail: { vendorId: 114458 },
    },
  },
  sections: [
    {
      type: "product-list",
      value: 901,
      title: "اسمارت بازار",
      collection_type: "default",
      config: null,
    },
  ],
});
const product = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  vendor_id: 114458,
  document_id: `${id}-114458`,
  title: `Product ${id}`,
  price: 100000,
  discount: 40000,
  discountRatio: 40,
  stock: 2,
  ...extra,
});
const party = () => ({
  status: true,
  data: {
    total_count: 1,
    vendors: [
      {
        vendor_id: 114458,
        products: [
          {
            productVariationId: 1,
            vendorId: 114458,
            vendorCode: "pz91qe",
            vendorTitle: "Store",
            title: "Product 1",
            price: 100000,
            discount: 40000,
            discountRatio: 40,
            stock: 5,
          },
          {
            productVariationId: 3,
            vendorId: 114458,
            vendorCode: "pz91qe",
            vendorTitle: "Store",
            title: "Product 3",
            price: 100000,
            discount: 40000,
            discountRatio: 40,
            stock: 3,
          },
        ],
      },
    ],
  },
});
function fixture(
  options: {
    rows?: Record<string, unknown>[];
    home?: ReturnType<typeof home>;
    page?: (page: number) => { count: number; rows: Record<string, unknown>[] };
    party?: (page: number) => unknown;
  } = {}
) {
  const calls: URL[] = [];
  let frozen = false;
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(url);
    if (url.pathname.endsWith("/token"))
      return Response.json({
        status: true,
        data: { access_token: "fixture", expires_in: 3600 },
      });
    if (url.pathname.startsWith("/express-")) {
      expect(url.searchParams.get("lat")).toBe("35.7");
      expect(url.searchParams.get("long")).toBe("51.4");
    }
    if (url.pathname === "/express-vendor/general/vendors-list")
      return Response.json({
        status: true,
        data: {
          count: 1,
          finalResult: [{ type: "VENDOR", data: { code: "pz91qe", id: 999 } }],
        },
      });
    if (url.pathname.endsWith("/3kjwqk"))
      return Response.json({ ...home(), sections: [] });
    if (url.pathname === "/express-home/vendor/pz91qe")
      return Response.json(options.home ?? home());
    const page = Number(url.searchParams.get("page"));
    if (url.pathname.startsWith("/market-party/")) {
      expect(frozen).toBe(true);
      return Response.json(options.party?.(page) ?? party());
    }
    expect(url.pathname).toBe("/express-search/product-list/901/vendor/pz91qe");
    expect(url.searchParams.get("variable")).toBe("901");
    expect(url.searchParams.get("secondVariable")).toBe("pz91qe");
    expect(url.searchParams.get("page_size")).toBe("100");
    expect(url.searchParams.get("filters")).toBe("[]");
    if (page > 0) expect(frozen).toBe(true);
    const rows = options.rows ?? [
      product(1),
      product(2),
      product(3, { discount: 35000, discountRatio: 35 }),
    ];
    const data = options.page?.(page) ?? {
      count: rows.length,
      rows: page === 0 ? rows : [],
    };
    return Response.json({
      status: true,
      data: {
        id: 901,
        type: "default",
        title: "Different from home title",
        count: data.count,
        finalResult: data.rows.map((data) => ({ type: "PRODUCT", data })),
      },
    });
  };
  const input = {
    latitude: 35.7,
    longitude: 51.4,
    threshold: 40,
    storeCampaigns: true,
    fetcher,
    onManifest: () =>
      Effect.sync(() => {
        frozen = true;
      }),
  };
  return { run: () => Effect.runPromise(collectDeals(input)), calls };
}

describe("store-specific campaign enrichment", () => {
  afterEach(() => vi.useRealTimers());
  it("selects a later campaign price tuple over an older Market Party observation", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const result = await fixture({
      page: (page) => {
        vi.setSystemTime(
          new Date(
            page === 0 ? "2026-10-10T08:00:00.000Z" : "2026-10-10T08:02:00.000Z"
          )
        );
        return {
          count: 101,
          rows:
            page === 0
              ? Array.from({ length: 100 }, (_, index) => product(index + 100))
              : page === 1
                ? [
                    product(1, {
                      price: 200000,
                      discount: 100000,
                      discountRatio: 50,
                      stock: 7,
                    }),
                  ]
                : [],
        };
      },
      party: () => {
        vi.setSystemTime(new Date("2026-10-10T08:01:00.000Z"));
        return party();
      },
    }).run();
    expect(result.deals.find((row) => row.key === "114458:1")).toMatchObject({
      priceRials: 200000,
      discountRials: 100000,
      finalPriceRials: 100000,
      discountRatio: 50,
      stock: 7,
      observedAt: "2026-10-10T08:02:00.000Z",
      provenance: ["snapp:market_party", "snapp:store_campaign:114458:901"],
    });
    expect(
      "campaignResearch" in result && result.campaignResearch
    ).toMatchObject({
      conflictingOfferCount: 1,
      conflictingOfferIdentities: ["114458:1"],
    });
  });
  function dynamicFixture(
    options: {
      stores?: string[];
      sections?: Record<string, unknown>[];
      codeMismatch?: boolean;
      deliveryMismatch?: boolean;
      allOversized?: boolean;
      failRetry?: boolean;
      conflictingHomeOwners?: boolean;
    } = {}
  ) {
    const stores = options.stores ?? ["newshop", "othershop"];
    const calls: URL[] = [];
    const scopes: unknown[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(String(input));
      calls.push(url);
      if (url.pathname.endsWith("/token"))
        return Response.json({
          status: true,
          data: { access_token: "fixture", expires_in: 3600 },
        });
      if (url.pathname === "/express-vendor/general/vendors-list") {
        expect(url.searchParams.get("lat")).toBe("35.7");
        expect(url.searchParams.get("long")).toBe("51.4");
        expect(url.searchParams.get("extra-filter[vendor_collection]")).toBe(
          "-1"
        );
        return Response.json({
          status: true,
          data: {
            count: stores.length,
            finalResult: stores.map((code) => ({
              type: "VENDOR",
              data: { code, id: 999999 },
            })),
          },
        });
      }
      const code = url.pathname.split("/").at(-1)!;
      const vendorId = options.conflictingHomeOwners
        ? 700
        : 700 + stores.indexOf(code);
      if (url.pathname.startsWith("/express-home/"))
        return Response.json({
          vendorInfo: {
            code: options.codeMismatch ? "wrongcode" : code,
            id: vendorId,
            title: "Unrelated store title",
            deliveryData: {
              doesDeliver: true,
              id: vendorId,
              detail: {
                vendorId: options.deliveryMismatch ? vendorId + 1 : vendorId,
              },
            },
          },
          sections: options.sections ?? [
            {
              type: "product-list",
              collection_type: "default",
              value: 800,
              title: "Anything at all",
              config: null,
            },
            {
              type: "product-list",
              collection_type: "default",
              value: 801,
              title: "Renamed collection",
              config: null,
            },
          ],
        });
      if (url.pathname.startsWith("/market-party/"))
        return Response.json({
          status: true,
          data: { total_count: 0, vendors: [] },
        });
      const collectionId = Number(url.pathname.split("/")[3]);
      const page = Number(url.searchParams.get("page"));
      if (options.failRetry && page) return new Response(null, { status: 500 });
      const row = product(2, {
        vendor_id: vendorId,
        document_id: `2-${vendorId}`,
      });
      return Response.json({
        status: true,
        data: {
          id: collectionId,
          type: "default",
          count: options.allOversized ? 900 : 1,
          finalResult: page ? [] : [{ type: "PRODUCT", data: row }],
        },
      });
    };
    return {
      calls,
      scopes,
      run: () =>
        Effect.runPromise(
          collectDeals({
            latitude: 35.7,
            longitude: 51.4,
            threshold: 40,
            fetcher,
            storeCampaigns: true,
            onManifest: (planned) =>
              Effect.sync(() => {
                scopes.push(planned);
              }),
          })
        ),
    };
  }
  it("discovers new store codes and resolves IDs from homes, admitting multiple collections without title matching", async () => {
    const f = dynamicFixture();
    const result = await f.run();
    expect(f.scopes).toEqual([
      [
        { vendorId: 700, vendorCode: "newshop", collectionId: 800 },
        { vendorId: 700, vendorCode: "newshop", collectionId: 801 },
        { vendorId: 701, vendorCode: "othershop", collectionId: 800 },
        { vendorId: 701, vendorCode: "othershop", collectionId: 801 },
      ],
    ]);
    expect(
      f.calls
        .filter((url) => url.pathname.startsWith("/express-home/"))
        .map((url) => url.pathname)
    ).toEqual([
      "/express-home/vendor/newshop",
      "/express-home/vendor/othershop",
    ]);
    expect(result.deals).toHaveLength(2);
    expect(result.deals[0]?.vendorId).toBe("700");
    expect(result.deals[0]?.provenance).toEqual([
      "snapp:store_campaign:700:800",
      "snapp:store_campaign:700:801",
    ]);
    expect(
      "campaignResearch" in result && result.campaignResearch
    ).toMatchObject({
      reports: [
        { qualifying: 1, additional: 1 },
        { qualifying: 1, additional: 0 },
        { qualifying: 1, additional: 1 },
        { qualifying: 1, additional: 0 },
      ],
      omitted: [],
    });
  });
  it("merges offers from two dynamically resolved stores with the same product ID as separate store offers", async () => {
    const f = dynamicFixture({
      sections: [
        {
          type: "product-list",
          collection_type: "default",
          value: 850,
          config: null,
        },
      ],
    });
    const result = await f.run();
    expect(result.deals.map((row) => row.key)).toEqual(["700:2", "701:2"]);
    expect(result.vendorCount).toBe(2);
    expect(f.scopes).toEqual([
      [
        { vendorId: 700, vendorCode: "newshop", collectionId: 850 },
        { vendorId: 701, vendorCode: "othershop", collectionId: 850 },
      ],
    ]);
  });
  it("fails conflicting dynamic store-code ownership before freezing a manifest", async () => {
    const f = dynamicFixture({ conflictingHomeOwners: true });
    await expect(f.run()).rejects.toThrow(
      "two store codes resolve to the same vendorInfo.id"
    );
    expect(f.scopes).toEqual([]);
    expect(
      f.calls.some((url) => url.pathname.startsWith("/market-party/"))
    ).toBe(false);
  });
  it.each(["codeMismatch", "deliveryMismatch"] as const)(
    "rejects dynamic %s instead of accepting nearby IDs",
    async (reason) => {
      const f = dynamicFixture({ [reason]: true });
      const result = await f.run();
      expect(result.deals).toEqual([]);
      expect(
        f.calls.some((url) => url.pathname.includes("/product-list/"))
      ).toBe(false);
      expect(
        "campaignResearch" in result && result.campaignResearch
      ).toMatchObject({
        omitted: expect.arrayContaining([
          expect.objectContaining({
            reason:
              reason === "codeMismatch"
                ? "HOME_VENDOR_CODE_MISMATCH"
                : "HOME_DELIVERY_OWNER_MISMATCH",
          }),
        ]),
      });
    }
  );
  it("records unsupported and conditional sections instead of silently selecting one title", async () => {
    const f = dynamicFixture({
      stores: ["randomstore"],
      sections: [
        { type: "banner", value: null, collection_type: null },
        {
          type: "product-list",
          value: 901,
          collection_type: "coupon",
          config: null,
        },
        {
          type: "product-list",
          value: 902,
          collection_type: "default",
          config: { minimumOrder: 10000 },
        },
        {
          type: "product-list",
          value: 903,
          collection_type: "default",
          config: null,
          requires_pro: true,
        },
        {
          type: "product-list",
          value: "bad",
          collection_type: "default",
          config: null,
        },
        {
          type: "product-list",
          value: 850,
          collection_type: "default",
          config: null,
        },
      ],
    });
    const result = await f.run();
    expect(result.deals).toHaveLength(1);
    expect(
      "campaignResearch" in result && result.campaignResearch
    ).toMatchObject({
      omitted: expect.arrayContaining([
        expect.objectContaining({ reason: "UNSUPPORTED_SECTION_TYPE" }),
        expect.objectContaining({ reason: "UNSUPPORTED_COLLECTION_TYPE" }),
        expect.objectContaining({
          collectionId: 902,
          reason: "CONDITIONAL_OR_UNVERIFIED_SECTION_CONFIG",
        }),
        expect.objectContaining({
          collectionId: 903,
          reason: "CONDITIONAL_OR_UNVERIFIED_SECTION_CONFIG",
        }),
        expect.objectContaining({ reason: "INVALID_COLLECTION_ID" }),
      ]),
    });
  });
  it("visits all 100 discovered stores and their collections without admission caps", async () => {
    const f = dynamicFixture({
      stores: Array.from({ length: 100 }, (_, index) => `store${index}`),
      allOversized: true,
      sections: Array.from({ length: 20 }, (_, index) => ({
        type: "product-list",
        collection_type: "default",
        value: index + 1,
        config: null,
      })),
    });
    const result = await f.run();
    expect(
      f.calls.filter((u) => u.pathname.startsWith("/express-home/"))
    ).toHaveLength(100);
    expect(
      f.calls.filter((u) => u.pathname.includes("/product-list/"))
    ).toHaveLength(2000);
    expect(result.deals).toEqual([]);
    expect(
      "campaignResearch" in result && result.campaignResearch
    ).toMatchObject({
      omitted: expect.arrayContaining([
        expect.objectContaining({
          reason: expect.stringContaining("PAGINATION"),
        }),
      ]),
    });
  });
  it("discovers changing IDs, freezes before enumeration, and merges provenance without inflating stock", async () => {
    const { run, calls } = fixture();
    const result = await run();
    expect(result.deals).toHaveLength(3);
    const overlap = result.deals.find((row) => row.productVariationId === "1")!;
    expect(overlap.stock).toBe(5);
    expect(overlap.provenance).toEqual([
      "snapp:market_party",
      "snapp:store_campaign:114458:901",
    ]);
    expect(
      result.deals.find((row) => row.productVariationId === "3")?.discountRatio
    ).toBe(40);
    expect(
      "campaignResearch" in result && result.campaignResearch
    ).toMatchObject({
      reports: [
        {
          qualifying: 2,
          overlap: 1,
          additional: 1,
          excluded: { BELOW_THRESHOLD: 1 },
          terminal: true,
          pageSizes: [3, 0],
        },
      ],
    });
    expect(
      calls.filter((url) => url.pathname.includes("/product-list/"))
    ).toHaveLength(2);
  });
  it("retains zero eligible separately from all qualifying offers being duplicates", async () => {
    const zero = await fixture({
      rows: [product(2, { discount: 39000, discountRatio: 39 })],
    }).run();
    const duplicate = await fixture({ rows: [product(1)] }).run();
    expect("campaignResearch" in zero && zero.campaignResearch).toMatchObject({
      reports: [{ qualifying: 0, overlap: 0, additional: 0 }],
    });
    expect(
      "campaignResearch" in duplicate && duplicate.campaignResearch
    ).toMatchObject({
      reports: [{ qualifying: 1, overlap: 1, additional: 0 }],
    });
  });
  it("accepts explicit zero-discount rows with null ratios without manufacturing eligibility", async () => {
    const result = await fixture({
      rows: [product(2, { discount: 0, discountRatio: null })],
    }).run();
    expect(result.deals).toHaveLength(2);
    expect(
      "campaignResearch" in result && result.campaignResearch
    ).toMatchObject({
      reports: [
        { qualifying: 0, additional: 0, excluded: { BELOW_THRESHOLD: 1 } },
      ],
    });
    await expect(
      fixture({ rows: [product(2, { discountRatio: null })] }).run()
    ).rejects.toThrow("null for a positive discount");
  });
  it("ignores unrelated home sections with null collection metadata", async () => {
    const h = home();
    const original = h.sections;
    Object.assign(h, {
      sections: [
        ...original,
        {
          type: "banner",
          value: null,
          title: "Banner",
          collection_type: null,
          config: null,
        },
      ],
    });
    const result = await fixture({ home: h }).run();
    expect(
      "campaignResearch" in result && result.campaignResearch
    ).toMatchObject({ reports: [{ additional: 1 }] });
  });
  it.each(["delivery", "owner", "delivery owner", "code", "missing discovery"])(
    "omits an unverified %s before admission",
    async (reason) => {
      const h = home();
      if (reason === "delivery") h.vendorInfo.deliveryData.doesDeliver = false;
      if (reason === "owner") h.vendorInfo.id = 77;
      if (reason === "delivery owner")
        h.vendorInfo.deliveryData.detail.vendorId = 77;
      if (reason === "code") h.vendorInfo.code = "another";
      if (reason === "missing discovery") h.sections = [];
      const f = fixture({ home: h });
      const result = await f.run();
      expect(result.deals).toHaveLength(2);
      expect(
        f.calls.some((url) => url.pathname.includes("/product-list/"))
      ).toBe(false);
      expect(
        "campaignResearch" in result && result.campaignResearch
      ).toMatchObject({ reports: [] });
    }
  );
  it.each([
    { vendor_id: 77 },
    { document_id: "2-77" },
    { vendor: { id: 77 } },
    { discount: 110000 },
    { discount: 1000 },
  ])(
    "fails an admitted contract with invalid ownership or prices: %j",
    async (extra) => {
      await expect(
        fixture({ rows: [product(2, extra)] }).run()
      ).rejects.toThrow(/ownership|agreement/);
    }
  );
  it("excludes missing/negative stock, conditional benefits and below-threshold rows with concrete reasons", async () => {
    const result = await fixture({
      rows: [
        product(2, { stock: undefined }),
        product(4, { no_stock: true }),
        product(5, { stock: 0 }),
        product(6, { requires_pro: true }),
        product(7, { discount: 39900, discountRatio: 39.9 }),
      ],
    }).run();
    expect(result.deals).toHaveLength(2);
    expect(
      "campaignResearch" in result && result.campaignResearch
    ).toMatchObject({
      reports: [
        {
          qualifying: 0,
          excluded: {
            UNKNOWN_STOCK: 1,
            OUT_OF_STOCK: 2,
            UNVERIFIED_CONDITIONAL_BENEFIT: 1,
            BELOW_THRESHOLD: 1,
          },
        },
      ],
    });
  });
  it("accepts exact repeated rows without treating raw count as unique count", async () => {
    const result = await fixture({ rows: [product(2), product(2)] }).run();
    expect(result.deals).toHaveLength(3);
    expect(
      "campaignResearch" in result && result.campaignResearch
    ).toMatchObject({
      reports: [
        {
          rawCount: 2,
          uniqueCount: 1,
          duplicateCount: 1,
          qualifying: 1,
          additional: 1,
        },
      ],
    });
  });
  it("quarantines a conflicting product and preserves the rest of the scan", async () => {
    const result = await fixture({
      rows: [product(2), product(2, { stock: 3 }), product(2), product(4)],
    }).run();
    const productIds = result.deals.map((deal) => deal.productVariationId);
    expect(productIds).toContain("1");
    expect(productIds).toContain("3");
    expect(productIds).toContain("4");
    expect(productIds).not.toContain("2");
    expect("coverage" in result && result.coverage).toBe("incomplete");
    expect(
      "campaignResearch" in result && result.campaignResearch.reports
    ).toMatchObject([
      {
        coverage: "incomplete",
        terminal: true,
        partialReason: "CONFLICTING_DUPLICATES",
        excluded: { CONFLICTING_DUPLICATE: 1 },
      },
    ]);
  });
  it("fails replayed pages", async () => {
    const rows = Array.from({ length: 100 }, (_, i) => product(i + 10));
    await expect(
      fixture({ page: () => ({ count: 200, rows }) }).run()
    ).rejects.toThrow("replayed page");
  });
  it("fails count drift after admission", async () => {
    await expect(
      fixture({
        page: (page) => ({
          count: page ? 2 : 1,
          rows: page ? [] : [product(2)],
        }),
      }).run()
    ).rejects.toThrow("count drift");
  });
  it("fails a premature empty terminal", async () => {
    const rows = Array.from({ length: 100 }, (_, i) => product(i + 10));
    await expect(
      fixture({
        page: (page) => ({ count: 200, rows: page ? [] : rows }),
      }).run()
    ).rejects.toThrow("empty terminal before");
  });
  it("collects beyond 100 pages until the verified empty terminal", async () => {
    const f = fixture({
      page: (page) => ({
        count: 10100,
        rows:
          page < 101
            ? Array.from({ length: 100 }, (_, i) =>
                product(page * 100 + i + 10)
              )
            : [],
      }),
    });
    const result = await f.run();
    expect(result.deals.length).toBeGreaterThan(10000);
    expect("coverage" in result && result.coverage).toBe("complete");
    expect(
      f.calls.filter((u) => u.pathname.includes("/product-list/"))
    ).toHaveLength(102);
  });
  it("omits pagination that only returns ten rows despite page_size=100", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => product(i + 10));
    const result = await fixture({ page: () => ({ count: 200, rows }) }).run();
    expect(
      "campaignResearch" in result && result.campaignResearch
    ).toMatchObject({
      reports: [],
      omitted: expect.arrayContaining([
        expect.objectContaining({
          reason: expect.stringContaining("PAGINATION"),
        }),
      ]),
    });
  });
  it.each([701, 6254])(
    "omits an oversized %i-row candidate before freezing",
    async (count) => {
      const f = fixture({ page: () => ({ count, rows: [product(2)] }) });
      const result = await f.run();
      expect(result.deals).toHaveLength(2);
      expect(
        "campaignResearch" in result && result.campaignResearch
      ).toMatchObject({
        reports: [],
        omitted: expect.arrayContaining([
          expect.objectContaining({
            reason: expect.stringContaining("OVERSIZED"),
          }),
        ]),
      });
    }
  );
  it("collects all Market Party vendors beyond the old request and page caps", async () => {
    const f = fixture({
      party: (page) => ({
        status: true,
        data: {
          total_count: 100,
          vendors: [{ vendor_id: page + 1, products: [] }],
        },
      }),
    });
    const result = await f.run();
    expect(result.vendorCount).toBe(101);
    expect(f.calls.length).toBeGreaterThan(100);
  });
});
