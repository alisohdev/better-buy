import { test, expect } from "@playwright/test";
async function mock(page: import("@playwright/test").Page) {
  await page.route("**/api/auth/get-session", (r) => r.fulfill({ json: null }));
  await page.route("**/api/analytics/events", (r) =>
    r.fulfill({ status: 204 })
  );
  await page.route("**/api/auth/otp/start", (r) =>
    r.fulfill({
      json: { challengeId: "challenge-1", expiresIn: 180, resendAfter: 60 },
    })
  );
}
async function registration(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page
    .getByRole("button", { name: "ساخت حساب کاربری", exact: true })
    .click();
  await page.getByLabel("شماره همراه").fill("۰۹۱۲۳۴۵۶۷۸۹");
  await page.getByRole("button", { name: "دریافت کد تأیید" }).click();
  await expect(page.getByLabel("کد تأیید شش رقمی")).toBeVisible();
}
test("Persian paste submits once, waits for backend, then shows name and passwords", async ({
  page,
}) => {
  await mock(page);
  let calls = 0;
  await page.route("**/api/auth/otp/verify", async (r) => {
    calls++;
    expect(r.request().postDataJSON().code).toBe("123456");
    await new Promise((resolve) => setTimeout(resolve, 150));
    await r.fulfill({ json: { ticket: "ticket" } });
  });
  await registration(page);
  const input = page.getByLabel("کد تأیید شش رقمی");
  await expect(input).toHaveAttribute("dir", "ltr");
  await input.fill("۱۲۳۴۵۶");
  await expect(input).toBeDisabled();
  await expect(page.getByLabel("نام شما")).toBeVisible();
  expect(calls).toBe(1);
});
test("wrong code, cooldown, edit and reduced motion remain usable", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mock(page);
  await page.route("**/api/auth/otp/verify", (r) =>
    r.fulfill({
      status: 400,
      json: { error: { message: "کد منقضی شده است." } },
    })
  );
  await registration(page);
  await expect(
    page.getByRole("button", { name: "ارسال دوباره کد", exact: true })
  ).toBeDisabled();
  await page.getByLabel("کد تأیید شش رقمی").fill("١٢٣٤٥٦");
  await expect(page.locator(".phone-auth-error")).toContainText("منقضی");
  await expect(page.getByLabel("کد تأیید شش رقمی")).toBeEnabled();
  await page.getByRole("button", { name: "ویرایش شماره" }).click();
  await expect(page.getByLabel("شماره همراه")).toHaveValue("09123456789");
});
test("WebOTP value is verified by server and listener aborts", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "OTPCredential", { value: class {} });
    Object.defineProperty(navigator, "credentials", {
      value: {
        get: (options: { signal: AbortSignal }) =>
          new Promise((resolve) => {
            options.signal.addEventListener(
              "abort",
              () => (document.documentElement.dataset.otpAborted = "yes")
            );
            setTimeout(() => resolve({ code: "123456" }), 700);
          }),
      },
    });
  });
  await mock(page);
  await page.route("**/api/auth/otp/verify", (r) =>
    r.fulfill({ json: { ticket: "web-ticket" } })
  );
  await registration(page);
  await expect(page.getByLabel("نام شما")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-otp-aborted", "yes");
});
test("WebOTP rejection falls back to manual entry", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "OTPCredential", { value: class {} });
    Object.defineProperty(navigator, "credentials", {
      value: { get: () => Promise.reject(new Error("unavailable")) },
    });
  });
  await mock(page);
  await page.route("**/api/auth/otp/verify", (r) =>
    r.fulfill({ json: { ticket: "manual-ticket" } })
  );
  await registration(page);
  await page.getByLabel("کد تأیید شش رقمی").fill("123456");
  await expect(page.getByLabel("نام شما")).toBeVisible();
});
