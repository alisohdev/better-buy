import type { LocationRecord, ScanRecord } from "@better-buy/shared";

const tehranDay = (date: Date) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tehran",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);

export function initialWorkspace(
  scans: ScanRecord[],
  location: LocationRecord | undefined,
  now = new Date()
): "offers" | "scan" {
  if (!location) return "scan";
  const today = tehranDay(now);
  return scans.some((run) => {
    const observed = new Date(run.finishedAt ?? run.createdAt);
    return (
      run.status === "succeeded" &&
      run.locationId === location.id &&
      run.context?.location.revision === (location.coordinateRevision ?? 1) &&
      run.context.location.latitude === location.latitude &&
      run.context.location.longitude === location.longitude &&
      Number.isFinite(observed.getTime()) &&
      tehranDay(observed) === today
    );
  })
    ? "offers"
    : "scan";
}
