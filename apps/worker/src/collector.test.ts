import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectDeals as collection } from "./collector";

const collectDeals = (input: Parameters<typeof collection>[0]) =>
  Effect.runPromise(collection(input));

// Synthetic Market Party and public-PWA token fixtures; no customer credentials.
const product = (ratio: number, id = 1) => ({
  productVariationId: id,
  price: 100_000,
  discountRatio: ratio,
  title: "کالا " + id,
  discount: ratio * 1000,
  image: null,
  vendorCode: "v",
  vendorId: 10,
  vendorTitle: "فروشگاه",
  menu_category_title: "خوراکی",
  stock: 2,
  is_out_of_stock: false,
});
const json = (body: unknown) => Response.json(body);
const page = (vendors: unknown[], total_count = vendors.length) =>
  json({ status: true, data: { total_count, vendors } });
const token = (access_token = "guest-fixture", expires_in = 259200) =>
  json({ status: true, data: { access_token, expires_in } });
const input = { latitude: 35.7, longitude: 51.4, threshold: 40 };
const fixtureFetcher = (
  feed: (url: URL, init?: RequestInit) => Response | Promise<Response>
) =>
  vi.fn<typeof fetch>(async (request, init) => {
    const url = new URL(String(request));
    return url.pathname === "/oauth2/default/token" ? token() : feed(url, init);
  });

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("SnappMarket automatic guest collector", () => {
  it("acquires a public guest session and reuses its device/token across every exact feed page", async () => {
    const progress = vi.fn(() => Effect.void);
    const fetcher = fixtureFetcher((url) =>
      url.searchParams.get("page") === "0"
        ? page([{ vendor_id: 10, products: [product(40)] }], 2)
        : page(
            [
              {
                vendor_id: 20,
                products: [{ ...product(50, 2), vendorId: 20 }],
              },
            ],
            2
          )
    );
    const result = await collectDeals({
      ...input,
      fetcher,
      onProgress: progress,
    });
    expect(result.vendorCount).toBe(2);
    expect(result.deals).toHaveLength(2);
    expect(progress.mock.calls).toEqual([
      [{ vendorCount: 1, productCount: 1 }],
      [{ vendorCount: 2, productCount: 2 }],
    ]);
    expect(fetcher).toHaveBeenCalledTimes(3);
    const [request, init] = fetcher.mock.calls[0]!;
    const guestUrl = new URL(String(request));
    const device = guestUrl.searchParams.get("UDID");
    expect(device).toMatch(/^[0-9a-f-]{36}$/);
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    expect(JSON.parse(String(init?.body))).toEqual({
      data: {
        device_uid: device,
        client_id: "snappfood_pwa",
        client_secret: "snappfood_pwa_secret",
        grant_type: "client_credentials",
        scope: "mobile_v2 mobile_v1 webview",
      },
    });
    for (const [request, init] of fetcher.mock.calls) {
      const url = new URL(String(request));
      expect(url.origin).toBe("https://svc.snapp.market");
      expect(url.searchParams.get("client")).toBe("PWA");
      expect(url.searchParams.get("deviceType")).toBe("PWA");
      expect(url.searchParams.get("appVersion")).toBe("1.403.1");
      expect(url.searchParams.get("UDID")).toBe(device);
      if (url.pathname !== "/oauth2/default/token") {
        expect(url.pathname).toBe("/market-party/35.7/51.4");
        expect(url.searchParams.get("page_size")).toBe("100");
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer guest-fixture"
        );
      }
    }
    expect(JSON.stringify(result)).not.toContain("guest-fixture");
  });

  it("includes the threshold boundary, deduplicates by vendor/product, filters stock, and preserves prices", async () => {
    const fetcher = fixtureFetcher(() =>
      page([
        {
          vendor_id: 10,
          products: [
            product(39, 1),
            product(40, 2),
            product(41, 3),
            product(41, 3),
            { ...product(50, 4), stock: 0 },
            { ...product(50, 5), is_out_of_stock: true },
          ],
        },
      ])
    );
    const result = await collectDeals({ ...input, fetcher });
    expect(result.productCount).toBe(5);
    expect(result.deals.map((deal) => deal.discountRatio)).toEqual([40, 41]);
    expect(result.deals[0]).toMatchObject({
      key: "10:2",
      priceRials: 100_000,
      finalPriceRials: 60_000,
    });
  });

  it("renews once on 401 and retries the same page with the same device", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(token("guest-1"))
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(token("guest-2"))
      .mockResolvedValueOnce(page([]));
    await expect(collectDeals({ ...input, fetcher })).resolves.toMatchObject({
      vendorCount: 0,
    });
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(String(fetcher.mock.calls[1]![0])).toBe(
      String(fetcher.mock.calls[3]![0])
    );
    expect(
      new Headers(fetcher.mock.calls[3]![1]?.headers).get("authorization")
    ).toBe("Bearer guest-2");
    expect(
      new URL(String(fetcher.mock.calls[0]![0])).searchParams.get("UDID")
    ).toBe(new URL(String(fetcher.mock.calls[2]![0])).searchParams.get("UDID"));
  });

  it("fails after the one allowed 401 renewal, even if a later page rejects the renewed token", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(
        page([{ vendor_id: 10, products: [product(40)] }], 2)
      )
      .mockResolvedValueOnce(new Response(null, { status: 401 }));
    await expect(collectDeals({ ...input, fetcher })).rejects.toMatchObject({
      code: "GUEST_AUTH_REJECTED",
    });
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it("renews an expired guest before fetching the next page", async () => {
    let now = 100_000,
      acquisitions = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const fetcher = vi.fn<typeof fetch>(async (request) => {
      const url = new URL(String(request));
      if (url.pathname === "/oauth2/default/token")
        return token("guest-" + ++acquisitions, 1);
      if (url.searchParams.get("page") === "0") {
        now += 1000;
        return page([{ vendor_id: 10, products: [product(40)] }], 2);
      }
      return page([{ vendor_id: 20, products: [] }], 2);
    });
    await collectDeals({ ...input, fetcher });
    expect(acquisitions).toBe(2);
    expect(
      new Headers(fetcher.mock.calls[3]![1]?.headers).get("authorization")
    ).toBe("Bearer guest-2");
  });

  it.each([
    ["repeated page", () => page([{ vendor_id: 10, products: [] }], 2)],
    ["premature empty page", () => page([], 2)],
  ])("rejects incomplete collection: %s", async (_name, feed) => {
    const fetcher = fixtureFetcher(feed);
    await expect(collectDeals({ ...input, fetcher })).rejects.toMatchObject({
      code: "INCOMPLETE_PAGINATION",
    });
  });

  it("collects all vendors beyond the former 50-page limit", async () => {
    const fetcher = fixtureFetcher((url) =>
      page([{ vendor_id: url.searchParams.get("page"), products: [] }], 51)
    );
    await expect(collectDeals({ ...input, fetcher })).resolves.toMatchObject({
      vendorCount: 51,
    });
    expect(fetcher).toHaveBeenCalledTimes(52); // guest plus 51 feed pages
  });

  const failures: Array<[string, () => Response | Promise<Response>, string]> =
    [
      ["401", () => new Response(null, { status: 401 }), "GUEST_AUTH_REJECTED"],
      ["403", () => new Response(null, { status: 403 }), "UPSTREAM_FORBIDDEN"],
      ["429", () => new Response(null, { status: 429 }), "RATE_LIMITED"],
      ["gateway", () => new Response(null, { status: 502 }), "UPSTREAM_ERROR"],
      [
        "network",
        () => Promise.reject(new Error("secret-fixture")),
        "NETWORK_ERROR",
      ],
      [
        "invalid JSON",
        () => new Response("secret-fixture"),
        "UPSTREAM_INVALID_JSON",
      ],
      [
        "schema change",
        () => json({ data: "secret-fixture" }),
        "UPSTREAM_CHANGED",
      ],
    ];
  it.each(failures)(
    "fails guest acquisition distinctly: %s",
    async (_name, fail, code) => {
      const fetcher = vi.fn<typeof fetch>(async () => fail());
      const result = collectDeals({ ...input, fetcher });
      await expect(result).rejects.toMatchObject({ code });
      await expect(result).rejects.not.toThrow(/secret-fixture|OTP|توکن/);
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  );
  it.each(failures)(
    "fails feed collection distinctly: %s",
    async (_name, fail, code) => {
      vi.useFakeTimers();
      const fetcher = fixtureFetcher(fail);
      const assertion = expect(
        collectDeals({ ...input, fetcher })
      ).rejects.toMatchObject({ code });
      await vi.runAllTimersAsync();
      await assertion;
      if (["RATE_LIMITED", "UPSTREAM_ERROR", "NETWORK_ERROR"].includes(code))
        expect(fetcher).toHaveBeenCalledTimes(4);
      else if (code !== "GUEST_AUTH_REJECTED")
        expect(fetcher).toHaveBeenCalledTimes(2);
      else expect(fetcher).toHaveBeenCalledTimes(4);
    }
  );
  it.each([0, -1, null, "3600"])(
    "rejects an invalid guest expiry %s",
    async (expires_in) => {
      const fetcher = vi.fn<typeof fetch>(async () =>
        json({ status: true, data: { access_token: "guest", expires_in } })
      );
      await expect(collectDeals({ ...input, fetcher })).rejects.toMatchObject({
        code: "UPSTREAM_CHANGED",
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  );
});

it("retries only a failing page without repeating earlier pages or guest access", async () => {
  vi.useFakeTimers();
  let pageOneAttempts = 0;
  const fetcher = fixtureFetcher((url) => {
    if (url.searchParams.get("page") === "0")
      return page([{ vendor_id: 10, products: [product(40)] }], 2);
    if (++pageOneAttempts === 1) return new Response(null, { status: 502 });
    return page(
      [{ vendor_id: 20, products: [{ ...product(50, 2), vendorId: 20 }] }],
      2
    );
  });
  const running = collectDeals({ ...input, fetcher });
  await vi.advanceTimersByTimeAsync(1000);
  expect((await running).deals).toHaveLength(2);
  expect(
    fetcher.mock.calls.map(([request]) => {
      const url = new URL(String(request));
      return url.pathname.endsWith("/token")
        ? "guest"
        : url.searchParams.get("page");
    })
  ).toEqual(["guest", "0", "1", "1"]);
});
