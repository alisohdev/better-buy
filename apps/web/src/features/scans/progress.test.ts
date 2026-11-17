import { describe, expect, it } from "vitest";
import { scanProgressPercent, type ProgressRun } from "./progress";
const run = (
  source: ProgressRun["source"],
  completedUnits: number,
  totalUnits: number,
  status: ProgressRun["status"] = "running"
): ProgressRun => ({
  source,
  status,
  execution: {
    kind: "workflow",
    phase: "collecting",
    completedUnits,
    totalUnits,
    completedPages: 0,
    observedRows: 0,
    eligibleOffers: 0,
    attemptCount: 0,
    cancelRequested: false,
    heartbeatAt: null,
    deadlineAt: null,
    dispatchState: "running",
  },
});
describe("scan progress", () => {
  it("does not treat discovered Okala categories as the full work plan", () => {
    expect(scanProgressPercent([run("okala", 12, 12)])).toBeNull();
    expect(scanProgressPercent([run("okala", 12, 20)])).toBeNull();
  });
  it("does not show a combined percentage when any provider total is unknown", () => {
    expect(
      scanProgressPercent([run("snappmarket", 1, 2), run("okala", 12, 12)])
    ).toBeNull();
    expect(
      scanProgressPercent([run("snappmarket", 1, 2), run("digikalajet", 0, 0)])
    ).toBeNull();
  });
  it("does not show 100 before finalization or round running work up to 100", () => {
    expect(scanProgressPercent([run("snappmarket", 10, 10)])).toBeNull();
    expect(scanProgressPercent([run("snappmarket", 999, 1000)])).toBeNull();
  });
  it("keeps ongoing work indeterminate and shows 100 only after success", () => {
    expect(scanProgressPercent([run("snappmarket", 1, 4)])).toBeNull();
    expect(scanProgressPercent([run("okala", 12, 12, "succeeded")])).toBe(100);
    expect(scanProgressPercent([])).toBeNull();
  });
});
