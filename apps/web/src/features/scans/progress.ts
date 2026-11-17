import { useEffect, useState } from "react";
import type { ScanRecord } from "@better-buy/shared";
export type ProgressRun = Pick<ScanRecord, "source" | "status" | "execution"> &
  Partial<
    Pick<ScanRecord, "startedAt" | "createdAt" | "finishedAt" | "locationId">
  >;
const defaultDurationMs: Record<ProgressRun["source"], number> = {
  snappmarket: 240_000,
  okala: 180_000,
  digikalajet: 120_000,
};
export function scanDurationMs(
  run: Pick<ProgressRun, "startedAt" | "finishedAt">
): number | null {
  const start = Date.parse(run.startedAt ?? "");
  const end = Date.parse(run.finishedAt ?? "");
  return Number.isFinite(start) && Number.isFinite(end) && end >= start
    ? end - start
    : null;
}
export function formatScanDuration(
  run: Pick<ProgressRun, "startedAt" | "finishedAt">
): string | null {
  const duration = scanDurationMs(run);
  if (duration === null) return null;
  if (duration < 1000) return "کمتر از یک ثانیه";
  const seconds = Math.round(duration / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  const number = new Intl.NumberFormat("fa-IR");
  return minutes
    ? `${number.format(minutes)} دقیقه${remainder ? ` و ${number.format(remainder)} ثانیه` : ""}`
    : `${number.format(seconds)} ثانیه`;
}
function expectedDurationMs(run: ProgressRun, history: ProgressRun[]) {
  const start = Date.parse(run.startedAt ?? run.createdAt ?? "");
  const samples = history
    .filter(
      (previous) =>
        previous.source === run.source &&
        previous.locationId === run.locationId &&
        previous.status === "succeeded" &&
        Date.parse(previous.finishedAt ?? "") <= start
    )
    .sort((a, b) => Date.parse(b.finishedAt!) - Date.parse(a.finishedAt!))
    .slice(0, 3)
    .map(scanDurationMs)
    .filter((value): value is number => value !== null && value > 0)
    .sort((a, b) => a - b);
  return samples.length
    ? Math.max(15_000, samples[Math.floor(samples.length / 2)]!)
    : defaultDurationMs[run.source];
}
// A steady, elapsed-time estimate calibrated by previous successful scans.
// It deliberately avoids easing curves and uneven page/category counts.
export function scanProgressPercent(
  runs: ProgressRun[],
  history: ProgressRun[] = [],
  now = Date.now()
): number | null {
  if (!runs.length) return null;
  const estimates = runs.map((run) => {
    if (run.status === "succeeded") return 100;
    if (run.status === "queued") return 0;
    const start = Date.parse(run.startedAt ?? run.createdAt ?? "");
    const elapsed = Number.isFinite(start) ? Math.max(0, now - start) : 0;
    return Math.min(
      95,
      1 + Math.floor((94 * elapsed) / expectedDurationMs(run, history))
    );
  });
  // Overall completion follows the slowest provider; finishing a faster one
  // must not make the combined percentage drop.
  return Math.min(...estimates);
}
export function useScanProgress(
  runs: ProgressRun[],
  history: ProgressRun[] = []
) {
  const [now, setNow] = useState(Date.now);
  const active = runs.some(
    (run) => run.status === "running" || run.status === "queued"
  );
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return scanProgressPercent(runs, history, now);
}
