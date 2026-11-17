import { describe, it, expect } from "vitest";
import {
  scanProgressPercent,
  formatScanDuration,
  type ProgressRun,
} from "./progress";
const start = Date.parse("2026-11-17T10:00:00Z");
const running: ProgressRun = {
  source: "snappmarket",
  status: "running",
  startedAt: new Date(start).toISOString(),
  execution: undefined,
  locationId: "home",
};
describe("steady estimated progress", () => {
  it("advances at the same rate before and after 50 percent", () => {
    const values = [30, 60, 90, 120, 150, 180, 210].map((seconds) =>
      scanProgressPercent([running], [], start + seconds * 1000)!
    );
    const increments = values
      .slice(1)
      .map((value, index) => value - values[index]!);
    expect(
      Math.max(...increments) - Math.min(...increments)
    ).toBeLessThanOrEqual(1);
    expect(values[0]).toBeLessThan(15);
  });
  it("uses a previous successful scan duration for the same location and provider", () => {
    const previous = {
      ...running,
      status: "succeeded" as const,
      startedAt: "2026-11-17T09:00:00Z",
      finishedAt: "2026-11-17T09:02:00Z",
    };
    expect(scanProgressPercent([running], [previous], start + 60_000)).toBe(48);
    expect(
      scanProgressPercent(
        [running],
        [{ ...previous, locationId: "other" }],
        start + 60_000
      )
    ).toBe(24);
  });
  it("does not jump when request counts or discovered totals change", () => {
    expect(scanProgressPercent([running], [], start + 60_000)).toBe(
      scanProgressPercent(
        [
          {
            ...running,
            execution: {
              attemptCount: 2000,
              totalUnits: 789,
              completedUnits: 500,
            } as ProgressRun["execution"],
          },
        ],
        [],
        start + 60_000
      )
    );
  });
  it("reserves 100 for success and supports queued and empty runs", () => {
    expect(scanProgressPercent([running], [], start + 9_000_000)).toBe(95);
    expect(
      scanProgressPercent([{ ...running, status: "queued" }], [], start)
    ).toBe(0);
    expect(
      scanProgressPercent([{ ...running, status: "succeeded" }], [], start)
    ).toBe(100);
    expect(scanProgressPercent([])).toBeNull();
  });
});
describe("scan duration", () => {
  it("formats seconds and minutes from actual start and finish", () => {
    expect(
      formatScanDuration({
        ...running,
        finishedAt: new Date(start + 43_000).toISOString(),
      })
    ).toBe("۴۳ ثانیه");
    expect(
      formatScanDuration({
        ...running,
        finishedAt: new Date(start + 219_000).toISOString(),
      })
    ).toBe("۳ دقیقه و ۳۹ ثانیه");
    expect(
      formatScanDuration({
        ...running,
        finishedAt: new Date(start + 120_000).toISOString(),
      })
    ).toBe("۲ دقیقه");
  });
  it("handles short, unfinished, missing, or invalid timestamps", () => {
    expect(
      formatScanDuration({
        ...running,
        finishedAt: new Date(start + 100).toISOString(),
      })
    ).toBe("کمتر از یک ثانیه");
    expect(formatScanDuration(running)).toBeNull();
    expect(
      formatScanDuration({
        startedAt: null,
        finishedAt: new Date(start).toISOString(),
      })
    ).toBeNull();
    expect(formatScanDuration({ ...running, finishedAt: "bad" })).toBeNull();
    expect(
      formatScanDuration({
        ...running,
        finishedAt: new Date(start - 1).toISOString(),
      })
    ).toBeNull();
  });
});
