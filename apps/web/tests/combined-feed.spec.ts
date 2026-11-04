import { expect, test, type Page } from "@playwright/test";
import type {
  CartLine,
  CartSource,
  ProductSummary,
  ScanRecord,
} from "@better-buy/shared";

const date = "2026-11-01T08:00:00.000Z";
const location = {
  id: "home",
  name: "خانه",
  latitude: 35.7,
  longitude: 51.4,
  isDefault: true,
  coordinateRevision: 1,
  createdAt: date,
  updatedAt: date,
};
function run(source: CartSource, id = source): ScanRecord {
  return {
    id,
    locationId: "home",
    locationName: "خانه",
    source,
    threshold: 15,
    mode: "partial",
    status: "succeeded",
    createdAt: date,
    startedAt: date,
    finishedAt: date,
    vendorCount: 2,
    productCount: 4,
    dealCount: 4,
    errorCode: null,
    errorMessage: null,
    context: {
      location: { name: "خانه", latitude: 35.7, longitude: 51.4, revision: 1 },
      requestedThreshold: 15,
      effectiveThreshold: 15,
      policyVersion: "automatic-v1",
      manifest: {
        adapter: source,
        contractVersion: 1,
        feedKinds: ["promotion"],
      },
      scopeHash: source,
      eligibilityVersion: 1,
      offerKeyVersion: 1,
      coverage: "complete",
    },
  };
}
function product(
  source: CartSource,
  title: string,
  discount: number,
  wishlistMatch = false,
  cartQuantity = 0
): ProductSummary {
  const offer = {
    offerKey: title,
    productVariationId: title,
    vendorId: source,
    vendorTitle: "فروشگاه نمونه",
    vendorCode: null,
    priceRials: 100000,
    discountRials: discount * 1000,
    finalPriceRials: 100000 - discount * 1000,
    discountRatio: discount,
    stock: 9,
    state: "current" as const,
    logoUrl: "/icons/brand.svg",
  };
  return {
    key: title,
    scanId: source,
    groupKeyVersion: 2,
    title,
    image: "/icons/icon-512.png",
    categoryTitle: "خواربار",
    priceRials: offer.priceRials,
    discountRials: offer.discountRials,
    finalPriceRials: offer.finalPriceRials,
    discountRatio: discount,
    state: "current",
    bestCurrentOffer: { ...offer, logoUrl: null },
    currentStoreOfferCount: 2,
    conditionalOfferCount: 0,
    diagnostics: [],
    wishlistMatch,
    cartQuantity,
  };
}
async function fixture(page: Page, lostSource?: CartSource) {
  const products = [
    product("snappmarket", "چای ایرانی", 60, true),
    product("snappmarket", "روغن آفتابگردان", 70),
    product("okala", "شیر کم‌چرب", 50, false, 5),
    product("okala", "برنج ایرانی", 80),
  ];
  const state = {
    scans: [run("snappmarket"), run("okala")],
    reads: [] as URL[],
    posts: [] as { target: Record<string, unknown>; key: string }[],
    wishlistPosts: [] as unknown[],
    cartPosts: [] as string[],
    intents: new Map<string, ScanRecord>(),
    lines: { snappmarket: [] as CartLine[], okala: [] as CartLine[] },
    wishlist: [{ id: "tea", phrase: "چای", minDiscount: 15, createdAt: date }],
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    if (url.pathname === "/api/auth/get-session")
      return route.fulfill({
        json: {
          session: {
            id: "session",
            userId: "user",
            expiresAt: "2099-01-01T00:00:00Z",
          },
          user: { id: "user", name: "User", email: "user@example.com" },
        },
      });
    if (url.pathname === "/api/analytics/events")
      return route.fulfill({ status: 204 });
    let data: unknown = [];
    if (url.pathname === "/api/admin/access") data = { allowed: false };
    else if (url.pathname === "/api/locations") data = [location];
    else if (url.pathname === "/api/wishlist") {
      if (method === "POST") {
        const input: { phrase: string; minDiscount: number } =
          request.postDataJSON();
        state.wishlistPosts.push(input);
        state.wishlist.push({ id: "new", ...input, createdAt: date });
      }
      data = {
        items: state.wishlist,
        defaultLocationId: null,
        pushPublicKey: null,
        scheduleEnabled: false,
      };
    } else if (url.pathname === "/api/scans") {
      if (method === "POST") {
        const target: { source: CartSource } & Record<string, unknown> =
          request.postDataJSON();
        const key = request.headers()["idempotency-key"] ?? "";
        const created = {
          ...run(target.source, `${target.source}-active`),
          status: "queued" as const,
          finishedAt: null,
        };
        state.posts.push({ target, key });
        state.scans.unshift(created);
        state.intents.set(key, created);
        if (target.source === lostSource) return route.abort("failed");
        data = created;
      } else {
        const intent = url.searchParams.get("intent");
        data = intent
          ? state.intents.has(intent)
            ? [state.intents.get(intent)]
            : []
          : state.scans;
      }
    } else if (/\/api\/scans\/[^/]+$/.test(url.pathname))
      data = state.scans.find(
        (scan) => scan.id === url.pathname.split("/").at(-1)
      );
    else if (url.pathname.endsWith("/products")) {
      state.reads.push(url);
      const scanId = url.pathname.split("/")[3];
      const floor = Number(url.searchParams.get("minDiscount"));
      data = {
        items: products.filter(
          (item) => item.scanId === scanId && item.discountRatio >= floor
        ),
        nextCursor: null,
        observedAt: date,
        coverageSummary: "complete",
        baseline: { scanId: null, reason: "first_snapshot" },
      };
    } else if (url.pathname.endsWith("/offers")) {
      state.reads.push(url);
      const productTitle = decodeURIComponent(url.pathname.split("/")[5] ?? "");
      const group = products.find((item) => item.key === productTitle);
      data = {
        items: group?.bestCurrentOffer
          ? [
              {
                ...group.bestCurrentOffer,
                logoUrl: "https://example.com/logo.png",
              },
            ]
          : [],
        nextCursor: null,
      };
    } else if (url.pathname.startsWith("/api/carts/")) {
      const source =
        url.pathname.split("/")[3] === "okala" ? "okala" : "snappmarket";
      if (method === "PUT") {
        const key = decodeURIComponent(url.pathname.split("/")[5] ?? "");
        const group = products.find((item) => item.key === key);
        state.cartPosts.push(source);
        if (group)
          state.lines[source].push({
            key,
            title: group.title,
            image: group.image,
            categoryTitle: group.categoryTitle,
            quantity: 1,
          });
      }
      data = {
        source,
        locationId: "home",
        scanId: source,
        observedAt: date,
        coverage: "supported_discount_feeds",
        lines: state.lines[source],
        recommendation: {
          status: state.lines[source].length ? "partial" : "empty",
          optimal: true,
          stores: [],
          missingItems: state.lines[source].map((line) => ({
            ...line,
            reason: "missing_product",
          })),
          totalRials: 0,
        },
      };
    }
    await route.fulfill({ json: { data } });
  });
  return state;
}

test("both providers merge in personal order and discount filtering only reads saved results", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto("/");
  await expect(page.locator(".deal-row")).toHaveCount(4);
  await expect(
    page.getByRole("checkbox", { name: "اسنپ‌مارکت" })
  ).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "اکالا" })).toBeChecked();
  await expect(page.locator(".deal-row h2")).toHaveText([
    "چای ایرانی",
    "شیر کم‌چرب",
    "برنج ایرانی",
    "روغن آفتابگردان",
  ]);
  await page.getByRole("checkbox", { name: "اسنپ‌مارکت" }).uncheck();
  await expect(page.getByRole("checkbox", { name: "اکالا" })).toBeDisabled();
  await expect(page.locator(".deal-row")).toHaveCount(2);
  await page.getByRole("slider", { name: /حداقل تخفیف/ }).fill("80");
  await expect(page.locator(".deal-row h2")).toHaveText(["برنج ایرانی"]);
  expect(
    state.reads.some((url) => url.searchParams.get("minDiscount") === "80")
  ).toBeTruthy();
  expect(state.posts).toHaveLength(0);
});

test("product details show a large image, filtered store offers, full-name favorite and plus cart action", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto("/");
  await page
    .getByRole("button", { name: "جزئیات چای ایرانی", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "چای ایرانی", exact: true });
  await expect(dialog).toBeVisible();
  expect(
    await dialog
      .locator(".product-detail-image")
      .evaluate((node) => node.getBoundingClientRect().width)
  ).toBeGreaterThan(200);
  await expect(
    dialog.getByRole("link", { name: "باز کردن وب‌سایت اسنپ‌مارکت" })
  ).toHaveAttribute("href", "https://snapp.market");
  await expect(
    dialog.getByText("فروشگاه نمونه", { exact: true })
  ).toBeVisible();
  expect(
    state.reads.some(
      (url) =>
        url.pathname.endsWith("/offers") &&
        url.searchParams.get("minDiscount") === "40"
    )
  ).toBeTruthy();
  await dialog
    .getByRole("button", {
      name: "افزودن چای ایرانی به علاقه‌مندی‌ها",
      exact: true,
    })
    .click();
  await expect
    .poll(() => state.wishlistPosts)
    .toEqual([{ phrase: "چای ایرانی", minDiscount: 15 }]);
  await dialog
    .getByRole("button", { name: "افزودن چای ایرانی به سبد", exact: true })
    .click();
  await expect.poll(() => state.cartPosts).toEqual(["snappmarket"]);
});

test("each selected provider starts once and an uncertain provider reconciles independently", async ({
  page,
}) => {
  const state = await fixture(page, "snappmarket");
  await page.goto("/");
  await expect(page.locator(".deal-row")).toHaveCount(4);
  await page
    .getByRole("button", { name: "به‌روزرسانی تخفیف‌ها", exact: true })
    .click();
  await expect.poll(() => state.posts.length).toBe(2);
  expect(state.posts.map((item) => item.target.source).sort()).toEqual([
    "okala",
    "snappmarket",
  ]);
  expect(state.posts.map((item) => item.target.threshold)).toEqual([15, 15]);
  expect(new Set(state.posts.map((item) => item.key)).size).toBe(2);
  await expect(page.locator(".active-scan")).toHaveCount(2);
  await expect(
    page.getByRole("button", { name: "به‌روزرسانی تخفیف‌ها", exact: true })
  ).toBeDisabled();
});

test("navigation opens saved interests, inbox, history and secondary menu without overflow", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/");
  await expect(page.locator(".deal-row")).toHaveCount(4);
  await page
    .getByRole("button", { name: "علاقه‌مندی‌ها", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "فهرست علاقه‌مندی‌ها" })
  ).toBeVisible();
  await page.getByRole("button", { name: "بستن پنجره", exact: true }).click();
  await page.getByRole("button", { name: "اعلان‌ها", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "صندوق اعلان‌ها" })
  ).toBeVisible();
  await page.getByRole("button", { name: "بستن پنجره", exact: true }).click();
  await page.getByRole("button", { name: "تاریخچه", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "تاریخچه اسکن‌ها" })
  ).toBeVisible();
  await page.getByRole("button", { name: "منوی برنامه", exact: true }).click();
  await expect(
    page.getByRole("menuitem", { name: "مدیریت موقعیت‌ها" })
  ).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "ظاهر برنامه" })
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth
    )
  ).toBeTruthy();
  if ((page.viewportSize()?.width ?? 1000) <= 768) {
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "سبد خرید", exact: true }).click();
    await page
      .getByRole("menuitem", { name: "سبد اکالا", exact: true })
      .click();
    await expect(
      page.getByRole("dialog", { name: "سبد اکالا", exact: true })
    ).toBeVisible();
    await expect(page.locator(".header-actions")).toBeHidden();
  }
});
