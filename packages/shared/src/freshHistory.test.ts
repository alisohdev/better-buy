import { expect, it } from "vitest";
import { scansReadSchema } from "./readModels";
it("accepts Fresh history alongside existing providers", () => {
  const scan = {
    id: "scan",
    locationId: "loc",
    locationName: "Test",
    threshold: 15,
    source: "digikalajet",
    mode: "partial",
    status: "failed",
    createdAt: "2026-11-08T17:29:21Z",
    startedAt: null,
    finishedAt: null,
    vendorCount: 0,
    productCount: 0,
    dealCount: 0,
    errorCode: "DIGIKALA_PAGINATION_DRIFT",
    errorMessage: null,
    context: {
      location: { name: "Test", latitude: 35.7, longitude: 51.4, revision: 1 },
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
    },
  };
  expect(
    scansReadSchema.parse([scan])[0]?.context?.manifest.digikala?.shopId
  ).toBe("shop");
});
