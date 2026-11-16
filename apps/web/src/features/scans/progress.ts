import type { ScanRecord } from "@better-buy/shared";
export type ProgressRun = Pick<ScanRecord, "source" | "status" | "execution">;

// Okala discovers additional categories during collection; its unit count is not
// a fixed denominator. Completing known units also does not include finalization.
export function scanProgressPercent(runs: ProgressRun[]): number | null {
  if (!runs.length) return null;
  if (runs.every((run) => run.status === "succeeded")) return 100;
  if (
    runs.some(
      (run) =>
        run.status !== "succeeded" &&
        (run.source === "okala" ||
          !run.execution?.totalUnits ||
          run.execution.completedUnits >= run.execution.totalUnits)
    )
  )
    return null;
  const completed = runs.reduce(
    (sum, run) => sum + (run.execution?.completedUnits ?? 0),
    0
  );
  const total = runs.reduce(
    (sum, run) => sum + (run.execution?.totalUnits ?? 0),
    0
  );
  return total ? Math.min(99, Math.floor((completed / total) * 100)) : null;
}
