import { expect, test, type Page } from "@playwright/test";

const date = "2026-10-27T09:00:00Z";
const ids = {
  snappmarket: "11111111-1111-4111-8111-111111111111",
  okala: "22222222-2222-4222-8222-222222222222",
};
async function fixture(page: Page, noMatches = false) {
  const state = {
    userId: "dev-user",
    firstFinished: false,
    ready: true,
    enabled: true,
    starts: [] as { source: string; key: string }[],
    statusOwners: [] as string[],
    inboxReads: 0,
  };
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/get-session")
      return route.fulfill({
        json: {
          session: {
            id: "session",
            userId: state.userId,
            expiresAt: "2099-01-01T00:00:00Z",
          },
          user: { id: state.userId, name: "Test", email: "test@example.test" },
        },
      });
    let data: unknown = [];
    if (url.pathname === "/api/wishlist")
      data = {
        items: state.ready
          ? [{ id: "wish", phrase: "چای", minDiscount: 15, createdAt: date }]
          : [],
        defaultLocationId: state.ready ? "home" : null,
        pushPublicKey: null,
        scheduleEnabled: true,
        devScanEnabled: state.enabled,
      };
    else if (url.pathname === "/api/locations")
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
    else if (url.pathname === "/api/notifications") state.inboxReads++;
    else if (url.pathname === "/api/wishlist/dev-scan/start") {
      const body = route.request().postDataJSON();
      expect(Object.keys(body).sort()).toEqual(["key", "source"]);
      expect(route.request().headers()["x-better-buy-dev"]).toBe("wishlist-ui");
      expect(
        route.request().headers()["x-better-buy-dev-signature"]
      ).toBeUndefined();
      state.starts.push(body);
      data = {
        scanId: ids[body.source === "snappmarket" ? "snappmarket" : "okala"],
        status: "queued",
      };
    } else if (url.pathname === "/api/wishlist/dev-scan/status") {
      state.statusOwners.push(state.userId);
      const body = route.request().postDataJSON();
      expect(Object.keys(body)).toEqual(["scanId"]);
      if (body.scanId === ids.snappmarket)
        data = !state.firstFinished
          ? { status: "running" }
          : {
              status: "succeeded",
              push: "unconfigured",
              notification: noMatches
                ? null
                : {
                    id: "notice",
                    title: "پیشنهاد تازه برای چای",
                    body: "یک پیشنهاد تازه",
                    matches: [
                      {
                        phrase: "چای",
                        title: "چای ایرانی",
                        price: 12000,
                        discountPercent: 50,
                        url: "/?scan=" + ids.snappmarket,
                        source: "snappmarket",
                      },
                    ],
                  },
            };
      else
        data = noMatches
          ? { status: "succeeded", push: "not_applicable", notification: null }
          : {
              status: "failed",
              errorCode: "UPSTREAM_CHANGED",
              errorMessage: "ساختار پاسخ فروشگاه تغییر کرده است.",
            };
    }
    await route.fulfill({ json: { data } });
  });
  return state;
}
async function openWishlist(page: Page) {
  await page
    .getByRole("button", { name: "علاقه‌مندی‌ها", exact: true })
    .click();
  return page.getByRole("dialog", { name: "فهرست علاقه‌مندی‌ها" });
}

test("both providers run sequentially while the modal is closed and preserve partial success", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto("/");
  const panel = await openWishlist(page);
  await panel
    .getByRole("button", {
      name: "اجرای اسکن علاقه‌مندی‌ها اکنون",
      exact: true,
    })
    .click();
  await expect(
    panel.getByText("اسکن در حال اجراست.", { exact: true })
  ).toBeVisible();
  expect(state.starts.map((entry) => entry.source)).toEqual(["snappmarket"]);
  const reads = state.inboxReads;
  await panel.getByRole("button", { name: "بستن پنجره" }).click();
  state.firstFinished = true;
  await expect
    .poll(() => state.starts.map((entry) => entry.source), { timeout: 15000 })
    .toEqual(["snappmarket", "okala"]);
  const reopened = await openWishlist(page);
  await expect(
    reopened.getByText("پیشنهاد تازه برای چای", { exact: true })
  ).toBeVisible();
  await expect(reopened.getByText(/UPSTREAM_CHANGED/)).toBeVisible();
  await expect(
    reopened.getByRole("button", {
      name: "اجرای اسکن علاقه‌مندی‌ها اکنون",
      exact: true,
    })
  ).toBeEnabled();
  expect(state.inboxReads).toBeGreaterThan(reads);
  await page.screenshot({
    path: `test-results/wishlist-dev-${test.info().project.name}.png`,
  });
});

test("reload resumes the same scan and shows a genuine no-new-match outcome", async ({
  page,
}) => {
  const state = await fixture(page, true);
  await page.goto("/");
  let panel = await openWishlist(page);
  await panel
    .getByRole("button", {
      name: "اجرای اسکن علاقه‌مندی‌ها اکنون",
      exact: true,
    })
    .click();
  await expect(
    panel.getByText("اسکن در حال اجراست.", { exact: true })
  ).toBeVisible();
  const firstKey = state.starts[0]!.key;
  await page.reload();
  panel = await openWishlist(page);
  await expect(
    panel.getByText("اسکن در حال اجراست.", { exact: true })
  ).toBeVisible();
  expect(state.starts).toHaveLength(1);
  expect(state.starts[0]!.key).toBe(firstKey);
  state.firstFinished = true;
  await expect(
    panel.getByText(
      "پیشنهاد تازه یا ارزان‌تری پیدا نشد؛ اعلان جدیدی ایجاد نشد.",
      { exact: true }
    )
  ).toHaveCount(2, { timeout: 15000 });
  expect(state.starts.map((entry) => entry.source)).toEqual([
    "snappmarket",
    "okala",
  ]);
});

test("missing setup disables the button and changing users does not restore another user's run", async ({
  page,
}) => {
  const state = await fixture(page);
  state.ready = false;
  await page.goto("/");
  let panel = await openWishlist(page);
  await expect(
    panel.getByRole("button", {
      name: "اجرای اسکن علاقه‌مندی‌ها اکنون",
      exact: true,
    })
  ).toBeDisabled();
  state.ready = true;
  await page.reload();
  panel = await openWishlist(page);
  await panel
    .getByRole("button", {
      name: "اجرای اسکن علاقه‌مندی‌ها اکنون",
      exact: true,
    })
    .click();
  await expect(
    panel.getByText("اسکن در حال اجراست.", { exact: true })
  ).toBeVisible();
  state.userId = "other-user";
  await page.reload();
  panel = await openWishlist(page);
  await expect(
    panel.getByRole("button", {
      name: "اجرای اسکن علاقه‌مندی‌ها اکنون",
      exact: true,
    })
  ).toBeEnabled();
  await expect(
    panel.getByText("اسکن در حال اجراست.", { exact: true })
  ).toHaveCount(0);
  expect(state.statusOwners.every((owner) => owner === "dev-user")).toBe(true);
});

test("resuming an ambiguous start reuses its original scan key", async ({
  page,
}) => {
  const state = await fixture(page, true);
  let failed = false;
  await page.route("**/api/wishlist/dev-scan/start", async (route) => {
    if (failed) return route.fallback();
    failed = true;
    state.starts.push(route.request().postDataJSON());
    await route.abort("failed");
  });
  await page.goto("/");
  const panel = await openWishlist(page);
  await panel
    .getByRole("button", {
      name: "اجرای اسکن علاقه‌مندی‌ها اکنون",
      exact: true,
    })
    .click();
  await expect(
    panel.getByRole("button", { name: "ادامه دریافت وضعیت" })
  ).toBeVisible();
  const key = state.starts[0]!.key;
  state.firstFinished = true;
  await panel.getByRole("button", { name: "ادامه دریافت وضعیت" }).click();
  await expect(
    panel.getByText(
      "پیشنهاد تازه یا ارزان‌تری پیدا نشد؛ اعلان جدیدی ایجاد نشد.",
      { exact: true }
    )
  ).toHaveCount(2);
  expect(
    state.starts
      .filter((entry) => entry.source === "snappmarket")
      .map((entry) => entry.key)
  ).toEqual([key, key]);
});
