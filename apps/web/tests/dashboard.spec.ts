import { expect, test, type Page } from "@playwright/test";
import type {
  DealGroupRecord,
  LocationRecord,
  ScanRecord,
} from "@better-buy/shared";
import { mkdir } from "node:fs/promises";
import path from "node:path";
const evidence = path.resolve(__dirname, "../../../.data/design-evidence");
async function captureState(page: Page, name: string, fullPage = true) {
  await mkdir(evidence, { recursive: true });
  await page.screenshot({
    path: path.join(evidence, `state-${test.info().project.name}-${name}.png`),
    fullPage,
  });
}
const date = "2026-10-08T08:00:00.000Z";
const home: LocationRecord = {
  id: "home",
  name: "خانه",
  latitude: 35.7,
  longitude: 51.4,
  isDefault: true,
  createdAt: date,
  updatedAt: date,
};
const office: LocationRecord = {
  ...home,
  id: "office",
  name: "دفتر",
  isDefault: false,
};
const run = (overrides: Partial<ScanRecord> = {}): ScanRecord => ({
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
  vendorCount: 12,
  productCount: 180,
  dealCount: 3,
  errorCode: null,
  errorMessage: null,
  ...overrides,
});
const group = (
  title = "چای سیاه ایرانی، بسته ۵۰۰ گرمی",
  scanId = "saved"
): DealGroupRecord => ({
  key: title,
  groupKeyVersion: 1,
  scanId,
  title,
  image: null,
  categoryTitle: "خواربار",
  priceRials: 200000,
  discountRials: 100000,
  finalPriceRials: 100000,
  discountRatio: 50,
  state: "new",
  vendors: ["فروشگاه محله", "هایپرمارکت ونک", "فروشگاه مرکزی"].map(
    (vendorTitle, i) => ({
      offerKey: title + ":" + i,
      productVariationId: "p",
      vendorId: String(i),
      vendorTitle,
      vendorCode: null,
      priceRials: 200000,
      discountRials: 100000,
      finalPriceRials: 100000,
      discountRatio: 50,
      stock: 4,
      state: "new",
    })
  ),
});
const representative = [
  group(),
  {
    ...group("روغن آفتابگردان، بطری ۱٫۵ لیتری"),
    priceRials: 300000,
    finalPriceRials: 200000,
    vendors: group().vendors.map((v) => ({
      ...v,
      priceRials: 300000,
      finalPriceRials: 200000,
    })),
  },
  {
    ...group("برنج ایرانی طارم، کیسه ۱۰ کیلوگرمی"),
    priceRials: 400000,
    finalPriceRials: 300000,
    vendors: group().vendors.map((v) => ({
      ...v,
      priceRials: 400000,
      finalPriceRials: 300000,
    })),
  },
];
// Fixture projection models the saved v2 contract, including differing prices.
function products(groups: DealGroupRecord[], query = "", sort = "discount") {
  const items = groups
    .filter((group) =>
      `${group.title} ${group.vendors.map((offer) => offer.vendorTitle).join(" ")}`.includes(
        query
      )
    )
    .map((group) => {
      const current = group.vendors
        .filter((offer) => offer.state !== "no_longer_present")
        .sort(
          (a, b) =>
            a.finalPriceRials - b.finalPriceRials ||
            a.vendorId.localeCompare(b.vendorId)
        );
      const best = current[0] ?? null;
      return {
        ...group,
        groupKeyVersion: 2,
        bestCurrentOffer: best,
        currentStoreOfferCount: current.length,
        conditionalOffers: [],
        diagnostics: [],
        conditionalOfferCount: 0,
        ...(best
          ? {
              priceRials: best.priceRials,
              discountRials: best.discountRials,
              finalPriceRials: best.finalPriceRials,
              discountRatio: best.discountRatio,
            }
          : {}),
      };
    })
    .sort((a, b) =>
      sort === "price"
        ? a.finalPriceRials - b.finalPriceRials
        : b.discountRatio - a.discountRatio ||
          a.finalPriceRials - b.finalPriceRials
    );
  return {
    items: items.map(({ vendors, conditionalOffers, ...item }) => {
      void vendors;
      void conditionalOffers;
      return item;
    }),
    nextCursor: null,
    observedAt: date,
    coverageSummary: "complete",
    baseline: { scanId: null, reason: "first_snapshot" },
  };
}
async function mock(
  page: Page,
  fixture: {
    locations?: LocationRecord[];
    scans?: ScanRecord[];
    groups?: DealGroupRecord[];
    signedOut?: boolean;
  } = {}
) {
  const state = {
    locations: fixture.locations ?? [home],
    scans: fixture.scans ?? [],
    groups: fixture.groups ?? [],
    posts: [] as unknown[],
    retailerRequests: [] as string[],
    statusReads: 0,
  };
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    let data: unknown = [];
    if (url.pathname === "/api/auth/get-session") {
      await route.fulfill({
        json: fixture.signedOut
          ? null
          : {
              session: {
                id: "s",
                userId: "user-1",
                expiresAt: "2099-01-01T00:00:00Z",
              },
              user: {
                id: "user-1",
                name: "کاربر نمونه",
                email: "fixture@example.com",
              },
            },
      });
      return;
    }
    if (url.pathname.includes("/settings/")) {
      state.retailerRequests.push(url.pathname);
      await route.fulfill({ status: 404, json: { error: "NOT_FOUND" } });
      return;
    }
    if (url.pathname === "/api/locations") {
      if (method === "POST") {
        state.locations = [
          ...state.locations,
          { ...home, ...route.request().postDataJSON(), id: "created" },
        ];
        data = state.locations.at(-1);
      } else data = state.locations;
    } else if (url.pathname === "/api/locations/search")
      data = [
        { displayName: "میدان ونک، تهران", latitude: 35.75, longitude: 51.41 },
      ];
    else if (url.pathname.startsWith("/api/locations/")) {
      const id = url.pathname.split("/").at(-1);
      if (method === "DELETE") {
        state.locations = state.locations.filter((l) => l.id !== id);
        state.scans = state.scans.filter((s) => s.locationId !== id);
        await route.fulfill({ status: 204 });
        return;
      }
      const input = route.request().postDataJSON();
      state.locations = state.locations.map((l) =>
        l.id === id ? { ...l, ...input } : l
      );
      data = state.locations.find((l) => l.id === id);
    } else if (url.pathname === "/api/scans") {
      if (method === "POST") {
        const input = route.request().postDataJSON();
        state.posts.push(input);
        state.scans = [
          run({
            ...input,
            id: input.source === "okala" ? "active-okala" : "active",
            status: "queued",
            createdAt: new Date().toISOString(),
            finishedAt: null,
          }),
          ...state.scans,
        ];
        data = state.scans[0];
      } else data = state.scans;
    } else if (url.pathname.endsWith("/products"))
      data = products(
        state.groups,
        url.searchParams.get("q") ?? "",
        url.searchParams.get("sort") ?? "discount"
      );
    else if (url.pathname.endsWith("/offers")) {
      const key = decodeURIComponent(url.pathname.split("/").at(-2)!);
      data = {
        items: [
          ...(state.groups.find((group) => group.key === key)?.vendors ?? []),
        ].sort(
          (a, b) =>
            Number(a.state === "no_longer_present") -
              Number(b.state === "no_longer_present") ||
            a.finalPriceRials - b.finalPriceRials ||
            a.vendorTitle.localeCompare(b.vendorTitle, "fa")
        ),
        nextCursor: null,
      };
    } else if (url.pathname.endsWith("/deals")) data = [];
    else if (url.pathname.startsWith("/api/scans/")) {
      state.statusReads++;
      data =
        state.scans.find((s) => s.id === url.pathname.split("/").at(-1)) ??
        run({ id: "active", status: "running", finishedAt: null });
    }
    await route.fulfill({ json: { data } });
  });
  return state;
}
async function chooseSelect(page: Page, label: string, option: string) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}
async function openMenuItem(page: Page, name: string) {
  await page.getByRole("button", { name: "منوی برنامه", exact: true }).click();
  await page.getByRole("menuitem", { name, exact: true }).click();
}
async function onlyProvider(page: Page, source: "snappmarket" | "okala") {
  const selected = page.getByRole("checkbox", {
    name: source === "okala" ? "اکالا" : "اسنپ‌مارکت",
    exact: true,
  });
  await selected.check();
  await page
    .getByRole("checkbox", {
      name: source === "okala" ? "اسنپ‌مارکت" : "اکالا",
      exact: true,
    })
    .uncheck();
}
const scanButton = (page: Page) =>
  page.getByRole("button", {
    name: /^(پیدا کردن تخفیف‌ها|به‌روزرسانی تخفیف‌ها)$/,
    exact: true,
  });
const offerHeading = (page: Page, title = representative[0]!.title) =>
  page.getByRole("heading", { name: title, exact: true });
const success = async (page: Page) => {
  const state = await mock(page, { scans: [run()], groups: representative });
  await page.goto("/");
  await expect(offerHeading(page)).toBeVisible();
  return state;
};

test("signed out, pending, and authentication error have clear next steps", async ({
  page,
}) => {
  await mock(page, { signedOut: true });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "به بهتر بخر خوش آمدید", exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "ساخت حساب کاربری" })
  ).toBeVisible();
  await page.route("**/api/auth/sign-in/phone", (r) =>
    r.fulfill({ status: 500, json: { error: { message: "failed" } } })
  );
  await page.getByLabel("شماره همراه", { exact: true }).fill("09123456789");
  await page.getByLabel("رمز عبور", { exact: true }).fill("test-password");
  await page.getByRole("button", { name: "ورود", exact: true }).click();
  await expect(page.locator(".phone-auth-error")).toContainText("failed");
  await captureState(page, "sign-in-error");
  let release = () => {};
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/auth/get-session", async (r) => {
    await waiting;
    await r.fulfill({ status: 503, json: { message: "failed" } });
  });
  await page.reload();
  await expect(page.getByText("در حال بررسی ورود…")).toBeVisible();
  await captureState(page, "auth-pending");
  release();
  await expect(
    page.getByRole("heading", { name: "بررسی ورود انجام نشد" })
  ).toBeVisible();
  await captureState(page, "auth-error");
  await page.route("**/api/auth/get-session", (r) => r.fulfill({ json: null }));
  await page
    .getByRole("button", { name: "دریافت دوباره", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "ساخت حساب کاربری" })
  ).toBeVisible();
});
test("first visit creates a location from address search and maps the selected result", async ({
  page,
}) => {
  const state = await mock(page, { locations: [] });
  let releaseHistory = () => {};
  const historyRead = new Promise<void>((resolve) => {
    releaseHistory = resolve;
  });
  let delayedHistoryStarted = false;
  await page.route(/\/api\/scans(?:\?.*)?$/, async (route) => {
    if (route.request().method() === "GET" && state.locations.length) {
      delayedHistoryStarted = true;
      await historyRead;
    }
    await route.fallback();
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "موقعیت تحویل را اضافه کنید" })
  ).toBeVisible();
  await expect(scanButton(page)).toBeDisabled();
  await page
    .locator(".onboarding")
    .getByRole("button", { name: "افزودن موقعیت تحویل" })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "افزودن موقعیت تحویل",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("نام مکان").fill("خانه تازه");
  await dialog.getByLabel("جست‌وجوی نشانی در تهران").fill("ونک");
  await dialog.getByRole("button", { name: "جست‌وجو", exact: true }).click();
  await dialog.getByRole("button", { name: "میدان ونک، تهران" }).click();
  await expect(dialog.getByLabel("جست‌وجوی نشانی در تهران")).toHaveValue(
    "میدان ونک، تهران"
  );
  await expect(dialog.locator(".maplibre-map")).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "ذخیره مکان" })
  ).toBeEnabled();
  await captureState(page, "address-selected");
  await dialog.getByRole("button", { name: "ذخیره مکان" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel("موقعیت تحویل", { exact: true })).toContainText(
    "خانه تازه"
  );
  await expect.poll(() => delayedHistoryStarted).toBe(true);
  expect(state.posts).toEqual([]);
  releaseHistory();
  await expect(page.locator(".active-scan")).toHaveCount(2);
  expect(state.posts).toEqual(
    expect.arrayContaining([
      {
        locationId: "created",
        source: "snappmarket",
        threshold: 15,
        mode: "partial",
      },
      {
        locationId: "created",
        source: "okala",
        threshold: 15,
        mode: "partial",
      },
    ])
  );
  expect(state.posts).toHaveLength(2);
  await page.reload();
  await expect(page.locator(".active-scan")).toHaveCount(2);
  expect(state.posts).toHaveLength(2);
  await captureState(page, "first-automatic-update");
  expect(state.locations).toHaveLength(1);
});
test("address search lets users choose a result and refine the map location", async ({
  page,
}) => {
  const state = await mock(page);
  await page.route("https://nominatim.openstreetmap.org/search**", (route) =>
    route.fulfill({
      json: [
        {
          display_name: "میدان ونک، تهران",
          lat: "35.75",
          lon: "51.41",
        },
        {
          display_name: "میدان تجریش، تهران",
          lat: "35.8",
          lon: "51.43",
        },
      ],
    })
  );
  await page.goto("/");
  await openMenuItem(page, "مدیریت موقعیت‌ها");
  await page.getByRole("button", { name: "ویرایش خانه" }).click();
  const dialog = page.getByRole("dialog", { name: "ویرایش مکان", exact: true });
  await dialog.getByLabel("جست‌وجوی نشانی در تهران").fill("میدان");
  await dialog.getByRole("button", { name: "جست‌وجو", exact: true }).click();

  const selectedResult = dialog.getByRole("button", {
    name: "میدان تجریش، تهران",
  });
  await selectedResult.click();
  await expect(selectedResult).toHaveAttribute("aria-pressed", "true");
  await expect(
    dialog.getByRole("button", { name: "میدان ونک، تهران" })
  ).toBeVisible();
  await expect(dialog.locator(".maplibre-map")).toBeVisible();
  await dialog.getByRole("button", { name: "ذخیره مکان" }).click();
  await expect(dialog).toHaveCount(0);
  expect(state.locations[0]?.latitude).toBe(35.8);
  expect(state.locations[0]?.longitude).toBe(51.43);
});
test("location reads recover and out-of-area saved locations remain editable", async ({
  page,
}) => {
  await mock(page, { locations: [{ ...home, latitude: 0 }] });
  let calls = 0;
  let fail = true;
  let release = () => {};
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/locations", async (r) => {
    calls++;
    await waiting;
    return r.fulfill(
      fail
        ? { status: 503, json: { error: "TEMPORARY" } }
        : { json: { data: [{ ...home, latitude: 0 }] } }
    );
  });
  await page.goto("/");
  await expect(page.getByText("در حال دریافت اطلاعات…")).toBeVisible();
  await captureState(page, "location-loading");
  release();
  await expect(
    page.getByText("موقعیت‌ها دریافت نشدند", { exact: true })
  ).toBeVisible();
  await captureState(page, "location-error");
  expect(calls).toBe(3);
  fail = false;
  await page
    .getByRole("button", { name: "دریافت دوباره", exact: true })
    .click();
  await expect(page.getByText("موقعیت خارج از محدوده خدمات است")).toBeVisible();
  await captureState(page, "outside-area");
  await expect(scanButton(page)).toBeDisabled();
  await openMenuItem(page, "مدیریت موقعیت‌ها");
  await page.getByRole("button", { name: "ویرایش خانه" }).click();
  await expect(
    page.getByRole("dialog", { name: "ویرایش مکان", exact: true })
  ).toBeVisible();
});
test("selected-provider scans use the 15 percent collection floor with no mode choice or duplicate submits", async ({
  page,
}) => {
  const state = await mock(page);
  let release = () => {};
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(/\/api\/scans(?:\?.*)?$/, async (route) => {
    if (route.request().method() === "POST") await waiting;
    await route.fallback();
  });
  await page.goto("/");
  await expect(scanButton(page)).toBeEnabled();
  await onlyProvider(page, "okala");
  await scanButton(page).dblclick();
  await expect(
    page.getByRole("button", { name: "در حال شروع…", exact: true })
  ).toBeDisabled();
  await captureState(page, "submitting");
  release();
  await expect(
    page.getByText("اسکن در انتظار بررسی است", { exact: true })
  ).toBeVisible();
  expect(state.posts).toEqual([
    { locationId: "home", source: "okala", threshold: 15, mode: "partial" },
  ]);
  await expect(scanButton(page)).toBeDisabled();
  await expect(page.getByText("دامنه اسکن", { exact: true })).toHaveCount(0);
  expect(state.retailerRequests).toEqual([]);
  await openMenuItem(page, "راهنمای بهتر بخر");
  await expect(
    page.getByRole("dialog", { name: "راهنمای بهتر بخر" })
  ).toContainText("ورود به فروشگاه نیست");
});
test("account-wide running scans remain discoverable in another location and stop at terminal status", async ({
  page,
}) => {
  const state = await mock(page, {
    locations: [home, office],
    scans: [run({ id: "active", status: "running", finishedAt: null })],
  });
  let finish = false;
  let polls = 0;
  await page.route("**/api/scans/active", (r) => {
    polls++;
    return r.fulfill({
      json: {
        data: run({
          id: "active",
          status: finish ? "succeeded" : "running",
          finishedAt: finish ? date : null,
        }),
      },
    });
  });
  await page.goto("/");
  await expect(
    page.getByText("در حال پیدا کردن تخفیف‌ها…", { exact: true })
  ).toBeVisible();
  await chooseSelect(page, "موقعیت تحویل", "دفتر");
  await onlyProvider(page, "okala");
  await expect(page.locator(".active-scan")).toContainText("خانه · اسنپ‌مارکت");
  await expect(scanButton(page)).toBeDisabled();
  finish = true;
  await expect(page.locator(".active-scan")).toHaveCount(0);
  const terminalPolls = polls;
  await page.waitForTimeout(1800);
  expect(polls).toBe(terminalPolls);
  expect(state.posts).toEqual([]);
});
test("status transport failure retains the server status and recovers without marking failed", async ({
  page,
}) => {
  await mock(page, {
    scans: [run({ id: "active", status: "running", finishedAt: null })],
  });
  let fail = true;
  let calls = 0;
  await page.route("**/api/scans/active", (r) => {
    calls++;
    return fail
      ? r.abort("connectionfailed")
      : r.fulfill({
          json: { data: run({ id: "active", status: "succeeded" }) },
        });
  });
  await page.goto("/");
  await expect(
    page.getByText("وضعیت اسکن تازه‌سازی نشد", { exact: true })
  ).toBeVisible();
  expect(calls).toBe(3);
  await expect(page.getByText(/اسکن ناموفق بود/)).toHaveCount(0);
  fail = false;
  await page.getByRole("button", { name: "بررسی دوباره وضعیت" }).click();
  await expect(page.locator(".active-scan")).toHaveCount(0);
  await expect(scanButton(page)).toBeEnabled();
});
test("transient result GET recovers within the bounded retry count", async ({
  page,
}) => {
  const state = await mock(page, { scans: [run()], groups: representative });
  let calls = 0;
  await page.route("**/api/scans/saved/products*", (r) => {
    calls++;
    return calls === 1
      ? r.abort("connectionfailed")
      : r.fulfill({ json: { data: products(representative) } });
  });
  await page.goto("/");
  await expect(offerHeading(page)).toBeVisible();
  expect(calls).toBe(2);
  expect(state.posts).toEqual([]);
});
test("persistent result failures show recovery after success and retry the same saved scan without POST", async ({
  page,
}) => {
  const state = await mock(page, { scans: [run()], groups: representative });
  let fail = true;
  let calls = 0;
  await page.route("**/api/scans/saved/products*", (r) => {
    calls++;
    return fail
      ? r.abort("connectionfailed")
      : r.fulfill({ json: { data: products(representative) } });
  });
  await page.goto("/");
  await expect(
    page.getByText("نتیجه اسکن دریافت نشد", { exact: true })
  ).toBeVisible();
  await expect(
    page.getByText("پیشنهادی با این حداقل تخفیف پیدا نشد", { exact: true })
  ).toHaveCount(0);
  expect(calls).toBe(3);
  fail = false;
  await page.getByRole("button", { name: "دریافت دوباره نتیجه" }).click();
  await expect(offerHeading(page)).toBeVisible();
  await expect(
    page.getByText("نتیجه اسکن دریافت نشد", { exact: true })
  ).toHaveCount(0);
  expect(calls).toBe(4);
  expect(state.posts).toEqual([]);
});
test("the feed reads one product projection without downloading raw offers", async ({
  page,
}) => {
  const state = await mock(page, { scans: [run()], groups: representative });
  let rawReads = 0;
  await page.route("**/api/scans/saved/deals", (route) => {
    rawReads++;
    return route.fulfill({ status: 403 });
  });
  await page.goto("/");
  await expect(offerHeading(page)).toBeVisible();
  expect(rawReads).toBe(0);
  expect(state.posts).toEqual([]);
});
test("background result failures preserve this context's cached snapshot and clear on recovery", async ({
  page,
}) => {
  const state = await success(page);
  let fail = true;
  await page.route("**/api/scans/saved/products*", (r) =>
    fail
      ? r.abort("connectionfailed")
      : r.fulfill({ json: { data: products(representative) } })
  );
  await page.getByRole("button", { name: "تازه‌سازی نتیجه" }).click();
  await expect(
    page.getByText("تازه‌سازی نتیجه انجام نشد", { exact: true })
  ).toBeVisible();
  await expect(offerHeading(page)).toBeVisible();
  await expect(
    page.getByText("نتیجه ذخیره‌شده با زمان خودش حفظ شده است.", { exact: true })
  ).toBeVisible();
  fail = false;
  await page.getByRole("button", { name: "دریافت دوباره نتیجه" }).click();
  await expect(
    page.getByText("تازه‌سازی نتیجه انجام نشد", { exact: true })
  ).toHaveCount(0);
  expect(state.posts).toEqual([]);
});
for (const status of [401, 403, 404, 422, 200])
  test(`permanent or invalid result HTTP ${status} is not retried`, async ({
    page,
  }) => {
    await mock(page, { scans: [run()] });
    let calls = 0;
    await page.route("**/api/scans/saved/products*", (r) => {
      calls++;
      return r.fulfill({
        status,
        json:
          status === 200 ? { data: [{ bogus: true }] } : { error: "PERMANENT" },
      });
    });
    await page.goto("/");
    await expect(
      page.getByText("نتیجه اسکن دریافت نشد", { exact: true })
    ).toBeVisible();
    expect(calls).toBe(1);
  });

test("long Retry-After prevents rapid repeated requests", async ({ page }) => {
  await mock(page, { scans: [run()] });
  let calls = 0;
  await page.route("**/api/scans/saved/products*", (r) => {
    calls++;
    return r.fulfill({
      status: 429,
      headers: { "Retry-After": "60" },
      json: { error: "RATE_LIMIT" },
    });
  });
  await page.goto("/");
  await expect(
    page.getByText("نتیجه اسکن دریافت نشد", { exact: true })
  ).toBeVisible();
  await page.waitForTimeout(1200);
  expect(calls).toBe(1);
});
test("a lost start response reconciles a known scan with one POST", async ({
  page,
}) => {
  const state = await mock(page);
  await page.route(/\/api\/scans(?:\?.*)?$/, (r) => {
    if (r.request().method() === "POST") {
      const input = r.request().postDataJSON();
      state.posts.push(input);
      state.scans = [
        run({
          ...input,
          id: "recovered",
          status: "running",
          createdAt: new Date().toISOString(),
          finishedAt: null,
        }),
      ];
      return r.abort("connectionfailed");
    }
    return r.fulfill({ json: { data: state.scans } });
  });
  await page.goto("/");
  await onlyProvider(page, "snappmarket");
  await scanButton(page).click();
  await expect(page.locator(".active-scan")).toContainText("خانه");
  await expect(scanButton(page)).toBeDisabled();
  await page.waitForTimeout(1000);
  expect(state.posts).toHaveLength(1);
});
test("an unknown start retains its intent after fresh reads and an explicit resend", async ({
  page,
}) => {
  const state = await mock(page);
  let posts = 0;
  await page.route(/\/api\/scans(?:\?.*)?$/, (r) => {
    if (r.request().method() === "POST") {
      posts++;
      return r.abort("connectionfailed");
    }
    return r.fulfill({ json: { data: state.scans } });
  });
  await page.goto("/");
  await onlyProvider(page, "snappmarket");
  await scanButton(page).click();
  await expect(
    page.getByText("نتیجه شروع اسکن مشخص نیست", { exact: true })
  ).toBeVisible();
  await expect(scanButton(page)).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "بررسی دوباره درخواست قبلی" })
  ).toBeVisible();
  await page.waitForTimeout(1000);
  expect(posts).toBe(1);
  await page.getByRole("button", { name: "بررسی دوباره درخواست قبلی" }).click();
  await expect(scanButton(page)).toBeDisabled();
  expect(posts).toBe(2);
});
test("reconciliation failure keeps duplicate start blocked until the authenticated read recovers", async ({
  page,
}) => {
  await mock(page);
  let failReads = false;
  let posts = 0;
  await page.route(/\/api\/scans(?:\?.*)?$/, (r) => {
    if (r.request().method() === "POST") {
      posts++;
      failReads = true;
      return r.abort("connectionfailed");
    }
    return r.fulfill(
      failReads
        ? { status: 503, json: { error: "TEMPORARY" } }
        : { json: { data: [] } }
    );
  });
  await page.goto("/");
  await onlyProvider(page, "snappmarket");
  await scanButton(page).click();
  await expect(
    page.getByText("نتیجه شروع اسکن مشخص نیست", { exact: true })
  ).toBeVisible();
  await expect(scanButton(page)).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "بررسی دوباره درخواست قبلی" })
  ).toHaveCount(0);
  failReads = false;
  await page
    .locator(".read-notice")
    .filter({ hasText: "نتیجه شروع اسکن مشخص نیست" })
    .getByRole("button", { name: "دریافت دوباره", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "بررسی دوباره درخواست قبلی" })
  ).toBeVisible();
  expect(posts).toBe(1);
});
for (const boundary of ["location", "source", "scan"])
  test(`late ledger responses cannot cross the ${boundary} boundary`, async ({
    page,
  }) => {
    const old = run({ id: "old", createdAt: "2026-10-07T08:00:00Z" });
    await mock(page, { locations: [home, office], scans: [run(), old] });
    let started = false;
    let release = () => {};
    const waiting = new Promise<void>((r) => {
      release = r;
    });
    await page.route("**/api/scans/saved/products*", async (r) => {
      started = true;
      await waiting;
      await r
        .fulfill({ json: { data: products([group("پیشنهاد زمینه قبلی")]) } })
        .catch(() => {});
    });
    await page.goto("/");
    await expect.poll(() => started).toBe(true);
    if (boundary === "location")
      await chooseSelect(page, "موقعیت تحویل", "دفتر");
    if (boundary === "source") {
      await onlyProvider(page, "okala");
    }
    if (boundary === "scan") {
      await page.getByRole("button", { name: "تاریخچه", exact: true }).click();
      await page
        .locator(".run-item")
        .last()
        .getByRole("button", { name: "نمایش نتیجه", exact: true })
        .click();
    }
    release();
    await page.waitForTimeout(500);
    await expect(
      page.getByRole("heading", { name: "پیشنهاد زمینه قبلی" })
    ).toHaveCount(0);
  });
test("sign-out retires reads and another account cannot see late private results", async ({
  page,
}) => {
  await mock(page, { scans: [run()] });
  let requested = false;
  let release = () => {};
  const waiting = new Promise<void>((r) => {
    release = r;
  });
  await page.route("**/api/scans/saved/products*", async (r) => {
    requested = true;
    await waiting;
    await r
      .fulfill({ json: { data: products([group("پیشنهاد خصوصی حساب قبلی")]) } })
      .catch(() => {});
  });
  await page.goto("/");
  await expect.poll(() => requested).toBe(true);
  await page.route("**/api/auth/get-session", (r) => r.fulfill({ json: null }));
  await page.route("**/api/auth/sign-out", (r) =>
    r.fulfill({ json: { success: true } })
  );
  await page.getByRole("button", { name: "منوی برنامه", exact: true }).click();
  await page.getByRole("menuitem", { name: "خروج از حساب" }).click();
  await expect(
    page.getByRole("button", { name: "ساخت حساب کاربری" })
  ).toBeVisible();
  release();
  await page.waitForTimeout(300);
  await expect(
    page.getByRole("heading", { name: "پیشنهاد خصوصی حساب قبلی" })
  ).toHaveCount(0);
  await page.route("**/api/auth/get-session", (r) =>
    r.fulfill({
      json: {
        session: {
          id: "s2",
          userId: "user-2",
          expiresAt: "2099-01-01T00:00:00Z",
        },
        user: { id: "user-2", name: "کاربر دوم", email: "second@example.com" },
      },
    })
  );
  await page.route(/\/api\/scans(?:\?.*)?$/, (r) =>
    r.fulfill({ json: { data: [] } })
  );
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "هنوز نتیجه‌ای برای این انتخاب ندارید" })
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "پیشنهاد خصوصی حساب قبلی" })
  ).toHaveCount(0);
});
test("reconnect refreshes stale failed reads without another scan submission", async ({
  page,
}) => {
  const state = await mock(page, { scans: [run()] });
  let fail = true;
  await page.route("**/api/scans/saved/products*", (r) =>
    fail
      ? r.abort("connectionfailed")
      : r.fulfill({ json: { data: products(representative) } })
  );
  await page.goto("/");
  await expect(
    page.getByText("نتیجه اسکن دریافت نشد", { exact: true })
  ).toBeVisible();
  fail = false;
  await page.evaluate(() => {
    window.dispatchEvent(new Event("offline"));
    window.dispatchEvent(new Event("online"));
  });
  await expect(offerHeading(page)).toBeVisible();
  expect(state.posts).toEqual([]);
});
test("successful empty results, filter-empty results, and loading have distinct copy", async ({
  page,
}) => {
  const state = await mock(page, { scans: [run()] });
  let release = () => {};
  const waiting = new Promise<void>((r) => {
    release = r;
  });
  await page.route("**/api/scans/saved/products*", async (r) => {
    await waiting;
    await r.fulfill({ json: { data: products([]) } });
  });
  await page.goto("/");
  await expect(page.getByText("در حال دریافت نتیجه ذخیره‌شده…")).toBeVisible();
  release();
  await expect(
    page.getByRole("heading", { name: "پیشنهادی با این حداقل تخفیف پیدا نشد" })
  ).toBeVisible();
  state.groups = representative;
  await page.unroute("**/api/scans/saved/products*");
  await page.reload();
  await expect(offerHeading(page)).toBeVisible();
  await page.getByLabel("جست‌وجوی کالا یا فروشگاه").fill("هیچ نتیجه");
  await expect(
    page.getByRole("heading", { name: "چیزی با این جست‌وجو پیدا نشد" })
  ).toBeVisible();
  await page
    .locator(".empty")
    .getByRole("button", { name: "پاک‌کردن جست‌وجو" })
    .click();
  await expect(offerHeading(page)).toBeVisible();
});
test("history identifies context and retains Jet results without new Jet scans", async ({
  page,
}) => {
  const jet = run({
    id: "jet",
    source: "digikalajet",
    threshold: 25,
    mode: "full",
  });
  const state = await mock(page, {
    scans: [jet],
    groups: [group("پیشنهاد تاریخی جت", "jet")],
  });
  await page.goto("/");
  await page.getByRole("button", { name: "تاریخچه", exact: true }).click();
  await expect(page.locator(".run-item")).toContainText("حداقل ۲۵٪");
  await page.getByRole("button", { name: "نمایش نتیجه", exact: true }).click();
  await expect(offerHeading(page, "پیشنهاد تاریخی جت")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "نتیجه تاریخی", exact: true })
  ).toBeVisible();
  await expect(page.locator(".deal-row .product-provider")).toContainText(
    "دیجی‌کالا جت"
  );
  await expect(
    page.getByRole("button", { name: /افزودن .* به سبد/ })
  ).toHaveCount(0);
  await expect(scanButton(page)).toBeEnabled();
  expect(state.posts).toEqual([]);
});
test("a failed scan retains the previous snapshot and repeating it is an explicit new scan", async ({
  page,
}) => {
  const state = await mock(page, {
    scans: [
      run({
        id: "failed",
        status: "failed",
        createdAt: "2026-10-08T09:00:00Z",
        errorMessage: "پیشنهادها کامل دریافت نشدند.",
      }),
      run(),
    ],
    groups: representative,
  });
  await page.goto("/");
  await expect(offerHeading(page)).toBeVisible();
  await expect(page.getByText(/اسکن ناموفق بود/)).toBeVisible();
  await page.getByRole("button", { name: "تاریخچه", exact: true }).click();
  await page.getByRole("button", { name: "اسکن تازه با این گزینه‌ها" }).click();
  await expect(page.locator(".active-scan")).toBeVisible();
  expect(state.posts).toHaveLength(1);
});
test("location editing and deletion restore selection with keyboard-accessible dialogs", async ({
  page,
}) => {
  await mock(page, { locations: [home, office] });
  await page.goto("/");
  await openMenuItem(page, "مدیریت موقعیت‌ها");
  const manager = page.getByRole("dialog", {
    name: "موقعیت‌های تحویل",
    exact: true,
  });
  await expect(manager).toBeVisible();
  await manager.evaluate((element) =>
    element.setAttribute("data-location-dialog-instance", "original")
  );
  await page.getByRole("button", { name: "ویرایش خانه" }).click();
  const editor = page.getByRole("dialog", { name: "ویرایش مکان", exact: true });
  await expect(page.locator('[role="dialog"]')).toHaveCount(1);
  await expect(editor).toHaveAttribute(
    "data-location-dialog-instance",
    "original"
  );
  await expect(page.locator(".sheet-backdrop")).toHaveCount(1);
  await captureState(page, "single-location-editor");
  await editor.getByLabel("نام مکان").fill("خانه من");
  await editor.getByRole("button", { name: "ذخیره مکان" }).click();
  await expect(editor).toHaveCount(0);
  await page.getByRole("button", { name: "ویرایش خانه من" }).click();
  await page.getByRole("button", { name: "حذف مکان و تاریخچه" }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toBeVisible();
  await expect(confirm.getByRole("button", { name: "انصراف" })).toBeFocused();
  await confirm.getByRole("button", { name: "انصراف" }).click();
  await expect(confirm).toHaveCount(0);
  await expect(editor).toBeVisible();
  await expect(page.locator('[role="dialog"]')).toHaveCount(1);
  await editor.getByRole("button", { name: "حذف مکان و تاریخچه" }).click();
  await page.getByRole("button", { name: "حذف همیشگی" }).click();
  await expect(confirm).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "ویرایش خانه من" })
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(manager).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "منوی برنامه", exact: true })
  ).toBeFocused();
  await expect(page.getByLabel("موقعیت تحویل", { exact: true })).toContainText(
    "دفتر"
  );
});
test("location list, edit and create replace content in the same dialog and discard cancelled drafts", async ({
  page,
}) => {
  const state = await mock(page, { locations: [home, office] });
  await page.goto("/");
  await openMenuItem(page, "مدیریت موقعیت‌ها");
  const shell = page.locator('[role="dialog"]');
  await shell.evaluate((element) =>
    element.setAttribute("data-location-dialog-instance", "original")
  );
  await shell.getByRole("button", { name: "ویرایش خانه", exact: true }).click();
  await shell.getByLabel("نام مکان").fill("پیش‌نویس ذخیره‌نشده");
  await shell.getByRole("button", { name: "بازگشت به موقعیت‌ها" }).click();
  await expect(
    shell.getByRole("heading", { name: "موقعیت‌های تحویل" })
  ).toBeVisible();
  await expect(shell).toHaveCount(1);
  await shell.getByRole("button", { name: "ویرایش دفتر" }).click();
  await expect(shell.getByLabel("نام مکان")).toHaveValue("دفتر");
  await expect(shell.getByLabel("مکان پیش‌فرض باشد")).not.toBeChecked();
  await page.keyboard.press("Escape");
  await expect(
    shell.getByRole("heading", { name: "موقعیت‌های تحویل" })
  ).toBeVisible();
  await shell.getByRole("button", { name: "افزودن موقعیت تحویل" }).click();
  await expect(shell.getByLabel("نام مکان")).toHaveValue("");
  await shell.getByLabel("نام مکان").fill("پیش‌نویس تازه");
  await page.keyboard.press("Escape");
  expect(state.locations).toHaveLength(2);
  await shell.getByRole("button", { name: "افزودن موقعیت تحویل" }).click();
  await expect(shell).toHaveCount(1);
  await expect(shell).toHaveAttribute(
    "data-location-dialog-instance",
    "original"
  );
  await expect(page.locator(".sheet-backdrop")).toHaveCount(1);
  await expect(shell.getByLabel("نام مکان")).toHaveValue("");
  await shell.getByLabel("نام مکان").fill("خانه تازه");
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    expect(
      await shell.evaluate((element) =>
        element.contains(document.activeElement)
      )
    ).toBe(true);
  }
  await shell.getByRole("button", { name: "ذخیره مکان" }).click();
  await expect(
    shell.getByRole("heading", { name: "موقعیت‌های تحویل" })
  ).toBeVisible();
  await expect(
    shell.getByRole("button", { name: "ویرایش خانه تازه" })
  ).toBeVisible();
  await expect(shell).toHaveAttribute(
    "data-location-dialog-instance",
    "original"
  );
  await shell.getByRole("button", { name: "ویرایش خانه", exact: true }).click();
  await expect(shell.getByLabel("نام مکان")).toHaveValue("خانه");
  await shell.getByRole("button", { name: "بستن پنجره مکان" }).click();
  await expect(shell).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "منوی برنامه", exact: true })
  ).toBeFocused();
  expect(state.locations).toHaveLength(3);
});
test("saved feed supports search, sorting, inline discount filtering and accessible details without collection", async ({
  page,
}) => {
  const state = await success(page);
  const disclosure = page.locator(".vendor-disclosure summary").first();
  await disclosure.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".vendor-offers").first()).toBeVisible();
  await page.getByLabel("جست‌وجوی کالا یا فروشگاه").fill("چای");
  await expect(page.locator(".deal-row")).toHaveCount(1);
  await page
    .getByRole("button", { name: "پاک‌کردن جست‌وجو", exact: true })
    .click();
  await expect(page.locator(".deal-row")).toHaveCount(3);
  await chooseSelect(page, "مرتب‌سازی", "کمترین قیمت");
  await page.getByRole("button", { name: "حداقل تخفیف نتیجه‌ها" }).click();
  await page.getByRole("button", { name: "۵۰٪", exact: true }).click();
  const detailTrigger = page.getByRole("button", {
    name: `جزئیات ${representative[0]!.title}`,
    exact: true,
  });
  await detailTrigger.click();
  const dialog = page.getByRole("dialog", {
    name: representative[0]!.title,
    exact: true,
  });
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press("Tab");
    expect(
      await dialog.evaluate((el) => el.contains(document.activeElement))
    ).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", {
      name: `جزئیات ${representative[0]!.title}`,
      exact: true,
    })
  ).toBeFocused();
  await expect(page.locator(".deal-row")).toHaveCount(3);
  await expect(
    page.getByText(/Explore|انتخاب دسته|انتخاب کمپین|دامنه اسکن/)
  ).toHaveCount(0);
  expect(state.posts).toEqual([]);
});
test("best offer uses one store and historical offers never win the current price", async ({
  page,
}) => {
  const row = group();
  row.vendors = [
    {
      ...row.vendors[0]!,
      vendorTitle: "تاریخی",
      finalPriceRials: 1000,
      discountRatio: 99,
      state: "no_longer_present",
    },
    {
      ...row.vendors[1]!,
      vendorTitle: "قیمت بهتر",
      priceRials: 250000,
      finalPriceRials: 100000,
      discountRatio: 60,
    },
    {
      ...row.vendors[2]!,
      vendorTitle: "تخفیف بیشتر",
      priceRials: 1000000,
      finalPriceRials: 150000,
      discountRatio: 85,
    },
  ];
  await mock(page, { scans: [run()], groups: [row] });
  await page.goto("/");
  await expect(page.locator(".product-copy")).toContainText("قیمت بهتر");
  await expect(page.locator(".price-label")).toContainText("۲۵۰٬۰۰۰ تومان");
  await expect(page.locator(".price-label")).toContainText("۱۰۰٬۰۰۰ تومان");
  await expect(page.locator(".price-label .discount")).toHaveText("۶۰٪");
  await page.locator(".vendor-disclosure summary").click();
  await expect(page.locator(".vendor-offer").last()).toContainText(
    "قیمت تاریخی"
  );
});
test("appearance menu changes and persists light, dark and system themes", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  await success(page);
  const appearance = page.getByRole("button", {
    name: "منوی برنامه",
    exact: true,
  });
  await appearance.click();
  await page
    .getByRole("menuitem", { name: "ظاهر برنامه", exact: true })
    .click();
  await expect(
    page.getByRole("menuitemradio", { name: "سیستم", exact: true })
  ).toHaveAttribute("aria-checked", "true");
  await page.getByRole("menuitemradio", { name: "تیره", exact: true }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.reload();
  await expect(appearance).toBeVisible();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await appearance.click();
  await page
    .getByRole("menuitem", { name: "ظاهر برنامه", exact: true })
    .click();
  await expect(
    page.getByRole("menuitemradio", { name: "تیره", exact: true })
  ).toHaveAttribute("aria-checked", "true");
  await page.getByRole("menuitemradio", { name: "روشن", exact: true }).click();
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveClass(/light/);
  await page.reload();
  await expect(appearance).toBeVisible();
  await expect(page.locator("html")).toHaveClass(/light/);
  await appearance.focus();
  await page.keyboard.press("Enter");
  await page
    .getByRole("menuitem", { name: "ظاهر برنامه", exact: true })
    .click();
  await page.getByRole("menuitemradio", { name: "سیستم", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(appearance).toBeFocused();
  await openMenuItem(page, "مدیریت موقعیت‌ها");
  await page.getByRole("button", { name: "ویرایش خانه", exact: true }).click();
  await expect(page.locator('[role="dialog"]')).toHaveCount(1);
  await captureState(page, "single-location-editor-dark", false);
  await page.getByRole("button", { name: "بستن پنجره مکان" }).click();
  await appearance.click();
  await page
    .getByRole("menuitem", { name: "ظاهر برنامه", exact: true })
    .click();
  await captureState(page, "appearance-menu-dark", false);
  await page.keyboard.press("Escape");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveClass(/light/);
  for (const width of [360, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(appearance).toBeInViewport();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      )
    ).toBe(true);
  }
});
test("layouts, theme preference, long content, broken images and reduced motion are inspected", async ({
  page,
}, testInfo) => {
  await mkdir(evidence, { recursive: true });
  await success(page);
  for (const width of [360, 390, 768, 1280, 1440]) {
    await page.setViewportSize({ width, height: width < 600 ? 844 : 1000 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth
        )
      )
      .toBe(true);
    await expect(scanButton(page)).toBeVisible();
    expect(await scanButton(page).count()).toBe(1);
    await page.screenshot({
      path: path.join(
        evidence,
        `after-${testInfo.project.name}-${width}-light.png`
      ),
      fullPage: true,
    });
  }
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.screenshot({
    path: path.join(evidence, `after-${testInfo.project.name}-dark.png`),
    fullPage: true,
  });
  const long = {
    ...group(
      "کالای با نام طولانی Persian Product Name ۲۰۲۶ برای بررسی خوانایی و جلوگیری از سرریز در صفحه کوچک"
    ),
    image: "https://images.example.test/broken.jpg",
    vendors: group().vendors.map((v) => ({
      ...v,
      vendorTitle: "فروشگاه با نام طولانی در محله و منطقه برای بررسی خوانایی",
      finalPriceRials: 1234567890,
    })),
  };
  await page.route("**/api/scans/saved/products*", (r) =>
    r.fulfill({ json: { data: products([long]) } })
  );
  await page.route("https://images.example.test/**", (r) => r.abort());
  await page.setViewportSize({ width: 360, height: 844 });
  await page.reload();
  await expect(offerHeading(page, long.title)).toBeVisible();
  await expect(
    page.getByText("تصویر در دسترس نیست", { exact: true })
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      )
    )
    .toBe(true);
  await page.locator(".vendor-disclosure summary").click();
  await page.screenshot({
    path: path.join(
      evidence,
      `after-${testInfo.project.name}-long-expanded.png`
    ),
    fullPage: true,
  });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      )
    )
    .toBe(true);
});

test("capture state views, real retailer images, touch targets, focus and token contrast", async ({
  page,
}, testInfo) => {
  test.setTimeout(60000);
  await mkdir(evidence, { recursive: true });
  await page.setViewportSize({
    width: testInfo.project.name === "mobile" ? 390 : 1280,
    height: 900,
  });
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
  const capture = async (name: string) => {
    await page.screenshot({
      path: path.join(evidence, `state-${testInfo.project.name}-${name}.png`),
      fullPage: true,
    });
  };
  await mock(page, { signedOut: true });
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "ساخت حساب کاربری" })
  ).toBeVisible();
  await capture("signed-out");
  const state = await mock(page, { locations: [] });
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "موقعیت تحویل را اضافه کنید" })
  ).toBeVisible();
  await capture("no-location");
  await page
    .locator(".onboarding")
    .getByRole("button", { name: "افزودن موقعیت تحویل" })
    .click();
  await expect(
    page.getByRole("dialog", { name: "افزودن موقعیت تحویل", exact: true })
  ).toBeVisible();
  await capture("location-editor");
  await page.keyboard.press("Escape");
  state.locations = [home];
  state.scans = [run()];
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "پیشنهادی با این حداقل تخفیف پیدا نشد" })
  ).toBeVisible();
  await capture("empty-results");
  let release = () => {};
  const waiting = new Promise<void>((r) => {
    release = r;
  });
  await page.route("**/api/scans/saved/products*", async (r) => {
    await waiting;
    await r.fulfill({ status: 503, json: { error: "TEMPORARY" } });
  });
  await page.reload();
  await expect(page.getByText("در حال دریافت نتیجه ذخیره‌شده…")).toBeVisible();
  await capture("loading-results");
  release();
  await expect(
    page.getByText("نتیجه اسکن دریافت نشد", { exact: true })
  ).toBeVisible();
  await capture("error-results");
  await page.unroute("**/api/scans/saved/products*");
  // URLs observed from Okala's public campaign feed on 2026-10-08. All prices here remain fixtures.
  state.groups = [
    {
      ...group("پنیر خامه ای ویلی کاله 100 گرمی"),
      image:
        "https://asset.okala.com/unsigned/rs:fill/size:0:0/plain/s3://cdn/product/35cc5c64-bceb-40e4-aab3-6eed0b3ab359.jpg",
    },
    {
      ...group("دوغ گازدار لار هراز 1 لیتری"),
      image:
        "https://asset.okala.com/unsigned/rs:fill/size:0:0/plain/s3://cdn/product/a184e9ba-3071-41d6-a4c0-c054c4f57eb3.jpg",
    },
  ];
  await page.getByRole("button", { name: "دریافت دوباره نتیجه" }).click();
  await expect(offerHeading(page, state.groups[0]!.title)).toBeVisible();
  await expect
    .poll(
      () =>
        page
          .locator(".product-image img")
          .evaluateAll((images) =>
            images.every(
              (img) =>
                (img as HTMLImageElement).complete &&
                (img as HTMLImageElement).naturalWidth > 0
            )
          ),
      { timeout: 15000 }
    )
    .toBe(true);
  await capture("real-images");
  await page.locator(".vendor-disclosure summary").first().click();
  await capture("expanded-offers");
  await page
    .getByRole("button", {
      name: `جزئیات ${state.groups[0]!.title}`,
      exact: true,
    })
    .click();
  await capture("product-detail-dialog");
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", {
      name: `جزئیات ${state.groups[0]!.title}`,
      exact: true,
    })
  ).toBeFocused();
  const metrics = await page.evaluate(() => {
    const contrast = (a: string, b: string) => {
      const lum = (s: string) => {
        const n = s
          .match(/[\d.]+/g)!
          .slice(0, 3)
          .map(Number)
          .map((v) => {
            v /= 255;
            return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
          });
        return n[0]! * 0.2126 + n[1]! * 0.7152 + n[2]! * 0.0722;
      };
      const x = lum(a),
        y = lum(b);
      return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
    };
    const action = getComputedStyle(document.querySelector(".scan-button")!);
    const body = getComputedStyle(document.body);
    const badTargets = [
      ...document.querySelectorAll(
        "button,select,summary,input:not([type=checkbox])"
      ),
    ]
      .filter(
        (el) =>
          el.getBoundingClientRect().width > 0 &&
          el.getBoundingClientRect().height > 0
      )
      .filter((el) => el.getBoundingClientRect().height < 43).length;
    return {
      actionContrast: contrast(action.color, action.backgroundColor),
      bodyContrast: contrast(body.color, body.backgroundColor),
      badTargets,
      focusOutline: getComputedStyle(document.activeElement!).outlineStyle,
      firstOfferTop: document
        .querySelector(".deal-row")!
        .getBoundingClientRect().top,
    };
  });
  expect(metrics.actionContrast).toBeGreaterThanOrEqual(4.5);
  expect(metrics.bodyContrast).toBeGreaterThanOrEqual(4.5);
  expect(metrics.badTargets).toBe(0);
  expect(metrics.focusOutline).not.toBe("none");
  expect(metrics.firstOfferTop).toBeLessThan(760);
  await page.route("**/api/scans/saved/products*", (r) =>
    r.abort("connectionfailed")
  );
  await page.getByRole("button", { name: "تازه‌سازی نتیجه" }).click();
  await expect(
    page.getByText("تازه‌سازی نتیجه انجام نشد", { exact: true })
  ).toBeVisible();
  await capture("cached-error");
  await page.unroute("**/api/scans/saved/products*");
  state.scans = [run({ id: "active", status: "queued", finishedAt: null })];
  await page.reload();
  await expect(page.locator(".active-scan")).toBeVisible();
  await capture("queued");
  state.scans = [
    run({
      id: "active",
      status: "running",
      finishedAt: null,
      vendorCount: 2,
      productCount: 30,
    }),
  ];
  await page.reload();
  await expect(
    page.getByText("در حال پیدا کردن تخفیف‌ها…", { exact: true })
  ).toBeVisible();
  await capture("running");
  await page.route("**/api/scans/active", (r) => r.abort("connectionfailed"));
  await page.reload();
  await expect(
    page.getByText("وضعیت اسکن تازه‌سازی نشد", { exact: true })
  ).toBeVisible();
  await capture("status-unknown");
  await page.unroute("**/api/scans/active");
  state.scans = [
    run({
      id: "failed",
      status: "failed",
      errorMessage: "پیشنهادها کامل دریافت نشدند.",
      createdAt: "2026-10-08T09:00:00Z",
    }),
    run(),
  ];
  await page.reload();
  await expect(page.getByText(/اسکن ناموفق بود/)).toBeVisible();
  await capture("failed");
  state.scans = [run({ id: "jet", source: "digikalajet" })];
  state.groups = [group("پیشنهاد تاریخی جت", "jet")];
  await page.reload();
  await page.getByRole("button", { name: "تاریخچه", exact: true }).click();
  await capture("history");
  await page.getByRole("button", { name: "نمایش نتیجه", exact: true }).click();
  await expect(offerHeading(page, "پیشنهاد تاریخی جت")).toBeVisible();
  await capture("jet-history");
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await expect(page.locator("html")).toHaveClass(/dark/);
  const darkContrast = await page.locator(".scan-button").evaluate((el) => {
    const s = getComputedStyle(el);
    const lum = (str: string) => {
      const a = str
        .match(/[\d.]+/g)!
        .slice(0, 3)
        .map(Number)
        .map((v) => {
          v /= 255;
          return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
        });
      return a[0]! * 0.2126 + a[1]! * 0.7152 + a[2]! * 0.0722;
    };
    const a = lum(s.color),
      b = lum(s.backgroundColor);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  });
  expect(darkContrast).toBeGreaterThanOrEqual(4.5);
  await capture("dark-history");
  console.log(
    JSON.stringify({ project: testInfo.project.name, ...metrics, darkContrast })
  );
});

test("small mobile keyboard viewport keeps location forms and filters usable", async ({
  page,
}) => {
  await success(page);
  await page.setViewportSize({ width: 390, height: 480 });
  await openMenuItem(page, "مدیریت موقعیت‌ها");
  await page.getByRole("button", { name: "ویرایش خانه" }).click();
  const editor = page.getByRole("dialog", { name: "ویرایش مکان", exact: true });
  await editor.getByLabel("نام مکان").fill("خانه با صفحه‌کلید باز");
  await expect(editor.getByLabel("نام مکان")).toBeFocused();
  await editor
    .getByRole("button", { name: "ذخیره مکان" })
    .scrollIntoViewIfNeeded();
  await expect(
    editor.getByRole("button", { name: "ذخیره مکان" })
  ).toBeInViewport();
  const bounds = await editor.boundingBox();
  expect(bounds!.height).toBeLessThanOrEqual(456);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "منوی برنامه", exact: true })
  ).toBeFocused();
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      )
    )
    .toBe(true);
});

test("map selection stays usable when the visual tile service fails", async ({
  page,
}) => {
  const state = await mock(page);
  await page.route(/https:\/\/tiles\.openfreemap\.org\//, (route) =>
    route.abort()
  );
  await page.goto("/");
  await openMenuItem(page, "مدیریت موقعیت‌ها");
  await page.getByRole("button", { name: "ویرایش خانه" }).click();
  const dialog = page.getByRole("dialog", { name: "ویرایش مکان", exact: true });
  await expect(dialog.locator(".maplibre-map")).toBeVisible();
  await expect(
    dialog.getByText("نمایش نقشه موقتاً در دسترس نیست", { exact: false })
  ).toBeVisible();
  await dialog.locator(".maplibre-map").click({ position: { x: 100, y: 100 } });
  await dialog.getByRole("button", { name: "ذخیره مکان" }).click();
  await expect(dialog).toHaveCount(0);
  expect(state.locations[0]?.latitude).not.toBe(home.latitude);
});

test("enabled Digikala loads and displays saved deals on the initial live list", async ({
  page,
}) => {
  test.skip(
    process.env.NEXT_PUBLIC_DIGIKALA_SUPERMARKET_ENABLED !== "true",
    "This scenario requires a build with Digikala enabled."
  );
  await mock(page, {
    scans: [run({ source: "digikalajet" })],
    groups: [group("Digikala regression product")],
  });
  const read = page.waitForRequest(
    (request) =>
      new URL(request.url()).pathname === "/api/scans/saved/products",
    { timeout: 10000 }
  );
  await page.goto("/");
  await read;
  await expect(
    page.getByRole("heading", {
      name: "Digikala regression product",
      exact: true,
    })
  ).toBeVisible();
});

test("infinite live feed loads every provider and shows the server total", async ({
  page,
}) => {
  test.skip(
    process.env.NEXT_PUBLIC_DIGIKALA_SUPERMARKET_ENABLED !== "true",
    "Requires Digikala build"
  );
  const sources = ["snappmarket", "okala", "digikalajet"] as const;
  await mock(page, {
    scans: sources.map((source) => run({ id: source, source })),
  });
  await page.route("**/api/scans/*/products*", async (route) => {
    const url = new URL(route.request().url());
    const id = url.pathname.split("/")[3]!;
    const second = url.searchParams.has("cursor");
    if (url.searchParams.get("q") === "remote") {
      await route.fulfill({
        json: {
          data: {
            ...products([group(`${id} remote result`, id)]),
            totalCount: 1,
            nextCursor: null,
          },
        },
      });
      return;
    }
    await route.fulfill({
      json: {
        data: {
          ...products([group(`${id} item ${second ? 2 : 1}`, id)]),
          totalCount: 2,
          nextCursor: second ? null : "second",
        },
      },
    });
  });
  await page.goto("/");
  await page.locator(".feed-load-sentinel").scrollIntoViewIfNeeded();
  for (const source of sources)
    await expect(
      page.getByRole("heading", { name: `${source} item 2`, exact: true })
    ).toBeVisible();
  await expect(page.getByText("۶ محصول", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "تازه‌سازی نتیجه", exact: true })
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /نمایش محصولات بیشتر/ })
  ).toHaveCount(0);
  await page
    .getByRole("searchbox", { name: "جست‌وجوی کالا یا فروشگاه" })
    .fill("remote");
  for (const source of sources)
    await expect(
      page.getByRole("heading", {
        name: `${source} remote result`,
        exact: true,
      })
    ).toBeVisible();
  await expect(page.getByText("۳ محصول", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: /item 2/ })).toHaveCount(0);
});

test("shopping workspace has right sidebar and compact result toolbar", async ({
  page,
}, info) => {
  await mock(page, { scans: [run()], groups: representative });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "پیشنهادهای امروز", exact: true })
  ).toBeVisible();
  await expect(page.locator('input[type="range"]')).toHaveCount(0);
  await page.getByRole("button", { name: "جزئیات نتیجه", exact: true }).click();
  const details = page.getByRole("dialog", {
    name: "جزئیات نتیجه",
    exact: true,
  });
  await expect(details).toBeVisible();
  await expect(
    details.getByText("فروشگاه بررسی‌شده", { exact: true })
  ).toBeVisible();
  await captureState(page, "result-details-modal", false);
  await page.keyboard.press("Escape");
  await expect(details).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "جزئیات نتیجه", exact: true })
  ).toBeFocused();
  const filter = page.locator(".compact-results-toolbar");
  const discount = filter.getByRole("button", { name: "حداقل تخفیف نتیجه‌ها" });
  await discount.click();
  const presets = page.getByRole("group", { name: "تخفیف‌های پیشنهادی" });
  await expect(presets.getByRole("button")).toHaveCount(7);
  await presets.getByRole("button", { name: "۵۰٪", exact: true }).click();
  await expect(discount).toContainText("۵۰٪");
  await discount.click();
  const custom = page.getByRole("spinbutton", { name: "درصد تخفیف دلخواه" });
  await expect(page.locator(".discount-select-menu")).not.toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)"
  );
  await page
    .getByRole("button", { name: "افزایش درصد تخفیف", exact: true })
    .click();
  await expect(custom).toHaveValue("51");
  await page
    .getByRole("button", { name: "کاهش درصد تخفیف", exact: true })
    .click();
  await expect(custom).toHaveValue("50");
  await captureState(page, "discount-picker-surface", false);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator(".discount-select-menu")).toHaveCSS(
    "background-color",
    "rgb(32, 37, 45)"
  );
  await captureState(page, "discount-picker-dark", false);
  await page.emulateMedia({ colorScheme: "light" });
  await custom.fill("35");
  await expect(discount).toContainText("۳۵٪");
  await custom.press("ArrowUp");
  await expect(custom).toHaveValue("36");
  await expect(discount).toContainText("۳۶٪");
  await custom.fill("90");
  await custom.press("Tab");
  await expect(custom).toHaveValue("80");
  await page.keyboard.press("Escape");
  await discount.click();
  await custom.fill("35");
  await page.keyboard.press("Escape");
  await expect(page.locator(".personalized-note, .result-count")).toHaveCount(
    0
  );
  const toolbar = await filter.boundingBox();
  expect(toolbar?.height).toBeLessThan(
    info.project.name === "desktop" ? 60 : 110
  );
  if (info.project.name === "desktop") {
    const header = await page.locator(".app-header").boundingBox();
    const content = await page.locator(".workspace").boundingBox();
    expect(header).not.toBeNull();
    expect(content).not.toBeNull();
    if (header && content) {
      expect(header.x).toBeGreaterThan(content.x);
      expect(header.width).toBeLessThan(250);
      expect(content.x + content.width).toBeLessThanOrEqual(header.x + 1);
    }
    await expect(
      page
        .locator(".desktop-primary-nav")
        .getByRole("button", { name: "اسکن تخفیف‌ها", exact: true })
    ).toBeVisible();
  } else {
    await page
      .getByRole("button", { name: "منوی برنامه", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("button", { name: "بستن منو", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }
  if (info.project.name === "desktop") {
    const active = page.locator(
      '.desktop-primary-nav button[data-active="true"]'
    );
    await expect(active).toHaveCount(1);
    expect(await active.evaluate((el) => getComputedStyle(el).boxShadow)).toBe(
      "none"
    );
    const appearance = page.locator(".sidebar-footer .appearance-switch");
    await appearance.getByRole("button", { name: "تیره", exact: true }).click();
    await expect(
      appearance.getByRole("button", { name: "تیره", exact: true })
    ).toHaveAttribute("aria-pressed", "true");
    const footer = await page.locator(".sidebar-footer").boundingBox();
    expect(footer).not.toBeNull();
    if (footer) {
      expect(footer.y + footer.height).toBeGreaterThan(650);
      expect(footer.y + footer.height).toBeLessThanOrEqual(720);
    }
    await page.locator(".header-actions .cart-trigger").click();
    await expect(
      page.locator('.desktop-primary-nav button[data-active="true"]')
    ).toHaveCount(0);
    await page.getByRole("button", { name: "بستن سبد", exact: true }).click();
    await expect(active).toHaveCount(1);
    const basket = await page
      .locator(".header-actions .cart-trigger")
      .boundingBox();
    const utilities = await page.locator(".sidebar-utilities").boundingBox();
    if (basket && utilities)
      expect(utilities.y - (basket.y + basket.height)).toBeLessThan(70);
  }
  await captureState(page, "shopping-sidebar-refresh", false);
  await page.emulateMedia({ colorScheme: "dark" });
  await captureState(page, "shopping-sidebar-dark", false);
  const overflowing = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth
  );
  expect(overflowing).toBe(false);
  await page
    .getByRole("button", { name: "اسکن تخفیف‌ها", exact: true })
    .last()
    .click();
  await expect(
    page.getByRole("heading", { name: "اسکن تخفیف‌ها", exact: true })
  ).toBeVisible();
  await expect(page.locator('input[type="range"]')).toHaveCount(0);
});

test("temporary history failure recovers automatically and unblocks scanning", async ({
  page,
}) => {
  await mock(page);
  let attempts = 0;
  await page.route("**/api/scans", (r) => {
    attempts++;
    return attempts <= 3
      ? r.fulfill({ status: 503, json: { error: "RESULT_READ_ERROR" } })
      : r.fulfill({ json: { data: [] } });
  });
  await page.goto("/");
  const scan = page
    .getByRole("button", { name: "اسکن تخفیف‌ها", exact: true })
    .last();
  await scan.click();
  await expect(
    page.getByRole("button", { name: "شروع اسکن", exact: true })
  ).toBeDisabled();
  await expect(
    page.getByText("تاریخچه اسکن دریافت نشد", { exact: true })
  ).toBeVisible({ timeout: 10000 });
  await expect(
    page.getByText("دریافت اطلاعات ناموفق بود؛ دوباره تلاش کنید.", {
      exact: false,
    })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "شروع اسکن", exact: true })
  ).toBeEnabled({ timeout: 25000 });
  await expect(
    page.getByText("تاریخچه اسکن دریافت نشد", { exact: true })
  ).toHaveCount(0);
  expect(attempts).toBeGreaterThanOrEqual(4);
});

test("Fresh DigiKala history does not block scan setup", async ({ page }) => {
  const fresh = run({ source: "digikalajet", status: "cancelled" });
  const context = {
    location: {
      name: home.name,
      latitude: home.latitude,
      longitude: home.longitude,
      revision: 1,
    },
    requestedThreshold: 15,
    effectiveThreshold: 15,
    policyVersion: "grocery-consumables-v1",
    manifest: {
      adapter: "digikala-fresh-supermarket",
      contractVersion: 1,
      feedKinds: ["fresh_campaign_carousels"],
      digikalaFeeds: [{ id: "heavy_discount", kind: "carousel" }],
      digikala: {
        surface: "fresh_supermarket",
        channel: "sd",
        shipmentType: "scheduled",
        shopId: "shop",
        coordinatesHash: "hash",
        categoryPolicy: "grocery-consumables-v1",
      },
    },
    scopeHash: "hash",
    eligibilityVersion: 1,
    offerKeyVersion: 1,
    coverage: "incomplete",
  };
  await mock(page);
  await page.route("**/api/scans", (r) =>
    r.fulfill({ json: { data: [{ ...fresh, context }] } })
  );
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "پیشنهادهای امروز", exact: true })
  ).toBeVisible();
  await page
    .getByRole("button", { name: "اسکن تخفیف‌ها", exact: true })
    .last()
    .click();
  await expect(
    page.getByRole("button", { name: "شروع اسکن", exact: true })
  ).toBeEnabled();
  await expect(
    page.getByText("تاریخچه اسکن دریافت نشد", { exact: true })
  ).toHaveCount(0);
});
