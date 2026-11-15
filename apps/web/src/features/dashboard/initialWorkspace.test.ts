import { expect, it } from "vitest";
import type { LocationRecord, ScanRecord } from "@better-buy/shared";
import { initialWorkspace } from "./initialWorkspace";
const location: LocationRecord = {
  id: "home",
  name: "Home",
  latitude: 35.7,
  longitude: 51.4,
  isDefault: true,
  createdAt: "",
  updatedAt: "",
};
const now = new Date("2026-11-15T21:00:00Z"); // Nov 16 in Tehran
const run = {
  locationId: "home",
  status: "succeeded",
  finishedAt: "2026-11-15T20:31:00Z",
  context: { location: { revision: 1, latitude: 35.7, longitude: 51.4 } },
} as ScanRecord;
it("opens scan setup for first use, stale results, failures, and different locations", () => {
  expect(initialWorkspace([], location, now)).toBe("scan");
  expect(initialWorkspace([run], undefined, now)).toBe("scan");
  expect(
    initialWorkspace(
      [{ ...run, finishedAt: "2026-11-15T20:29:00Z" }],
      location,
      now
    )
  ).toBe("scan");
  expect(initialWorkspace([{ ...run, status: "failed" }], location, now)).toBe(
    "scan"
  );
  expect(
    initialWorkspace([{ ...run, locationId: "office" }], location, now)
  ).toBe("scan");
  expect(
    initialWorkspace([run], { ...location, coordinateRevision: 2 }, now)
  ).toBe("scan");
});
it("opens today's successful results using Tehran's date across UTC midnight", () => {
  expect(initialWorkspace([run], location, now)).toBe("offers");
  expect(
    initialWorkspace([run], location, new Date("2026-11-16T00:30:00Z"))
  ).toBe("offers");
});
