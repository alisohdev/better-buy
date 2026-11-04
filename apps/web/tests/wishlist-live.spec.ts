import { expect, test } from "@playwright/test";

test("live local wishlist button completes both real provider attempts", async ({
  page,
}) => {
  test.skip(
    process.env.WISHLIST_LIVE_TEST !== "1",
    "Opt in to live provider requests with WISHLIST_LIVE_TEST=1"
  );
  test.setTimeout(360_000);
  await page.goto("/");
  const login = page.getByRole("button", {
    name: "Continue as local test user",
    exact: true,
  });
  const wishlist = page.getByRole("button", {
    name: "علاقه‌مندی‌ها",
    exact: true,
  });
  await expect(login.or(wishlist)).toBeVisible();
  if (await login.isVisible()) await login.click();
  await wishlist.click();
  const panel = page.getByRole("dialog", { name: "فهرست علاقه‌مندی‌ها" });
  const start = panel.getByRole("button", {
    name: "اجرای اسکن علاقه‌مندی‌ها اکنون",
    exact: true,
  });
  await expect(start).toBeEnabled();
  const sources: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/wishlist/dev-scan/start")
      sources.push(request.postDataJSON().source);
  });
  await start.click();
  await expect
    .poll(() => sources.length, { timeout: 30_000 })
    .toBeGreaterThan(0);
  await expect(start).toBeEnabled({ timeout: 300_000 });
  expect(sources).toEqual(["snappmarket", "okala"]);
  const report = await page.evaluate(() =>
    Object.keys(sessionStorage)
      .filter((key) => key.startsWith("better-buy:dev-wishlist:"))
      .map((key) => JSON.parse(sessionStorage.getItem(key)!))
      .at(-1)
  );
  expect(
    report.steps.every((step: { scanId: string | null }) => !!step.scanId)
  ).toBe(true);
  console.log(
    "Live wishlist result",
    JSON.stringify(
      report.steps.map(
        (step: {
          source: string;
          result: {
            status: string;
            errorCode?: string;
            notification?: { id: string } | null;
          };
        }) => ({
          source: step.source,
          status: step.result.status,
          errorCode: step.result.errorCode,
          notificationId: step.result.notification?.id,
        })
      )
    )
  );
  await page.screenshot({
    path: "test-results/wishlist-live.png",
    fullPage: false,
  });
});
