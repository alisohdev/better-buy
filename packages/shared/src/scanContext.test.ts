import { describe, expect, it } from "vitest";
import { defaultScanContext } from "./scanContext";
import type { LocationRecord } from "./contracts";

const location: LocationRecord = {
  id: "loc",
  name: "Test",
  latitude: 35.7,
  longitude: 51.4,
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-01T00:00:00Z",
  isDefault: false,
};

describe("provider scan contexts", () => {
  it("uses an explicit Fresh pending manifest without falling through to Okala", async () => {
    const result = await defaultScanContext(location, "digikalajet", 15);
    expect(result.manifest).toEqual({
      adapter: "digikalajet-pending",
      contractVersion: 1,
      feedKinds: ["fresh_supermarket"],
    });
  });

  it("preserves the existing Snapp and Okala manifests", async () => {
    const snapp = await defaultScanContext(location, "snappmarket", 15);
    const okala = await defaultScanContext(location, "okala", 15);
    expect(snapp.manifest.adapter).toBe("snapp-market-party");
    expect(okala.manifest.adapter).toBe("okala-public-campaigns");
  });
});
