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
    if (url.pathname.startsWith("/api/locations/")) {
      const id = url.pathname.split("/").at(-1);
      const locations = state.signedIn
        ? state.memberLocations
        : state.guestLocations;
      if (method === "DELETE") {
        const index = locations.findIndex((location) => location.id === id);
        if (index >= 0) locations.splice(index, 1);
        return route.fulfill({ status: 204 });
      }
      if (method === "PATCH") {
        const location = locations.find((location) => location.id === id);
        Object.assign(location!, route.request().postDataJSON());
        return route.fulfill({ json: { data: location } });
      }
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

test("location editor handles long addresses and saves the current-location choice", async ({
  page,
}) => {
  const state = await setup(page);
  const address =
    "بزرگراه بسیج، افسریه شمالی، ناحیه ۵، منطقه ۱۵ شهر تهران، تهران، تهران، بخش مرکزی تهران";
  await page.route("https://photon.komoot.io/api/**", (route) =>
    route.fulfill({
      json: {
        features: [
          {
            properties: { name: address },
            geometry: { coordinates: [51.4, 35.7] },
          },
          {
            properties: {
              name: "بزرگراه بسیج، قصر فیروزه، منطقه ۱۴ شهر تهران، تهران",
            },
            geometry: { coordinates: [51.41, 35.71] },
          },
        ],
      },
    })
  );
  await page.goto("/");
  await page
    .getByRole("button", { name: "افزودن موقعیت تحویل", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "انتخاب آدرس",
    exact: true,
  });
  const back = dialog
    .locator("header")
    .getByRole("button", { name: "بازگشت به موقعیت‌ها" });
  await expect(back).toBeVisible();
  const backBox = await back.boundingBox();
  expect(backBox?.width).toBe(44);
  expect(backBox?.height).toBe(44);
  await expect(back).toHaveCSS("border-top-width", "1px");
  const normalBackground = await back.evaluate(
    (element) => getComputedStyle(element).backgroundColor
  );
  await back.hover();
  await expect
    .poll(() =>
      back.evaluate((element) => getComputedStyle(element).backgroundColor)
    )
    .not.toBe(normalBackground);
  await expect(dialog.getByLabel("نام مکان")).toHaveCount(0);
  const workspace = await dialog
    .locator(".location-map-workspace")
    .boundingBox();
  const canvas = await dialog.locator(".maplibre-map").boundingBox();
  expect(
    Math.abs((workspace?.height ?? 0) - (canvas?.height ?? 0))
  ).toBeLessThan(2);
  if (test.info().project.name === "mobile") {
    const bounds = await dialog.boundingBox();
    expect(
      Math.abs(
        (bounds?.y ?? 0) + (bounds?.height ?? 0) - page.viewportSize()!.height
      )
    ).toBeLessThan(2);
    await expect(dialog).toHaveCSS("transform", "none");
  }
  await dialog.getByLabel("جست‌وجوی نشانی در تهران").fill("افسریه");
  await expect(
    dialog.getByRole("button", { name: "جست‌وجو", exact: true })
  ).toHaveCount(0);
  await expect(dialog.locator("details.location-map-section")).toHaveCount(0);
  const result = dialog.getByRole("button", { name: address, exact: true });
  expect(
    await result.evaluate(
      (element) => element.scrollWidth <= element.clientWidth
    )
  ).toBe(true);
  await result.click();
  await expect(result).toHaveCount(0);
  await dialog.screenshot({
    path: `../../.data/design-evidence/address-map-${test.info().project.name}.png`,
  });
  await dialog
    .getByRole("button", { name: "تأیید موقعیت", exact: true })
    .click();
  const details = page.getByRole("dialog", {
    name: "جزئیات آدرس",
    exact: true,
  });
  await details.getByLabel("نام مکان").fill("خانه تازه");
  await details.getByRole("button", { name: "تغییر موقعیت روی نقشه" }).click();
  await page.getByRole("button", { name: "تأیید موقعیت", exact: true }).click();
  await expect(details.getByLabel("نام مکان")).toHaveValue("خانه تازه");
  await expect(details.locator(".location-map")).toHaveAttribute(
    "data-map-ready",
    "true",
    { timeout: 30000 }
  );
  const checkbox = details.getByRole("checkbox", {
    name: "موقعیت کنونی من",
    exact: true,
  });
  await details.locator('label[for="default-location"]').click();
  await expect(checkbox).toBeChecked();
  await checkbox.focus();
  await page.keyboard.press("Space");
  await expect(checkbox).not.toBeChecked();
  await page.keyboard.press("Space");
  await expect(checkbox).toBeChecked();
  const box = await checkbox.boundingBox();
  expect(box?.width).toBe(20);
  expect(box?.height).toBe(20);
  await details.screenshot({
    path: `../../.data/design-evidence/location-editor-${test.info().project.name}.png`,
  });
  await details.evaluate((element) => {
    element.scrollTop = 0;
  });
  await details.screenshot({
    path: `../../.data/design-evidence/location-editor-search-${test.info().project.name}.png`,
  });
  await details
    .getByRole("button", { name: "ذخیره مکان", exact: true })
    .click();
  await expect(details).toHaveCount(0);
  expect(state.guestLocations[0]).toMatchObject({
    name: "خانه تازه",
    latitude: 35.7,
    longitude: 51.4,
    isDefault: true,
  });
});

test("map flow supports browser location and panning the fixed pin", async ({
  page,
  context,
}) => {
  const state = await setup(page);
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ latitude: 35.76, longitude: 51.42 });
  await page.goto("/");
  await page
    .getByRole("button", { name: "افزودن موقعیت تحویل", exact: true })
    .click();
  await page.getByRole("button", { name: "موقعیت من", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "موقعیت من", exact: true })
  ).toBeEnabled();
  const map = page.locator(".location-map-workspace .maplibre-map");
  const bounds = (await map.boundingBox())!;
  await page.mouse.move(
    bounds.x + bounds.width * 0.75,
    bounds.y + bounds.height * 0.7
  );
  await page.mouse.down();
  await page.mouse.move(
    bounds.x + bounds.width * 0.5,
    bounds.y + bounds.height * 0.6,
    { steps: 15 }
  );
  await page.mouse.up();
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: "تأیید موقعیت", exact: true }).click();
  await page.getByLabel("نام مکان").fill("موقعیت جدید");
  await page.getByRole("button", { name: "ذخیره مکان", exact: true }).click();
  await expect.poll(() => state.guestLocations.length).toBe(1);
  expect(state.guestLocations[0].latitude).not.toBe(35.76);
  expect(state.guestLocations[0].longitude).not.toBe(51.42);
  expect(state.guestLocations[0].latitude).not.toBe(35.7);
});

test("saved locations resolve map addresses and restore cached addresses after refresh", async ({
  page,
}) => {
  const state = await setup(page);
  state.guestLocations = [home];
  let lookups = 0;
  await page.route("https://photon.komoot.io/reverse?**", async (route) => {
    lookups++;
    const url = new URL(route.request().url());
    expect(url.searchParams.get("lat")).toBe(String(home.latitude));
    expect(url.searchParams.get("lon")).toBe(String(home.longitude));
    expect(url.searchParams.get("lang")).toBe("default");
    await route.fulfill({
      json: {
        features: [
          {
            properties: {
              city: "تهران",
              district: "قائم چیتگر",
              street: "بلوار دهیمر",
              housenumber: "۱۲",
            },
          },
        ],
      },
    });
  });
  await page.goto("/");
  await page.locator(".shopping-location").click();
  const row = page.getByRole("button", {
    name: "انتخاب " + home.name,
    exact: true,
  });
  await expect(row).toContainText("تهران، قائم چیتگر، بلوار دهیمر، ۱۲");
  await expect(row).toHaveCSS("justify-content", "space-between");
  await expect(row.locator("small")).toHaveCSS("text-align", "start");
  expect(
    await row.evaluate((element) => element.scrollWidth <= element.clientWidth)
  ).toBe(true);
  const textBounds = (await row.locator("small").boundingBox())!;
  const editBounds = (await page
    .getByRole("button", { name: "ویرایش " + home.name, exact: true })
    .boundingBox())!;
  expect(textBounds.x).toBeGreaterThanOrEqual(editBounds.x + editBounds.width);
  await page.getByRole("dialog").screenshot({
    path: `../../.data/design-evidence/address-list-${test.info().project.name}.png`,
  });
  await page.reload();
  await page.locator(".shopping-location").click();
  await expect(row).toContainText("تهران، قائم چیتگر، بلوار دهیمر، ۱۲");
  expect(lookups).toBe(1);
});

test("saved address list edits details, cancels deletion and confirms deletion", async ({
  page,
}) => {
  const state = await setup(page);
  state.guestLocations = [home];
  await page.goto("/");
  await page.locator(".shopping-location").click();
  const list = page.getByRole("dialog", {
    name: "موقعیت‌های تحویل",
    exact: true,
  });
  await expect(
    list.getByRole("button", { name: "انتخاب " + home.name })
  ).toBeVisible();
  await list.getByRole("button", { name: "ویرایش " + home.name }).click();
  const details = page.getByRole("dialog", {
    name: "جزئیات آدرس",
    exact: true,
  });
  await expect(details.getByLabel("نام مکان")).toHaveValue(home.name);
  await expect(details.getByLabel("جست‌وجوی نشانی در تهران")).toHaveCount(0);
  await details.getByLabel("نام مکان").fill("خانه ویرایش‌شده");
  await details
    .getByRole("button", { name: "ذخیره مکان", exact: true })
    .click();
  await expect(list).toBeVisible();
  await list.getByRole("button", { name: "حذف خانه ویرایش‌شده" }).click();
  const confirmation = page.getByRole("alertdialog");
  await confirmation.getByRole("button", { name: "انصراف" }).click();
  expect(state.guestLocations).toHaveLength(1);
  await list.getByRole("button", { name: "حذف خانه ویرایش‌شده" }).click();
  await confirmation.getByRole("button", { name: "حذف همیشگی" }).click();
  await expect.poll(() => state.guestLocations.length).toBe(0);
  await expect(confirmation).toHaveCount(0);
  await expect(list).toBeVisible();
});

test("address autocomplete debounces, requires three characters, and cancels stale requests", async ({
  page,
}) => {
  await setup(page);
  const requests: { query: string; at: number }[] = [];
  const aborted: string[] = [];
  page.on("requestfailed", (request) => {
    if (request.url().includes("photon.komoot.io"))
      aborted.push(new URL(request.url()).searchParams.get("q") ?? "");
  });
  await page.route("https://photon.komoot.io/api/**", async (route) => {
    const query = new URL(route.request().url()).searchParams.get("q") ?? "";
    requests.push({ query, at: Date.now() });
    if (query === "ونک")
      await new Promise((resolve) => setTimeout(resolve, 1800));
    await route
      .fulfill({
        json: {
          features: [
            {
              properties: { name: query },
              geometry: { coordinates: [51.4, 35.7] },
            },
          ],
        },
      })
      .catch(() => {});
  });
  await page.goto("/");
  await page
    .getByRole("button", { name: "افزودن موقعیت تحویل", exact: true })
    .click();
  const input = page.getByLabel("جست‌وجوی نشانی در تهران");
  await input.fill("ون");
  await page.waitForTimeout(600);
  expect(requests).toHaveLength(0);
  await input.fill("ونکا");
  await page.waitForTimeout(250);
  await input.fill("ونک");
  await page.waitForTimeout(250);
  expect(requests).toHaveLength(0);
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].query).toBe("ونک");
  await input.fill("تجریش");
  await expect.poll(() => aborted).toContain("ونک");
  await expect(
    page.getByRole("button", { name: "تجریش", exact: true })
  ).toBeVisible();
  expect(requests[1].at - requests[0].at).toBeGreaterThanOrEqual(500);
  await expect(
    page.getByRole("button", { name: "ونک", exact: true })
  ).toHaveCount(0);
  await input.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("location map uses matching themes and keeps the canvas when appearance changes", async ({
  page,
}) => {
  test.setTimeout(90000);
  await setup(page);
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  await page
    .getByRole("button", { name: "افزودن موقعیت تحویل", exact: true })
    .click();
  const map = page.getByRole("region", { name: "نقشه انتخاب موقعیت در تهران" });
  await expect(map).toHaveAttribute("data-map-theme", "light");
  await expect(map).toHaveAttribute("data-map-ready", "true", {
    timeout: 60000,
  });
  await expect(map.locator(".location-map-status")).not.toHaveClass(
    /is-warning/
  );
  const canvas = await map.locator("canvas").elementHandle();
  await map.screenshot({
    path: `../../.data/design-evidence/map-light-${test.info().project.name}.png`,
  });
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(map).toHaveAttribute("data-map-theme", "dark");
  await expect(map).toHaveAttribute("data-map-ready", "true", {
    timeout: 30000,
  });
  expect(await canvas?.evaluate((element) => element.isConnected)).toBe(true);
  await expect(map.locator(".location-fixed-pin")).toBeVisible();
  await map.screenshot({
    path: `../../.data/design-evidence/map-dark-${test.info().project.name}.png`,
  });
  const requests = await page.evaluate(() =>
    performance.getEntriesByType("resource").map((entry) => entry.name)
  );
  expect(
    requests.filter((url) => url.includes("openfreemap.org/styles/"))
  ).toEqual([]);
  expect(
    requests.filter(
      (url) => url.includes("openfreemap.org") && url.includes("sprite")
    )
  ).toEqual([]);
});

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

test("guests restore browser location and start manual scans without private requests", async ({
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
    "علاقه‌مندی‌ها، اعلان تخفیف"
  );
  await expect(page.locator(".guest-banner")).not.toContainText(
    /مرورگر|۲۴ ساعت/
  );
  await expect(page.locator(".scan-page")).toBeVisible();
  expect(state.guestLocations).toHaveLength(1);
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
  await page.getByRole("button", { name: "تأیید موقعیت", exact: true }).click();
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

function tutorialRun(finishedAt: string): ScanRecord {
  return {
    id: "tutorial-scan",
    locationId: home.id,
    locationName: home.name,
    source: "snappmarket",
    threshold: 15,
    mode: "partial",
    status: "succeeded",
    createdAt: finishedAt,
    startedAt: finishedAt,
    finishedAt,
    vendorCount: 1,
    productCount: 1,
    dealCount: 1,
    errorCode: null,
    errorMessage: null,
    context: {
      location: {
        name: home.name,
        latitude: home.latitude,
        longitude: home.longitude,
        revision: 1,
      },
      requestedThreshold: 15,
      effectiveThreshold: 15,
      policyVersion: "automatic-v1",
      manifest: {
        adapter: "snappmarket",
        contractVersion: 1,
        feedKinds: ["promotion"],
      },
      scopeHash: "tutorial",
      eligibilityVersion: 1,
      offerKeyVersion: 1,
      coverage: "complete",
    },
  };
}

test("interactive guide waits for location save and explicit scan then finishes at results", async ({
  page,
}) => {
  const state = await setup(page);
  let failSave = true;
  await page.route("**/api/locations", async (route) => {
    if (route.request().method() !== "POST" || !failSave)
      return route.fallback();
    return route.fulfill({ status: 400, json: { error: "INVALID_INPUT" } });
  });
  let completed = false;
  await page.route("**/api/scans/scan-*", async (route) => {
    const run = state.scans.find(
      (scan) =>
        scan.id === new URL(route.request().url()).pathname.split("/").at(-1)
    );
    if (!run) return route.fallback();
    const updated = completed
      ? {
          ...run,
          ...tutorialRun(new Date().toISOString()),
          id: run.id,
          source: run.source,
        }
      : run;
    Object.assign(run, updated);
    return route.fulfill({ json: { data: updated } });
  });
  const offer = {
    offerKey: "milk",
    productVariationId: "milk",
    vendorId: "store",
    vendorTitle: "فروشگاه",
    vendorCode: null,
    priceRials: 100000,
    discountRials: 50000,
    finalPriceRials: 50000,
    discountRatio: 50,
    stock: 5,
    state: "current",
  };
  await page.route("**/api/scans/*/products?*", (route) =>
    route.fulfill({
      json: {
        data: {
          totalCount: 1,
          observedAt: new Date().toISOString(),
          coverageSummary: "complete",
          baseline: { scanId: null, reason: "first_snapshot" },
          nextCursor: null,
          items: [
            {
              key: "milk",
              scanId: "scan-snappmarket",
              groupKeyVersion: 2,
              title: "شیر",
              image: null,
              categoryTitle: "لبنیات",
              priceRials: 100000,
              discountRials: 50000,
              finalPriceRials: 50000,
              discountRatio: 50,
              state: "current",
              bestCurrentOffer: offer,
              currentStoreOfferCount: 1,
              conditionalOfferCount: 0,
              diagnostics: [],
              wishlistMatch: false,
              cartQuantity: 0,
            },
          ],
        },
      },
    })
  );
  await page.goto("/");
  await expect(page.locator('[data-tutorial-step="location"]')).toBeVisible();
  await expect(page.locator(".tutorial-spotlight")).toHaveCSS(
    "backdrop-filter",
    "blur(5px)"
  );
  await expect(page.locator(".tutorial-spotlight")).toHaveCSS(
    "mask-image",
    /data:image\/svg/
  );
  await page
    .getByRole("button", { name: "افزودن موقعیت تحویل", exact: true })
    .click();
  await expect(page.locator('[data-tutorial-step="map"]')).toBeVisible();
  await page.getByRole("button", { name: "مرحله قبلی", exact: true }).click();
  await expect(page.locator('[data-tutorial-step="location"]')).toBeVisible();
  await page.getByRole("button", { name: "مرحله بعدی", exact: true }).click();
  await expect(page.locator('[data-tutorial-step="map"]')).toBeVisible();

  await page.screenshot({
    path: `../../.data/design-evidence/tutorial-map-${test.info().project.name}.png`,
    fullPage: true,
  });
  await page.getByRole("button", { name: "تأیید موقعیت", exact: true }).click();
  await expect(page.locator('[data-tutorial-step="details"]')).toBeVisible();
  await page.getByLabel("نام مکان").fill("خانه مهمان");
  await page.getByRole("button", { name: "ذخیره مکان", exact: true }).click();
  await expect(page.locator(".location-editor [role=alert]")).toBeVisible();
  await expect(page.locator('[data-tutorial-step="details"]')).toBeVisible();
  expect(state.starts).toBe(0);
  failSave = false;
  await page.getByRole("button", { name: "ذخیره مکان", exact: true }).click();
  await expect(page.locator('[data-tutorial-step="scan"]')).toBeVisible();
  await page.screenshot({
    path: `../../.data/design-evidence/tutorial-scan-${test.info().project.name}.png`,
    fullPage: true,
  });
  expect(state.starts).toBe(0);
  const providerCount = await page
    .locator(".provider-checklist input:checked")
    .count();
  await page.getByRole("button", { name: "شروع اسکن", exact: true }).click();
  await expect(page.locator('[data-tutorial-step="waiting"]')).toBeVisible();
  await expect.poll(() => state.starts).toBe(providerCount);
  await expect(
    page.getByRole("button", { name: "مشاهده نتایج", exact: true })
  ).toHaveCount(0);
  completed = true;
  await expect(page.locator('[data-tutorial-step="results"]')).toBeVisible({
    timeout: 15000,
  });
  await page.getByRole("button", { name: "مشاهده نتایج", exact: true }).click();
  await expect(page.locator('[data-tutorial-step="done"]')).toBeVisible();
  await page.getByRole("button", { name: "پایان راهنما", exact: true }).click();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const search = page.getByRole("searchbox", {
    name: "جست‌وجوی کالا یا فروشگاه",
  });
  await search.fill("شیر");
  await expect(page.locator(".results-search-icon")).toHaveCSS(
    "animation-name",
    "search-look"
  );
  await page.screenshot({
    path: `../../.data/design-evidence/search-toolbar-${test.info().project.name}.png`,
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "پاک‌کردن جست‌وجو", exact: true })
    .click();
  await expect(search).toHaveValue("");
  await page
    .getByRole("button", { name: "حداقل تخفیف نتیجه‌ها", exact: true })
    .click();
  const stepper = page.locator(".discount-stepper");
  await expect(stepper).toBeVisible();
  const parent = (await stepper.boundingBox())!;
  for (const name of ["کاهش درصد تخفیف", "افزایش درصد تخفیف"]) {
    const button = stepper.getByRole("button", { name, exact: true });
    const bounds = (await button.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(parent.x);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(
      parent.x + parent.width
    );
  }
  await page.screenshot({
    path: `../../.data/design-evidence/discount-stepper-${test.info().project.name}.png`,
  });
  await page.keyboard.press("Escape");

  await page.emulateMedia({ reducedMotion: "reduce" });
  await search.fill("شیر");
  await expect(page.locator(".results-search-icon")).toHaveCSS(
    "animation-name",
    "none"
  );

  await expect(
    page.locator(
      '[data-tutorial-step="search"], [data-tutorial-step="product"]'
    )
  ).toHaveCount(0);
  await expect(page.locator(".tutorial-hint")).toHaveCount(0);
  await expect(page.locator(".tutorial-spotlight")).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".shopping-page-heading")).toBeVisible();
  await expect(page.locator(".tutorial-hint")).toHaveCount(0);
  expect(state.starts).toBe(providerCount);
});

for (const age of [null, 2, 0]) {
  test(`entry routing waits for manual scan; previous scan age ${age}`, async ({
    page,
  }) => {
    const state = await setup(page);
    state.guestLocations.push(home);
    if (age !== null)
      state.scans.push(
        tutorialRun(new Date(Date.now() - age * 86400000).toISOString())
      );
    await page.addInitScript(() =>
      localStorage.setItem("better-buy:tutorial:v2", "dismissed")
    );
    await page.goto("/");
    await expect(
      page.locator(age === 0 ? ".shopping-page-heading" : ".scan-page")
    ).toBeVisible();
    expect(state.starts).toBe(0);
  });
}

test("skipping the practical guide persists without starting a scan", async ({
  page,
}) => {
  const state = await setup(page);
  await page.goto("/");
  await page
    .getByRole("button", { name: "رد کردن راهنما", exact: true })
    .click();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "افزودن موقعیت تحویل", exact: true })
  ).toBeVisible();
  await expect(page.locator(".tutorial-hint")).toHaveCount(0);
  expect(state.starts).toBe(0);
});

test("an explicit historical scan link opens its list without scanning", async ({
  page,
}) => {
  const state = await setup(page);
  state.guestLocations.push(home);
  state.scans.push(
    tutorialRun(new Date(Date.now() - 2 * 86400000).toISOString())
  );
  await page.addInitScript(() =>
    localStorage.setItem("better-buy:tutorial:v2", "dismissed")
  );
  await page.goto("/?scan=tutorial-scan");
  await expect(page.locator(".shopping-page-heading")).toBeVisible();
  expect(state.starts).toBe(0);
});

test("dark guide clearly spotlights the location control and removes the blur on skip", async ({
  page,
}) => {
  const state = await setup(page);
  state.guestLocations.push(home);
  state.scans.push(tutorialRun(new Date().toISOString()));
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  const hint = page.locator('[data-tutorial-step="location"]');
  await expect(hint).toHaveCSS("background-color", "rgb(105, 65, 207)");
  await expect(page.locator(".tutorial-spotlight")).toHaveCSS(
    "backdrop-filter",
    "blur(5px)"
  );
  await page.screenshot({
    path: `../../.data/design-evidence/tutorial-dark-${test.info().project.name}.png`,
  });
  await hint
    .getByRole("button", { name: "رد کردن راهنما", exact: true })
    .click();
  await expect(page.locator(".tutorial-spotlight")).toHaveCount(0);
  expect(state.starts).toBe(0);
});

test("guest sign-in banner is compact, fixed and clear of the workspace", async ({
  page,
}) => {
  await setup(page);
  await page.addInitScript(() =>
    localStorage.setItem("better-buy:tutorial:v2", "dismissed")
  );
  await page.goto("/");
  const banner = page.locator(".guest-banner");
  await expect(banner).toHaveCSS("position", "fixed");
  await expect(banner).toHaveCSS(
    "height",
    test.info().project.name === "mobile" ? "56px" : "64px"
  );
  await expect(banner).toHaveCSS("background-color", "rgb(99, 52, 197)");
  await expect(page.locator(".onboarding")).toBeVisible();
  const bannerBounds = await banner.boundingBox();
  const contentBounds = await page.locator(".onboarding").boundingBox();
  expect(contentBounds!.y).toBeGreaterThanOrEqual(bannerBounds!.height);
  await page.evaluate(() => window.scrollTo(0, 400));
  await expect.poll(async () => (await banner.boundingBox())!.y).toBe(0);
  await expect(
    banner.getByRole("button", { name: "ورود یا ثبت‌نام", exact: true })
  ).toBeVisible();
  await page.screenshot({
    path: `../../.data/design-evidence/guest-banner-${test.info().project.name}.png`,
  });
  if (test.info().project.name === "mobile") {
    await page.setViewportSize({ width: 320, height: 640 });
    await expect(banner).toHaveCSS("height", "56px");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      )
    ).toBe(true);
  }
});

for (const feature of ["علاقه‌مندی‌ها", "اعلان‌ها", "سبد خرید"]) {
  test(`guest ${feature} opens login directly without account requests`, async ({
    page,
  }) => {
    const state = await setup(page);
    await page.addInitScript(() =>
      localStorage.setItem("better-buy:tutorial:v2", "dismissed")
    );
    await page.goto("/");
    await expect(page.locator(".onboarding")).toBeVisible();
    const mobile = test.info().project.name === "mobile";
    const trigger =
      feature === "سبد خرید" && !mobile
        ? page.locator(".cart-trigger")
        : page
            .locator(mobile ? ".mobile-bottom-nav" : ".desktop-primary-nav")
            .getByRole("button", { name: feature, exact: true });
    await trigger.click();
    await expect(page).toHaveURL(/page=login/);
    await expect(page.getByLabel("شماره همراه")).toBeVisible();
    await expect(page.locator(".guest-toast")).toHaveCount(0);
    expect(state.protectedRequests).toEqual([]);
    expect(state.starts).toBe(0);
  });
}

test("continue without login sits inside the auth card and opens guest browsing", async ({
  page,
}) => {
  const state = await setup(page);
  await page.goto("/?page=login");
  const card = page.locator(".phone-auth-card");
  const guestLink = card.getByRole("link", {
    name: "ادامه بدون ورود",
    exact: true,
  });
  await expect(guestLink).toBeVisible();
  await expect(guestLink).toHaveCSS("min-block-size", "48px");
  await expect(page.locator(".guest-login-return")).toHaveCount(0);
  await page.screenshot({
    path: `../../.data/design-evidence/auth-guest-link-${test.info().project.name}.png`,
    fullPage: true,
  });
  await guestLink.click();
  await expect(page).not.toHaveURL(/page=login/);
  await expect(page.locator(".onboarding")).toBeVisible();
  expect(state.starts).toBe(0);
});

test("password eye toggles inside the input without submitting and respects reduced motion", async ({
  page,
}) => {
  await setup(page);
  await page.goto("/?page=login");
  const input = page.getByLabel("رمز عبور", { exact: true });
  await input.fill("a long passphrase");
  const eye = page.getByRole("button", { name: "نمایش رمز", exact: true });
  await expect(eye).toHaveAttribute("aria-pressed", "false");
  const inputBox = (await input.boundingBox())!;
  const eyeBox = (await eye.boundingBox())!;
  expect(eyeBox.x).toBeGreaterThan(inputBox.x);
  expect(eyeBox.x + eyeBox.width).toBeLessThanOrEqual(
    inputBox.x + inputBox.width
  );
  await expect(eye).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await eye.click();
  await expect(page.locator(".password-eye-lid")).toHaveCSS(
    "animation-name",
    "password-eye-blink"
  );
  await expect(page.locator(".password-eye")).toHaveCSS(
    "animation-duration",
    "0.7s"
  );
  await expect(input).toHaveAttribute("type", "text");
  await expect(input).toHaveValue("a long passphrase");
  await expect(
    page.getByRole("button", { name: "پنهان کردن رمز", exact: true })
  ).toHaveAttribute("aria-pressed", "true");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page
    .getByRole("button", { name: "پنهان کردن رمز", exact: true })
    .click();
  await expect(input).toHaveAttribute("type", "password");
  await expect(page.locator(".password-eye-lid")).toHaveCSS(
    "animation-name",
    "none"
  );
  await page.screenshot({
    path: `../../.data/design-evidence/password-eye-${test.info().project.name}.png`,
    fullPage: true,
  });
});

test("scan location dropdown creates a new address and preserves store selection", async ({
  page,
}) => {
  const state = await setup(page);
  state.guestLocations.push(home);
  await page.addInitScript(() =>
    localStorage.setItem("better-buy:tutorial:v2", "dismissed")
  );
  await page.goto("/");
  await expect(page.locator(".scan-page")).toBeVisible();
  if (test.info().project.name === "desktop")
    expect(
      (await page.locator("#selected-location").boundingBox())!.width
    ).toBeLessThanOrEqual(320);
  await page
    .getByRole("combobox", { name: "موقعیت تحویل", exact: true })
    .click();
  await page.getByRole("option", { name: /افزودن آدرس جدید/ }).click();
  await expect(
    page.getByRole("dialog", { name: "انتخاب آدرس", exact: true })
  ).toBeVisible();
  await page.getByRole("button", { name: "تأیید موقعیت", exact: true }).click();
  await page.getByLabel("نام مکان", { exact: true }).fill("دفتر جدید");
  await page.getByRole("button", { name: "ذخیره مکان", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "موقعیت تحویل", exact: true })
  ).toContainText("دفتر جدید");
  const checkboxes = page.locator(".provider-checklist input");
  while ((await page.locator(".provider-checklist input:checked").count()) > 1)
    await page.locator(".provider-option[data-checked=true]").first().click();
  await expect(
    page.locator(".provider-checklist input:checked")
  ).toBeDisabled();
  await page.screenshot({
    path: `../../.data/design-evidence/scan-selectors-${test.info().project.name}.png`,
    fullPage: true,
  });
  expect(state.starts).toBe(0);
});
