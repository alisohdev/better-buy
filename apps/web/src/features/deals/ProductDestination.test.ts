import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { VendorOfferRecord } from "@better-buy/shared";
import { ProductDestination } from "./ProductDestination";

const offer: VendorOfferRecord = {
  offerKey: "10:123",
  productVariationId: "123",
  vendorId: "10",
  vendorTitle: "Store",
  vendorCode: null,
  priceRials: 100,
  discountRials: 20,
  finalPriceRials: 80,
  discountRatio: 20,
  stock: 1,
  state: "current",
};
const destination = {
  url: "https://snapp.market/candidate",
  productVariationId: "123",
  vendorId: "10",
};
const render = (value: VendorOfferRecord | null) =>
  renderToStaticMarkup(
    ProductDestination({ offer: value, source: "snappmarket" })
  );

describe("product destination action", () => {
  it("keeps legacy, unavailable and mismatched store/product offers inert", () => {
    for (const value of [
      null,
      offer,
      { ...offer, productDestination: null },
      {
        ...offer,
        state: "no_longer_present" as const,
        productDestination: destination,
      },
      { ...offer, stock: 0, productDestination: destination },
      { ...offer, productDestination: { ...destination, vendorId: "20" } },
      {
        ...offer,
        productDestination: { ...destination, productVariationId: "456" },
      },
    ])
      expect(render(value)).not.toContain("href=");
  });
  it("rejects homepages, other providers, APIs and credentials", () => {
    for (const url of [
      "https://snapp.market/",
      "https://www.okala.com/candidate",
      "https://svc.snapp.market/product",
      "javascript:alert(1)",
      "https://token@snapp.market/product",
      "https://snapp.market/product?token=secret",
      "https://snapp.market.evil.test/product",
      "https://snapp.market/%2fproduct",
    ])
      expect(
        render({ ...offer, productDestination: { ...destination, url } })
      ).not.toContain("href=");
  });
  it("renders a supplied matching HTTPS destination as an ordinary safe anchor", () => {
    const html = render({ ...offer, productDestination: destination });
    expect(html).toContain('href="https://snapp.market/candidate"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).not.toContain("intent:");
  });
});
