import { expect, test, type Page } from "@playwright/test";
import type { LocationRecord, ScanRecord } from "@better-buy/shared";

const key = "better-buy.guest-locations.v1";
const at = "2026-11-15T00:00:00Z";
const home: LocationRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "خانه مهمان",
  latitude: 35.7,
  longitude: 51.4,
  isDefault: true,
  coordinateRevision: 1,
  createdAt: at,
  updatedAt: at,
};

async function setup(page: Page) {
  const state = {
    signedIn: false,
    guestLocations: [] as LocationRecord[],
    memberLocations: [] as LocationRecord[],
    scans: [] as ScanRecord[],
    starts: 0,
    imports: 0,
    failImport: false,
    protectedRequests: [] as string[],
  };
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname === "/api/auth/get-session")
      return route.fulfill({
        json: state.signedIn
          ? {
              user: { id: "member", name: "Member" },
              session: { id: "session", userId: "member" },
            }
          : null,
      });
    if (url.pathname === "/api/auth/sign-in/phone") {
      state.signedIn = true;
      return route.fulfill({
        json: { user: { id: "member", name: "Member" } },
      });
    }
    if (url.pathname === "/api/analytics/events")
      return route.fulfill({ status: 204 });
    if (url.pathname === "/api/guest/session")
      return route.fulfill({ json: { data: { id: "guest:fixture" } } });
    if (url.pathname === "/api/locations/import") {
      state.imports++;
      if (state.failImport)
        return route.fulfill({
          status: 503,
          json: { error: "LOCATION_WRITE_ERROR" },
        });
      const input = route.request().postDataJSON();
      if (
        !state.memberLocations.some(
          (item) =>
            item.latitude === input.latitude &&
            item.longitude === input.longitude
        )
      )
        state.memberLocations.push({
          ...home,
          ...input,
          id: "22222222-2222-4222-8222-222222222222",
        });
      return route.fulfill({ json: { data: state.memberLocations[0] } });
    }
    if (url.pathname === "/api/locations") {
      const locations = state.signedIn
        ? state.memberLocations
        : state.guestLocations;
      if (method === "POST") {
        const saved = { ...home, ...route.request().postDataJSON() };
        locations.push(saved);
        return route.fulfill({ status: 201, json: { data: saved } });
      }
      return route.fulfill({ json: { data: locations } });
    }
    if (url.pathname === "/api/scans") {
      if (method === "POST") {
        state.starts++;
        const input = route.request().postDataJSON();
        const scan: ScanRecord = {
          ...input,
          id: "scan-" + input.source,
          locationName: home.name,
          status: "queued",
          createdAt: at,
          startedAt: null,
          finishedAt: null,
          vendorCount: 0,
          productCount: 0,
          dealCount: 0,
          errorCode: null,
          errorMessage: null,
        };
        state.scans.push(scan);
        return route.fulfill({ status: 202, json: { data: scan } });
      }
      return route.fulfill({
        json: { data: state.signedIn ? [] : state.scans },
      });
    }
    if (url.pathname.startsWith("/api/scans/"))
      return route.fulfill({
        json: {
          data: state.scans.find(
            (scan) => scan.id === url.pathname.split("/").at(-1)
          ),
        },
      });
    if (
      !state.signedIn &&
      /^\/api\/(wishlist|notifications|carts|admin)/.test(url.pathname)
    )
      state.protectedRequests.push(url.pathname);
    if (url.pathname === "/api/admin/access")
      return route.fulfill({ json: { data: { allowed: false } } });
    return route.fulfill({ json: { data: [] } });
  });
  return state;
}

async function signIn(page: Page) {
  await page
    .locator(".guest-banner")
    .getByRole("button", { name: "ورود یا ثبت‌نام" })
    .click();
  await page.getByLabel("شماره همراه").fill("09123456789");
  await page.getByLabel("رمز عبور", { exact: true }).fill("a long passphrase");
  await page.getByRole("button", { name: "ورود", exact: true }).click();
}

test("guest bootstrap failure offers recovery instead of forcing login", async ({
  page,
}) => {
  await setup(page);
  let fail = true;
  await page.route("**/api/guest/session", async (route) => {
    if (fail)
      return route.fulfill({
        status: 503,
        json: { error: "GUEST_SESSION_ERROR" },
      });
    return route.fallback();
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "حالت مهمان آماده نشد" })
  ).toBeVisible();
  fail = false;
  await page.getByRole("button", { name: "تلاش دوباره", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "افزودن موقعیت تحویل", exact: true })
  ).toBeVisible();
});

test("blocked browser storage still allows guest exploration", async ({
  page,
}) => {
  const state = await setup(page);
  state.guestLocations = [home];
  await page.addInitScript(() =>
    Object.defineProperty(window, "localStorage", {
      get: () => {
        throw new Error("blocked");
      },
    })
  );
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "پیشنهادهای امروز", exact: true })
  ).toBeVisible();
  await expect(page.locator(".guest-toast")).toContainText("مرورگر اجازه");
  expect(state.protectedRequests).toEqual([]);
});

test("guest notification deep links explain sign-in without fetching private data", async ({
  page,
}) => {
  const state = await setup(page);
  await page.goto("/?page=notifications");
  await expect(
    page.getByRole("heading", {
      name: "اعلان‌ها برای حساب شما نگهداری می‌شوند",
    })
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "ورود یا ثبت‌نام" })
  ).toBeVisible();
  expect(state.protectedRequests).toEqual([]);
});

test("guests explore, restore browser location, scan and get account prompts without private requests", async ({
  page,
}) => {
  const state = await setup(page);
  await page.addInitScript(
    ({ key, home }) => localStorage.setItem(key, JSON.stringify([home])),
    { key, home }
  );
  await page.goto("/");
  await expect(page.locator(".guest-banner")).toBeVisible();
  await expect(page.locator(".guest-banner")).toContainText(
    "تخفیف‌های دلخواهتان را از دست ندهید"
  );
  await expect(page.locator(".guest-banner")).toContainText(
    "سبد خریدتان را برای بعد نگه دارید"
  );
  await expect(page.locator(".guest-banner")).not.toContainText(
    /مرورگر|۲۴ ساعت/
  );
  await expect(
    page.getByRole("heading", { name: "پیشنهادهای امروز", exact: true })
  ).toBeVisible();
  expect(state.guestLocations).toHaveLength(1);
  await page
    .getByRole("button", { name: "علاقه‌مندی‌ها", exact: true })
    .last()
    .click();
  await expect(page.locator(".guest-toast")).toContainText("وارد حساب");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "بستن پیام" }).click();
  await page
    .getByRole("button", { name: "اسکن تخفیف‌ها", exact: true })
    .last()
    .click();
  await page.getByRole("button", { name: "شروع اسکن", exact: true }).click();
  await expect(page.locator(".scan-stage-running")).toBeVisible();
  await expect(page.locator(".guest-toast")).toContainText("اسکن مهمان");
  expect(state.starts).toBe(2);
  expect(state.protectedRequests).toEqual([]);
  expect(
    await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key) ?? "[]").length,
      key
    )
  ).toBe(1);
  await page.screenshot({
    path: `../../.data/design-evidence/guest-scan-${test.info().project.name}.png`,
    fullPage: true,
  });
});

test("guest location survives refresh and imports once after login", async ({
  page,
}) => {
  const state = await setup(page);
  await page.goto("/");
  await page
    .getByRole("button", { name: "افزودن موقعیت تحویل", exact: true })
    .click();
  await page.getByLabel("نام مکان", { exact: true }).fill(home.name);
  await page.getByRole("button", { name: "ذخیره مکان", exact: true }).click();
  await expect.poll(() => state.guestLocations.length).toBe(1);
  await expect
    .poll(() =>
      page.evaluate(
        (key) => JSON.parse(localStorage.getItem(key) ?? "[]").length,
        key
      )
    )
    .toBe(1);
  await page.reload();
  await expect(page.locator(".guest-banner")).toBeVisible();
  expect(state.guestLocations).toHaveLength(1);
  await signIn(page);
  await expect(page.locator(".guest-banner")).toHaveCount(0);
  await expect.poll(() => state.memberLocations.length).toBe(1);
  await expect
    .poll(() =>
      page.evaluate(
        (key) => JSON.parse(localStorage.getItem(key) ?? "[]").length,
        key
      )
    )
    .toBe(0);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "پیشنهادهای امروز", exact: true })
  ).toBeVisible();
  expect(state.imports).toBe(1);
});

test("failed location import keeps the browser copy and supports retry", async ({
  page,
}) => {
  const state = await setup(page);
  state.guestLocations = [home];
  state.failImport = true;
  await page.goto("/");
  await expect(page.locator(".guest-banner")).toBeVisible();
  await signIn(page);
  await expect(page.locator(".guest-import-notice")).toBeVisible();
  expect(
    await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key) ?? "[]").length,
      key
    )
  ).toBe(1);
  state.failImport = false;
  await page
    .locator(".guest-import-notice")
    .getByRole("button", { name: "تلاش دوباره" })
    .click();
  await expect(page.locator(".guest-import-notice")).toHaveCount(0);
  await expect.poll(() => state.memberLocations.length).toBe(1);
  expect(
    await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key) ?? "[]").length,
      key
    )
  ).toBe(0);
});
