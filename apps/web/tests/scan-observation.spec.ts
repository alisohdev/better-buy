import { expect, test, type Page } from "@playwright/test";
import type { LocationRecord, ScanRecord } from "@better-buy/shared";

const date = "2026-10-27T16:00:00.000Z";
const location: LocationRecord = {
  id: "home",
  name: "Home",
  latitude: 35.7,
  longitude: 51.4,
  isDefault: true,
  createdAt: date,
  updatedAt: date,
};
const scan = (
  observation?: ScanRecord["observation"],
  coverage?: "complete" | "incomplete"
): ScanRecord => ({
  id: "saved",
  locationId: "home",
  locationName: "Home",
  source: "okala",
  threshold: 30,
  mode: "full",
  status: "succeeded",
  createdAt: date,
  startedAt: date,
  finishedAt: date,
  vendorCount: 1,
  productCount: 1,
  dealCount: 1,
  errorCode: null,
  errorMessage: null,
  ...(coverage
    ? {
        context: {
          location: {
            name: "Home",
            latitude: 35.7,
            longitude: 51.4,
            revision: 1,
          },
          requestedThreshold: 30,
          effectiveThreshold: 30,
          policyVersion: "automatic-v1",
          manifest: {
            adapter: "snapp-market-party+store-campaigns",
            contractVersion: 1,
            feedKinds: ["market_party", "store_campaign"],
          },
          scopeHash: "fixture",
          eligibilityVersion: 1,
          offerKeyVersion: 1,
          coverage,
        },
      }
    : {}),
  ...(observation ? { observation } : {}),
});

async function load(page: Page, record: ScanRecord) {
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/auth/get-session") {
      await route.fulfill({
        json: {
          session: {
            id: "session",
            userId: "user",
            expiresAt: "2099-01-01T00:00:00Z",
          },
          user: { id: "user", name: "User", email: "user@example.com" },
        },
      });
      return;
    }
    if (pathname === "/api/locations") {
      await route.fulfill({ json: { data: [location] } });
      return;
    }
    if (pathname === "/api/scans") {
      await route.fulfill({ json: { data: [record] } });
      return;
    }
    if (pathname === "/api/scans/saved/products") {
      await route.fulfill({
        json: {
          data: {
            items: [],
            nextCursor: null,
            observedAt: date,
            coverageSummary: "complete",
            baseline: { scanId: null, reason: "first_snapshot" },
          },
        },
      });
      return;
    }
    await route.fulfill({ json: { data: [] } });
  });
  await page.goto("/?scan=saved");
  await expect(
    page.getByRole("heading", { name: "پیشنهادها", exact: true })
  ).toBeVisible();
}

test("shows original offer observation times and shared reuse", async ({
  page,
}) => {
  const observation = {
    oldestAt: "2026-10-27T15:00:00.000Z",
    newestAt: "2026-10-27T15:01:00.000Z",
    reusedRequestCount: 1,
    totalRequestCount: 2,
  };
  await load(page, scan(observation));
  const times = page.locator(".snapshot-time time");
  await expect(times).toHaveCount(2);
  await expect(times.nth(0)).toHaveAttribute("datetime", observation.oldestAt);
  await expect(times.nth(1)).toHaveAttribute("datetime", observation.newestAt);
  await expect(page.locator(".snapshot-time")).toContainText("بررسی مشترک");
});

test("uses scan completion time for older records without observation metadata", async ({
  page,
}) => {
  await load(page, scan());
  const times = page.locator(".snapshot-time time");
  await expect(times).toHaveCount(1);
  await expect(times.first()).toHaveAttribute("datetime", date);
  await expect(page.locator(".snapshot-time")).not.toContainText("بررسی مشترک");
});

test("explains when a saved scan contains only partial verified coverage", async ({
  page,
}) => {
  await load(page, scan(undefined, "incomplete"));
  await expect(
    page.getByText(/بعضی از فهرست‌ها کامل بررسی نشدند/)
  ).toBeVisible();
});
