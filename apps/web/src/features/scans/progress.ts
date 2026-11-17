import type { ScanRecord } from "@better-buy/shared";
export type ProgressRun = Pick<ScanRecord, "source" | "status" | "execution">;

// Providers discover work during collection; unit counts are not a fixed total.
export function scanProgressPercent(runs: ProgressRun[]): number | null {
  if (!runs.length) return null;
  if (runs.every((run) => run.status === "succeeded")) return 100;
  // Providers discover additional pages/categories and still verify/publish afterwards.
  // No fixed overall denominator exists yet: show an indeterminate bar, not a false percent.
  return null;
}
