import { describe, expect, it } from "vitest";
import { groupDealsV2 } from "./groupingV2";
import type { DealRecord } from "./contracts";
const offer = (patch: Partial<DealRecord> = {}): DealRecord => ({
  key: "a:p",
  scanId: "saved",
  productVariationId: "p",
  vendorId: "a",
  vendorTitle: "Store A",
  vendorCode: null,
  title: "ماست ۵۰۰ گرم",
  image: null,
  categoryTitle: null,
  priceRials: 100000,
  discountRials: 40000,
  finalPriceRials: 60000,
  discountRatio: 40,
  stock: 2,
  state: "current",
  ...patch,
});
describe("v2 product comparison", () => {
  it("keeps boolean availability without inventing an exact stock quantity", async () => {
    const groups = await groupDealsV2("digikalajet", [
      offer({ stock: 0, availability: "available", stockQuantity: null }),
    ]);
    expect(groups[0]?.bestCurrentOffer?.availability).toBe("available");
    expect(groups[0]?.bestCurrentOffer?.stock).toBe(0);
    expect(groups[0]?.bestCurrentOffer?.stockQuantity).toBeNull();
  });
  it("settles equal-time conflicts by feed identity independently of input order", async () => {
    const a = offer({ provenance: ["a"], observedAt: "2026-10-10T00:00:00Z" });
    const b = offer({
      provenance: ["b"],
      observedAt: "2026-10-10T00:00:00Z",
      priceRials: 120000,
      discountRials: 60000,
      discountRatio: 50,
    });
    expect(await groupDealsV2("snappmarket", [a, b])).toEqual(
      await groupDealsV2("snappmarket", [b, a])
    );
  });
  it("groups differing store prices and copies the entire cheapest current tuple", async () => {
    const cheaper = offer({
      key: "b:p",
      vendorId: "b",
      vendorTitle: "Store B",
      priceRials: 120000,
      discountRials: 72000,
      finalPriceRials: 48000,
      discountRatio: 60,
      image: "https://example.com/p.png",
      categoryTitle: "different",
    });
    const [group] = await groupDealsV2("snappmarket", [offer(), cheaper]);
    expect(group).toMatchObject({
      groupKeyVersion: 2,
      currentStoreOfferCount: 2,
      priceRials: 120000,
      discountRatio: 60,
      finalPriceRials: 48000,
      bestCurrentOffer: {
        vendorId: "b",
        sourceMoneyUnit: "toman",
        finalAmountToman: 48000,
      },
    });
    const [changed] = await groupDealsV2("snappmarket", [
      offer({
        priceRials: 200000,
        discountRials: 80000,
        finalPriceRials: 120000,
      }),
    ]);
    expect(changed!.key).toBe(group!.key);
    expect(group!.key).toMatch(/^v2:[a-f0-9]{64}$/);
    const [rial] = await groupDealsV2("okala", [
      offer({
        priceRials: 1000000,
        discountRials: 500000,
        finalPriceRials: 500000,
        discountRatio: 50,
      }),
    ]);
    expect(rial!.bestCurrentOffer?.finalAmountToman).toBe(50000);
    expect(rial!.key).not.toBe(group!.key);
  });
  it("preserves variant signatures, deduplicates sightings, and separates conditional benefits", async () => {
    const duplicate = offer({
      key: "repeated",
      observedAt: "2026-10-10T01:00:00Z",
      priceRials: 120000,
      discountRials: 60000,
      finalPriceRials: 60000,
      discountRatio: 50,
      provenance: ["second"],
    });
    const groups = await groupDealsV2("snappmarket", [
      offer({ provenance: ["first"] }),
      duplicate,
      offer({
        key: "conditional",
        benefit: {
          identity: "ordinary",
          kind: "conditional",
          applicable: null,
          terms: "Coupon required",
        },
        discountRials: 90000,
        finalPriceRials: 10000,
        discountRatio: 90,
      }),
      offer({ key: "larger", title: "ماست ۱۰۰۰ گرم" }),
    ]);
    expect(groups).toHaveLength(2);
    const group = groups.find((g) => g.title === "ماست ۵۰۰ گرم")!;
    expect(group.vendors).toHaveLength(1);
    expect(group.bestCurrentOffer).toMatchObject({
      priceRials: 120000,
      discountRatio: 50,
      stock: 2,
      provenance: ["first", "second"],
    });
    expect(group.conditionalOffers).toHaveLength(1);
    expect(group.diagnostics).toEqual([
      "OBSERVATION_CONFLICT",
      "VARIANT_ID_CONFLICT",
    ]);
  });
  it("never crowns historical/unknown-stock or invalid prices and ranks the displayed tuple", async () => {
    const groups = await groupDealsV2("snappmarket", [
      offer({
        key: "historical",
        state: "no_longer_present",
        discountRials: 90000,
        finalPriceRials: 10000,
        discountRatio: 90,
      }),
      offer(),
      offer({
        productVariationId: "other",
        key: "other",
        discountRials: 50000,
        finalPriceRials: 50000,
        discountRatio: 50,
      }),
      offer({
        productVariationId: "bad",
        key: "bad",
        discountRials: 150000,
        finalPriceRials: 0,
      }),
      offer({
        productVariationId: "unknown",
        key: "unknown",
        stock: Number.NaN,
      }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.bestCurrentOffer?.discountRatio).toBe(50);
    expect(groups[1]!.bestCurrentOffer?.finalPriceRials).toBe(60000);
    const [history] = await groupDealsV2("snappmarket", [
      offer({ state: "no_longer_present" }),
    ]);
    expect(history!.bestCurrentOffer).toBeNull();
  });
});
