import { describe, expect, it } from "vitest";
import {
  parseNotifications,
  parseWishlist,
  safeOfferUrl,
  parseDevWishlistRun,
  parseDevScanResult,
} from "./contracts";

describe("wishlist response", () => {
  it("accepts nullable setup and the optional disabled schedule flag", () => {
    const data = {
      items: [
        { id: "tea", phrase: "چای", minDiscount: 15, createdAt: "2026-10-26" },
      ],
      defaultLocationId: null,
      pushPublicKey: null,
    };
    expect(parseWishlist(data)).toEqual(data);
    expect(
      parseWishlist({ ...data, scheduleEnabled: false }).scheduleEnabled
    ).toBe(false);
  });
  it.each([
    null,
    [],
    { items: [] },
    { items: [null], defaultLocationId: null, pushPublicKey: null },
  ])("rejects malformed data %j", (value) => {
    expect(() => parseWishlist(value)).toThrow();
  });
  it.each([14, 81, 15.5, "40", undefined])(
    "rejects an invalid minimum discount %j",
    (minDiscount) => {
      expect(() =>
        parseWishlist({
          items: [
            { id: "tea", phrase: "چای", minDiscount, createdAt: "2026-10-26" },
          ],
          defaultLocationId: null,
          pushPublicKey: null,
        })
      ).toThrow();
    }
  );
});
describe("notification response", () => {
  const notification = {
    id: "notice",
    title: "پیشنهاد تازه",
    body: "چای",
    createdAt: "2026-10-26",
    readAt: null,
    scanId: "scan",
    locationId: "home",
    matches: [
      {
        phrase: "چای",
        title: "چای ایرانی",
        price: 10000,
        discountPercent: 50,
        url: "/?scan=scan",
        source: "snappmarket",
      },
    ],
  };
  it("preserves server ordering, price units, and unread state", () => {
    expect(parseNotifications([notification])).toEqual([notification]);
  });
  it("rejects malformed matches rather than showing an empty inbox", () => {
    expect(() =>
      parseNotifications([
        {
          ...notification,
          matches: [{ ...notification.matches[0], price: "10000" }],
        },
      ])
    ).toThrow();
  });
});
describe("notification links", () => {
  it("accepts backend scan deep links", () =>
    expect(safeOfferUrl("/?scan=scan-1")).toBe("/?scan=scan-1"));
  it.each([
    "javascript:alert(1)",
    "data:text/html,unsafe",
    "//evil.example/",
    "/\\evil.example/",
    "https://user:password@example.com/",
  ])("rejects unsafe link %s", (value) =>
    expect(safeOfferUrl(value)).toBeUndefined()
  );
});
describe("development scan recovery", () => {
  const run = {
    version: 1,
    id: "run",
    userId: "owner",
    steps: [
      {
        source: "snappmarket",
        key: "first",
        scanId: "scan",
        result: { status: "running" },
      },
      { source: "okala", key: "second", scanId: null, result: null },
    ],
  };
  it("restores pending scans only for their owner and provider order", () => {
    expect(parseDevWishlistRun(run, "owner")).toEqual(run);
    expect(() => parseDevWishlistRun(run, "other")).toThrow();
    expect(() =>
      parseDevWishlistRun({ ...run, steps: [...run.steps].reverse() }, "owner")
    ).toThrow();
    expect(() =>
      parseDevWishlistRun(
        { ...run, steps: [{ ...run.steps[0], scanId: null }, run.steps[1]] },
        "owner"
      )
    ).toThrow();
  });
  it("distinguishes real completion without a notification from malformed results", () => {
    expect(
      parseDevScanResult({
        status: "succeeded",
        notification: null,
        push: "not_applicable",
      })
    ).toEqual({
      status: "succeeded",
      notification: null,
      push: "not_applicable",
    });
    expect(() => parseDevScanResult({ status: "succeeded" })).toThrow();
    expect(() => parseDevScanResult({ status: "unknown" })).toThrow();
  });
});
