import { afterEach, describe, expect, it } from "vitest";
import {
  readGuestLocations,
  saveGuestLocations,
  guestLocationKey,
} from "./storage";
import type { LocationRecord } from "@better-buy/shared";

const location: LocationRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Home",
  latitude: 35.7,
  longitude: 51.4,
  isDefault: true,
  createdAt: "2026-11-15T00:00:00Z",
  updatedAt: "2026-11-15T00:00:00Z",
  coordinateRevision: 1,
};
afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});
describe("guest location storage", () => {
  it("round trips validated locations without auth credentials", () => {
    const data = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => data.get(key) ?? null,
        setItem: (key: string, value: string) => data.set(key, value),
      },
    });
    expect(saveGuestLocations([location])).toBe(true);
    expect(readGuestLocations()).toEqual([location]);
    expect([...data.keys()]).toEqual([guestLocationKey]);
  });
  it("rejects malformed, invalid, and oversized persisted data", () => {
    for (const raw of [
      "{",
      "null",
      JSON.stringify([{ ...location, latitude: 0 }]),
      JSON.stringify(Array(21).fill(location)),
    ]) {
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: { getItem: () => raw },
      });
      expect(readGuestLocations()).toEqual([]);
    }
  });
  it("handles unavailable browser storage without crashing", () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get: () => {
        throw new Error("blocked");
      },
    });
    expect(readGuestLocations()).toEqual([]);
    expect(saveGuestLocations([location])).toBe(false);
  });
});
