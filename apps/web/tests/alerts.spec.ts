import { expect, test, type Page } from "@playwright/test";

const date = "2026-10-26T09:00:00.000Z";
const publicKey = Buffer.from([
  4,
  ...Array.from({ length: 64 }, () => 1),
]).toString("base64url");

async function fixture(
  page: Page,
  options: {
    key?: string | null;
    permission?: "default" | "denied";
    unsupported?: boolean;
    pushFailure?: boolean;
    scan?: boolean;
    devEnabled?: boolean;
  } = {}
) {
  await page.addInitScript(
    ({ permission, unsupported }) => {
      const state = {
        requested: 0,
        subscribed: 0,
        unsubscribed: 0,
        permission,
        current: false,
      };
      Object.defineProperty(window, "__pushState", { value: state });
      Object.defineProperty(window, "Notification", {
        configurable: true,
        value: {
          get permission() {
            return state.permission;
          },
          requestPermission: async () => {
            state.requested++;
            state.permission = "granted";
            return "granted";
          },
        },
      });
      if (unsupported) {
        Reflect.deleteProperty(window, "PushManager");
        return;
      }
      Object.defineProperty(window, "PushManager", {
        configurable: true,
        value: function PushManager() {},
      });
      const subscription = {
        endpoint: "https://push.example/device",
        toJSON: () => ({ keys: { p256dh: "key", auth: "auth" } }),
        unsubscribe: async () => {
          state.unsubscribed++;
          state.current = false;
          return true;
        },
      };
      const registration = {
        pushManager: {
          getSubscription: async () => (state.current ? subscription : null),
          subscribe: async () => {
            state.subscribed++;
            state.current = true;
            return subscription;
          },
        },
      };
      Object.defineProperty(navigator, "serviceWorker", {
        configurable: true,
        value: {
          register: async () => registration,
          ready: Promise.resolve(registration),
        },
      });
    },
    {
      permission: options.permission ?? "default",
      unsupported: options.unsupported ?? false,
    }
  );
  const state = {
    items: [] as { id: string; phrase: string; createdAt: string }[],
    defaultLocationId: null as string | null,
    readAt: null as string | null,
    pushWrites: [] as { method: string; body: unknown }[],
  };
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname === "/api/auth/get-session")
      return route.fulfill({
        json: {
          session: {
            id: "session",
            userId: "user",
            expiresAt: "2099-01-01T00:00:00Z",
          },
          user: {
            id: "user",
            name: "کاربر نمونه",
            email: "fixture@example.com",
          },
        },
      });
    let data: unknown = [];
    if (url.pathname === "/api/wishlist") {
      if (method === "POST")
        state.items.push({
          id: "tea",
          phrase: route.request().postDataJSON().phrase,
          createdAt: date,
        });
      data = {
        items: state.items,
        defaultLocationId: state.defaultLocationId,
        pushPublicKey: options.key === undefined ? publicKey : options.key,
        scheduleEnabled: false,
        devScanEnabled: options.devEnabled ?? false,
      };
    } else if (url.pathname === "/api/wishlist/location") {
      state.defaultLocationId = route.request().postDataJSON().locationId;
    } else if (url.pathname === "/api/wishlist/tea" && method === "DELETE") {
      state.items = [];
    } else if (url.pathname === "/api/notifications") {
      data = [
        {
          id: "notice-1",
          title: "چای ارزان‌تر شد",
          body: "سه پیشنهاد تازه",
          matches: [
            {
              phrase: "چای",
              title: "چای ایرانی",
              price: 12000,
              discountPercent: 50,
              url: "/?scan=saved",
              source: "snappmarket",
            },
          ],
          createdAt: date,
          readAt: state.readAt,
          scanId: "saved",
          locationId: "office",
        },
      ];
    } else if (url.pathname === "/api/notifications/notice-1/read")
      state.readAt = date;
    else if (url.pathname === "/api/push/subscriptions") {
      state.pushWrites.push({ method, body: route.request().postDataJSON() });
      if (options.pushFailure)
        return route.fulfill({
          status: 503,
          json: { message: "ثبت اشتراک انجام نشد" },
        });
    } else if (url.pathname === "/api/locations")
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
        {
          id: "office",
          name: "دفتر",
          latitude: 35.72,
          longitude: 51.41,
          isDefault: false,
          createdAt: date,
          updatedAt: date,
        },
      ];
    else if (url.pathname === "/api/scans" && options.scan)
      data = [
        {
          id: "saved",
          locationId: "office",
          locationName: "دفتر",
          source: "okala",
          threshold: 40,
          mode: "partial",
          status: "succeeded",
          createdAt: date,
          startedAt: date,
          finishedAt: date,
          vendorCount: 1,
          productCount: 1,
          dealCount: 1,
          errorCode: null,
          errorMessage: null,
        },
      ];
    await route.fulfill({ json: { data } });
  });
  return state;
}
async function pushState(page: Page) {
  return page.evaluate(() => Reflect.get(window, "__pushState"));
}
test("production builds hide manual development scans even if the API advertises them", async ({
  page,
}) => {
  await fixture(page, { devEnabled: true });
  await page.goto("/");
  await page
    .getByRole("button", { name: "علاقه‌مندی‌ها", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "اسکن آزمایشی علاقه‌مندی‌ها" })
  ).toHaveCount(0);
});

test("wishlist CRUD, independent scan location, and disabled setup banner", async ({
  page,
}) => {
  const state = await fixture(page, { key: null });
  await page.goto("/");
  await page
    .getByRole("button", { name: "علاقه‌مندی‌ها", exact: true })
    .click();
  const panel = page.getByRole("dialog", { name: "فهرست علاقه‌مندی‌ها" });
  await expect(
    panel.getByText("اسکن زمان‌بندی‌شده هنوز فعال نیست")
  ).toBeVisible();
  await expect(
    panel.getByText(/هر روز ساعت ۹ و ۱۸ به وقت تهران/)
  ).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "فعال‌سازی اعلان مرورگر" })
  ).toBeDisabled();
  await panel.getByLabel("نام کالا یا عبارت دلخواه").fill("  چای  ");
  await panel.getByRole("button", { name: "افزودن", exact: true }).click();
  await expect(panel.getByRole("button", { name: "حذف چای" })).toBeVisible();
  expect(state.items[0]?.phrase).toBe("چای");
  await panel.getByLabel("موقعیت اسکن زمان‌بندی‌شده").selectOption("office");
  await expect(panel.getByLabel("موقعیت اسکن زمان‌بندی‌شده")).toHaveValue(
    "office"
  );
  expect(state.defaultLocationId).toBe("office");
  await panel.getByLabel("موقعیت اسکن زمان‌بندی‌شده").selectOption("");
  await expect(panel.getByLabel("موقعیت اسکن زمان‌بندی‌شده")).toHaveValue("");
  expect(state.defaultLocationId).toBeNull();
  await panel.getByRole("button", { name: "حذف چای" }).click();
  await expect(panel.getByText("هنوز عبارتی ثبت نکرده‌اید.")).toBeVisible();
  expect((await pushState(page)).requested).toBe(0);
  await panel.getByRole("button", { name: "بستن پنجره" }).click();
  await expect(
    page.getByRole("combobox", { name: "موقعیت تحویل" })
  ).toContainText("خانه");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth
    )
  ).toBe(true);
});
test("notification deep link opens inbox, keeps local scan links, and marks read", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto("/?notification=notice-1");
  const panel = page.getByRole("dialog", { name: "صندوق اعلان‌ها" });
  await expect(panel.getByText("چای ارزان‌تر شد")).toBeVisible();
  await expect(
    panel.getByRole("link", { name: "مشاهده نتیجه اسکن" })
  ).toHaveAttribute("href", "/?scan=saved");
  await panel
    .getByRole("button", { name: "علامت‌گذاری به‌عنوان خوانده‌شده" })
    .click();
  await expect(panel.getByText("خوانده‌نشده", { exact: true })).toHaveCount(0);
  expect(state.readAt).toBe(date);
});
test("scan deep link restores the scan location and source", async ({
  page,
}) => {
  await fixture(page, { scan: true });
  await page.goto("/?scan=saved");
  await expect(
    page.getByRole("combobox", { name: "موقعیت تحویل" })
  ).toContainText("دفتر");
  await page.getByRole("button", { name: "تنظیمات", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "فروشگاه", exact: true })
  ).toContainText("اکالا");
});
test("push requests permission only on click and syncs/unsubscribes the exact endpoint", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto("/");
  await page
    .getByRole("button", { name: "علاقه‌مندی‌ها", exact: true })
    .click();
  const enable = page.getByRole("button", {
    name: "فعال‌سازی اعلان مرورگر",
    exact: true,
  });
  await expect(enable).toBeEnabled();
  expect((await pushState(page)).requested).toBe(0);
  await enable.click();
  await expect(
    page.getByText("اعلان مرورگر برای این حساب فعال شد.")
  ).toBeVisible();
  expect((await pushState(page)).requested).toBe(1);
  expect(state.pushWrites[0]).toEqual({
    method: "POST",
    body: {
      endpoint: "https://push.example/device",
      keys: { p256dh: "key", auth: "auth" },
    },
  });
  await page
    .getByRole("button", { name: "غیرفعال‌سازی در این دستگاه" })
    .click();
  await expect(
    page.getByText("اعلان مرورگر در این دستگاه غیرفعال شد.")
  ).toBeVisible();
  expect(state.pushWrites[1]).toEqual({
    method: "DELETE",
    body: { endpoint: "https://push.example/device" },
  });
  expect((await pushState(page)).unsubscribed).toBe(1);
});
test("failed push sync rolls back a newly-created browser subscription", async ({
  page,
}) => {
  await fixture(page, { pushFailure: true });
  await page.goto("/");
  await page
    .getByRole("button", { name: "علاقه‌مندی‌ها", exact: true })
    .click();
  await page
    .getByRole("button", { name: "فعال‌سازی اعلان مرورگر", exact: true })
    .click();
  await expect(
    page.getByRole("alert").filter({ hasText: "ثبت اشتراک انجام نشد" })
  ).toBeVisible();
  expect((await pushState(page)).unsubscribed).toBe(1);
});
test("denied permission has a recovery message and never re-prompts automatically", async ({
  page,
}) => {
  await fixture(page, { permission: "denied" });
  await page.goto("/");
  await page
    .getByRole("button", { name: "علاقه‌مندی‌ها", exact: true })
    .click();
  await expect(page.getByText(/اجازه اعلان مسدود است؛/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "فعال‌سازی اعلان مرورگر", exact: true })
  ).toBeDisabled();
  expect((await pushState(page)).requested).toBe(0);
});
test("unsupported browsers keep the in-app inbox available", async ({
  page,
}) => {
  await fixture(page, { unsupported: true });
  await page.goto("/");
  await page
    .getByRole("button", { name: "علاقه‌مندی‌ها", exact: true })
    .click();
  await expect(
    page.getByText(/اعلان در این مرورگر در دسترس نیست/)
  ).toBeVisible();
  expect((await pushState(page)).requested).toBe(0);
});
