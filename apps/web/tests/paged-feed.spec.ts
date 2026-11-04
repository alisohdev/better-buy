import { expect, test, type Page } from "@playwright/test";
import type { DealGroupRecord, ScanRecord } from "@better-buy/shared";

const date = "2026-10-10T08:00:00.000Z";
const run: ScanRecord = {
  id: "saved",
  locationId: "home",
  locationName: "خانه",
  source: "snappmarket",
  threshold: 40,
  mode: "partial",
  status: "succeeded",
  createdAt: date,
  startedAt: date,
  finishedAt: date,
  vendorCount: 30,
  productCount: 200,
  dealCount: 80,
  errorCode: null,
  errorMessage: null,
};
function group(key: string): DealGroupRecord {
  const offer = {
    offerKey: key + ":vendor",
    productVariationId: key,
    vendorId: "1",
    vendorTitle: "فروشگاه نمونه",
    vendorCode: null,
    priceRials: 100000,
    discountRials: 50000,
    finalPriceRials: 50000,
    discountRatio: 50,
    stock: 5,
    state: "current" as const,
  };
  return {
    key,
    groupKeyVersion: 2,
    scanId: "saved",
    title: key,
    image: null,
    categoryTitle: null,
    priceRials: 100000,
    discountRials: 50000,
    finalPriceRials: 50000,
    discountRatio: 50,
    state: "current",
    vendors: [offer],
    bestCurrentOffer: offer,
    currentStoreOfferCount: 30,
    conditionalOffers: [],
    diagnostics: [],
  };
}
function summary(key: string) {
  const { vendors, conditionalOffers, ...item } = group(key);
  void vendors;
  void conditionalOffers;
  return { ...item, conditionalOfferCount: 0 };
}
async function setup(page: Page) {
  const state = { reads: [] as URL[], posts: [] as string[], scans: [run] };
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/get-session") {
      await route.fulfill({
        json: {
          session: {
            id: "s",
            userId: "user-1",
            expiresAt: "2099-01-01T00:00:00Z",
          },
          user: { id: "user-1", name: "نمونه", email: "test@example.com" },
        },
      });
      return;
    }
    if (route.request().method() === "POST" && url.pathname === "/api/scans")
      state.posts.push(url.pathname);
    let data: unknown = [];
    if (url.pathname === "/api/locations")
      data = [
        {
          id: "home",
          name: "خانه",
          latitude: 35.7,
          longitude: 51.4,
          isDefault: true,
          createdAt: date,
          updatedAt: date,
        },
      ];
    else if (url.pathname === "/api/scans")
      data = url.searchParams.has("intent") ? [] : state.scans;
    else if (/\/api\/scans\/[^/]+$/.test(url.pathname))
      data = state.scans.find(
        (scan) => scan.id === url.pathname.split("/").at(-1)
      );
    else if (url.pathname.endsWith("/products")) {
      state.reads.push(url);
      const key =
        url.searchParams.get("q") ||
        (url.searchParams.get("cursor") ? "صفحه دوم" : "صفحه نخست");
      data = {
        items: [summary(key)],
        nextCursor:
          url.searchParams.get("cursor") || url.searchParams.get("q")
            ? null
            : "product-next",
        observedAt: date,
        coverageSummary: "complete",
        baseline: { scanId: null, reason: "first_snapshot" },
      };
    } else if (url.pathname.endsWith("/offers")) {
      state.reads.push(url);
      data = {
        items: [
          {
            ...group("offer").vendors[0],
            offerKey: url.searchParams.get("cursor") ? "second" : "first",
            vendorTitle: url.searchParams.get("cursor")
              ? "فروشگاه دوم"
              : "فروشگاه نخست",
          },
        ],
        nextCursor: url.searchParams.get("cursor") ? null : "offer-next",
      };
    }
    await route.fulfill({ json: { data } });
  });
  return state;
}
test("saved pages, server search and store disclosure are read-only", async ({
  page,
}) => {
  const state = await setup(page);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "صفحه نخست", exact: true })
  ).toBeVisible();
  expect(state.reads[0]!.searchParams.get("page")).toBe("1");
  expect(state.reads[0]!.searchParams.get("sort")).toBe("wishlist");
  await page.getByRole("button", { name: /^نمایش محصولات بیشتر/ }).click();
  await expect(
    page.getByRole("heading", { name: "صفحه دوم", exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "صفحه نخست", exact: true })
  ).toBeVisible();
  await page.getByRole("combobox", { name: "مرتب‌سازی", exact: true }).click();
  await page.getByRole("option", { name: "کمترین قیمت", exact: true }).click();
  await expect
    .poll(() => state.reads.at(-1)?.searchParams.get("sort"))
    .toBe("price");
  await page.getByRole("searchbox").fill("آبمیوه");
  await expect(
    page.getByRole("heading", { name: "آبمیوه", exact: true })
  ).toBeVisible();
  await page.getByText("مقایسه فروشگاه‌ها", { exact: false }).first().click();
  await expect(page.getByText("فروشگاه نخست", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "نمایش فروشگاه‌های بیشتر" }).click();
  await expect(page.getByText("فروشگاه دوم", { exact: true })).toBeVisible();
  expect(state.posts).toEqual([]);
});

test("cancelling an active update preserves the saved feed and stops polling", async ({
  page,
}) => {
  const state = await setup(page);
  const active = {
    ...run,
    id: "active",
    status: "running" as const,
    finishedAt: null,
    createdAt: "2026-10-10T09:00:00.000Z",
  };
  state.scans = [active, run];
  let cancels = 0;
  await page.route("**/api/scans/active/cancel", async (route) => {
    cancels++;
    const cancelled = {
      ...active,
      status: "cancelled" as const,
      finishedAt: date,
    };
    state.scans = [cancelled, run];
    await route.fulfill({ json: { data: cancelled } });
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "صفحه نخست", exact: true })
  ).toBeVisible();
  await page
    .getByRole("button", { name: "لغو به‌روزرسانی", exact: true })
    .click();
  await expect(page.getByText(/به‌روزرسانی لغو شد/)).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "صفحه نخست", exact: true })
  ).toBeVisible();
  await expect(page.locator(".active-scan")).toHaveCount(0);
  expect(cancels).toBe(1);
  expect(state.posts).toEqual([]);
});

test("an ambiguous start explicitly resends the same UUID and request", async ({
  page,
}) => {
  const state = await setup(page);
  const keys: string[] = [];
  const bodies: unknown[] = [];
  await page.route(/\/api\/scans(?:\?.*)?$/, async (route) => {
    if (route.request().method() === "POST") {
      keys.push(route.request().headers()["idempotency-key"]!);
      bodies.push(route.request().postDataJSON());
      if (keys.length === 1) return route.abort("connectionfailed");
      return route.fulfill({
        json: {
          data: {
            ...run,
            id: "same-intent",
            status: "queued",
            finishedAt: null,
          },
        },
      });
    }
    const url = new URL(route.request().url());
    return route.fulfill({
      json: { data: url.searchParams.has("intent") ? [] : state.scans },
    });
  });
  await page.goto("/");
  await page.getByRole("checkbox", { name: "اکالا", exact: true }).uncheck();
  await page
    .getByRole("button", { name: "به‌روزرسانی تخفیف‌ها", exact: true })
    .click();
  await expect(
    page.getByText("نتیجه شروع اسکن مشخص نیست", { exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "به‌روزرسانی تخفیف‌ها", exact: true })
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "بررسی دوباره درخواست قبلی", exact: true })
  ).toBeVisible();
  expect(keys).toHaveLength(1);
  await page
    .getByRole("button", { name: "بررسی دوباره درخواست قبلی", exact: true })
    .click();
  await expect(
    page.getByText("نتیجه شروع اسکن مشخص نیست", { exact: true })
  ).toHaveCount(0);
  expect(keys).toHaveLength(2);
  expect(keys[0]).toMatch(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
  expect(keys[1]).toBe(keys[0]);
  expect(bodies[1]).toEqual(bodies[0]);
});

test("a failed next product page retains the exact already loaded rows", async ({
  page,
}) => {
  const state = await setup(page);
  await page.route("**/api/scans/saved/products?*cursor=*", (route) =>
    route.fulfill({ status: 503, json: { error: "TEMPORARY" } })
  );
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "صفحه نخست", exact: true })
  ).toBeVisible();
  await page.getByRole("button", { name: /^نمایش محصولات بیشتر/ }).click();
  await expect(
    page.getByText("تازه‌سازی نتیجه انجام نشد", { exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "صفحه نخست", exact: true })
  ).toBeVisible();
  expect(state.posts).toEqual([]);
});

test("all loaded baseline pages remain when a successful update cannot be read", async ({
  page,
}) => {
  const state = await setup(page);
  await page.route("**/api/scans/new-success/products*", (route) =>
    route.fulfill({ status: 503, json: { error: "TEMPORARY" } })
  );
  await page.route(/\/api\/scans(?:\?.*)?$/, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const successful = {
      ...run,
      id: "new-success",
      createdAt: "2026-10-10T09:00:00.000Z",
    };
    state.scans = [successful, run];
    await route.fulfill({ json: { data: successful } });
  });
  await page.goto("/");
  await page.getByRole("checkbox", { name: "اکالا", exact: true }).uncheck();
  await page.getByRole("button", { name: /^نمایش محصولات بیشتر/ }).click();
  await expect(
    page.getByRole("heading", { name: "صفحه دوم", exact: true })
  ).toBeVisible();
  await page
    .getByRole("button", { name: "به‌روزرسانی تخفیف‌ها", exact: true })
    .click();
  await expect(
    page.getByText("تازه‌سازی نتیجه انجام نشد", { exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "صفحه نخست", exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "صفحه دوم", exact: true })
  ).toBeVisible();
});

test("a failed store page retains loaded offers and only retries a saved GET", async ({
  page,
}) => {
  const state = await setup(page);
  let failed = true;
  await page.route("**/offers?*cursor=*", (route) =>
    failed
      ? route.fulfill({ status: 503, json: { error: "TEMPORARY" } })
      : route.fallback()
  );
  await page.goto("/");
  await page.getByText("مقایسه فروشگاه‌ها", { exact: false }).first().click();
  await expect(page.getByText("فروشگاه نخست", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "نمایش فروشگاه‌های بیشتر" }).click();
  await expect(
    page.getByRole("button", { name: "دریافت دوباره فروشگاه‌ها" })
  ).toBeVisible();
  await expect(page.getByText("فروشگاه نخست", { exact: true })).toBeVisible();
  failed = false;
  await page.getByRole("button", { name: "دریافت دوباره فروشگاه‌ها" }).click();
  await expect(page.getByText("فروشگاه دوم", { exact: true })).toBeVisible();
  expect(state.posts).toEqual([]);
});

test("saved navigation passes twenty pages with a bounded retained window", async ({
  page,
}) => {
  const state = await setup(page);
  await page.route("**/api/scans/saved/products*", (route) => {
    const url = new URL(route.request().url());
    const number = Number(url.searchParams.get("cursor") ?? "1");
    state.reads.push(url);
    return route.fulfill({
      json: {
        data: {
          items: [summary(`product-${number}`)],
          nextCursor: number < 22 ? String(number + 1) : null,
          observedAt: date,
          coverageSummary: "complete",
          baseline: { scanId: null, reason: "first_snapshot" },
        },
      },
    });
  });
  await page.goto("/");
  for (let number = 2; number <= 22; number++) {
    await page.getByRole("button", { name: /^نمایش محصولات بیشتر/ }).click();
    await expect(
      page.getByRole("heading", { name: `product-${number}`, exact: true })
    ).toBeVisible();
  }
  await expect(page.locator(".deal-row")).toHaveCount(20);
  await expect(
    page.getByRole("heading", { name: "product-1", exact: true })
  ).toHaveCount(0);
  await page.getByRole("button", { name: /^بازگشت به صفحه نخست/ }).click();
  await expect(
    page.getByRole("heading", { name: "product-1", exact: true })
  ).toBeVisible();
  await expect(page.locator(".deal-row")).toHaveCount(1);
  expect(state.posts).toEqual([]);
});
