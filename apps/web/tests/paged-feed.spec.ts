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
  context: {
    location: { name: "خانه", latitude: 35.7, longitude: 51.4, revision: 1 },
    requestedThreshold: 40,
    effectiveThreshold: 15,
    policyVersion: "automatic-v1",
    manifest: { adapter: "snappmarket", contractVersion: 1, feedKinds: [] },
    scopeHash: "fixture",
    eligibilityVersion: 1,
    offerKeyVersion: 1,
    coverage: "complete",
  },
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
    categoryTitle: "خواربار",
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
  await page.addInitScript(() =>
    localStorage.setItem("better-buy:tutorial:v2", "dismissed")
  );
  await page.clock.setFixedTime(new Date("2026-10-10T09:00:00.000Z"));
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
        facets: {
          stores: [
            "فروشگاه نمونه",
            "هایپرمارکت مرکزی",
            "فروشگاه بهار",
            "سوپرمارکت گلریز",
          ],
          categories: ["نوشیدنی", "میوه و سبزیجات", "لبنیات", "خواربار"],
        },
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
  isMobile,
}) => {
  if (isMobile) await page.setViewportSize({ width: 360, height: 780 });
  const state = await setup(page);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "صفحه نخست", exact: true })
  ).toBeVisible();
  const firstCard = page.locator(".product-result").filter({
    has: page.getByRole("heading", { name: "صفحه نخست", exact: true }),
  });
  if (isMobile) {
    const card = (await firstCard.boundingBox())!;
    const price = (await firstCard.locator(".price-label").boundingBox())!;
    const metadata = (await firstCard.locator(".product-meta").boundingBox())!;
    const disclosure = (await firstCard.locator("summary").boundingBox())!;
    expect(card.height).toBeLessThan(248);
    expect(price.width).toBeGreaterThan(card.width - 32);
    expect(metadata.width).toBe(price.width);
    expect(disclosure.height).toBeGreaterThanOrEqual(44);
  }
  await expect(firstCard.locator(".product-meta")).not.toContainText(
    "در فهرست فعلی"
  );
  const category = firstCard.getByRole("button", {
    name: "دسته‌بندی: خواربار",
  });
  if (isMobile) await category.tap();
  else await category.hover();
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toHaveText("خواربار");
  await page.keyboard.press("Escape");
  await expect(tooltip).toHaveCount(0);
  expect(state.reads[0]!.searchParams.get("page")).toBe("1");
  expect(state.reads[0]!.searchParams.get("sort")).toBe("wishlist");
  await page.locator(".feed-load-sentinel").scrollIntoViewIfNeeded();
  await expect(
    page.getByRole("heading", { name: "صفحه دوم", exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "صفحه نخست", exact: true })
  ).toBeVisible();
  const filterSheet = page.getByRole("button", { name: "فیلتر و مرتب‌سازی" });
  if (await filterSheet.isVisible()) await filterSheet.click();
  await page.getByRole("combobox", { name: "مرتب‌سازی", exact: true }).click();
  await page.getByRole("option", { name: "کمترین قیمت", exact: true }).click();
  await expect
    .poll(() => state.reads.at(-1)?.searchParams.get("sort"))
    .toBe("price");
  if (await page.getByRole("dialog", { name: "فیلتر و مرتب‌سازی" }).isVisible())
    await page.getByRole("button", { name: "نمایش نتایج" }).click();
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

test("minimum discount slider and facet picks update paginated requests", async ({
  page,
  isMobile,
}) => {
  const state = await setup(page);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "صفحه نخست", exact: true })
  ).toBeVisible();

  const location = await page.locator(".shopping-location").boundingBox();
  const scan = await page.locator(".shopping-scan-action").boundingBox();
  expect(location?.y).toBe(scan?.y);
  if (isMobile) {
    const search = await page.getByRole("searchbox").boundingBox();
    const icon = await page
      .getByRole("button", { name: "فیلتر و مرتب‌سازی", exact: true })
      .boundingBox();
    expect(icon?.y).toBe(search?.y);
    expect(icon?.width).toBe(44);
    expect(icon!.x + icon!.width).toBeLessThan(search!.x);
  }

  await page
    .getByRole("button", {
      name: isMobile ? "فیلتر و مرتب‌سازی" : "حداقل تخفیف نتیجه‌ها",
      exact: true,
    })
    .click();
  if (isMobile) {
    const sheet = page.getByRole("dialog", { name: "فیلتر و مرتب‌سازی" });
    await expect(sheet.getByText("مرتب‌سازی", { exact: true })).toBeVisible();
    await expect(
      sheet.getByRole("combobox", { name: "مرتب‌سازی", exact: true })
    ).toHaveCSS("border-top-width", "1px");
  }
  const minimum = page.getByRole("slider", {
    name: "حداقل تخفیف",
    exact: true,
  });
  await expect(minimum).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(
    page.getByRole("spinbutton", { name: "درصد تخفیف دلخواه" })
  ).toHaveCount(0);
  await expect(
    page.getByRole("group", { name: "تخفیف‌های پیشنهادی" })
  ).toHaveCount(0);
  await expect(
    page.getByRole("slider", { name: "حداکثر تخفیف", exact: true })
  ).toHaveCount(0);
  await minimum.press("ArrowLeft");
  await expect
    .poll(() => state.reads.at(-1)?.searchParams.get("minDiscount"))
    .toBe("41");
  if (!isMobile) {
    const track = await minimum.boundingBox();
    expect(track).not.toBeNull();
    const { x, y, width, height } = track!;

    await page.mouse.move(x + width * 0.6, y + height / 2);
    await page.mouse.down();
    await page.mouse.move(x + width * 0.3, y + height / 2, { steps: 4 });
    expect(state.reads.at(-1)?.searchParams.get("minDiscount")).toBe("41");
    await page.mouse.up();
    await expect
      .poll(() => Number(state.reads.at(-1)?.searchParams.get("minDiscount")))
      .toBeGreaterThan(41);
  }
  if (!isMobile) await page.keyboard.press("Escape");

  const storePicker = page.getByRole("combobox", {
    name: "فروشگاه‌ها",
    exact: true,
  });
  await storePicker.click();
  await expect(storePicker).toHaveAttribute("placeholder", "جست‌وجوی فروشگاه");
  await storePicker.fill("نمونه");
  const storeOption = page.getByRole("option", {
    name: "فروشگاه نمونه",
    exact: true,
  });
  await expect(storeOption).toHaveCSS("border-top-width", "0px");
  await expect(storeOption).toHaveCSS("text-align", "start");
  await storeOption.click();
  await page
    .getByRole("combobox", { name: "دسته‌بندی‌ها", exact: true })
    .fill("نوشیدنی");
  await page.getByRole("option", { name: "نوشیدنی", exact: true }).click();
  await expect
    .poll(() => {
      const params = state.reads.at(-1)?.searchParams;
      return [params?.get("store"), params?.get("category")];
    })
    .toEqual(["فروشگاه نمونه", "نوشیدنی"]);

  if (isMobile) {
    await page.getByRole("button", { name: "نمایش نتایج" }).click();
    await expect(
      page.getByRole("dialog", { name: "فیلتر و مرتب‌سازی" })
    ).toHaveCount(0);
    await expect(page.locator(".results-filter-count")).toHaveText("۳");
    await expect(page.locator(".results-filter-count")).toHaveCSS(
      "animation-name",
      "results-filter-pop"
    );
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(page.locator(".results-filter-count")).toHaveCSS(
      "animation-name",
      "none"
    );
  }
});

test("a dismissed scan notice stays closed after reload", async ({ page }) => {
  const state = await setup(page);
  const cancelled: ScanRecord = {
    ...run,
    id: "cancelled-update",
    status: "cancelled",
    dealCount: 0,
    createdAt: "2026-10-10T08:30:00.000Z",
  };
  state.scans.push(cancelled);
  await page.goto("/");
  const notice = page
    .locator(".read-notice")
    .filter({ hasText: "به‌روزرسانی لغو شد" });
  await expect(notice).toBeVisible();
  const close = notice.getByRole("button", { name: "بستن پیام اسکن" });
  const titleBox = await notice.locator("strong").boundingBox();
  const closeBox = await close.boundingBox();
  expect(titleBox).not.toBeNull();
  expect(closeBox).not.toBeNull();
  expect(
    Math.abs(
      titleBox!.y + titleBox!.height / 2 - closeBox!.y - closeBox!.height / 2
    )
  ).toBeLessThan(2);
  await close.click();
  await expect(notice).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "صفحه نخست", exact: true })
  ).toBeVisible();
  await expect(notice).toHaveCount(0);

  state.scans.push({
    ...cancelled,
    id: "another-cancelled-update",
    createdAt: "2026-10-10T08:45:00.000Z",
  });
  await page.reload();
  await expect(notice).toBeVisible();
});
