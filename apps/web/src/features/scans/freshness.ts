import { useEffect, useState } from "react";
import type { ScanRecord } from "@better-buy/shared";
export const SCAN_MAX_AGE = 24 * 60 * 60 * 1000;
export function scanCheckedAt(scan: ScanRecord) {
  return new Date(scan.startedAt ?? scan.createdAt).getTime();
}
export function scanExpired(scan: ScanRecord, now = Date.now()) {
  const at = scanCheckedAt(scan);
  return !Number.isFinite(at) || now >= at + SCAN_MAX_AGE;
}
export function useFreshnessClock() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(timer);
  }, []);
  return now;
}
export function checkedAgo(scan: ScanRecord, now = Date.now()) {
  const minutes = Math.max(0, Math.floor((now - scanCheckedAt(scan)) / 60000));
  return minutes < 1
    ? "همین حالا بررسی شد"
    : minutes < 60
      ? `${new Intl.NumberFormat("fa-IR").format(minutes)} دقیقه پیش بررسی شد`
      : `${new Intl.NumberFormat("fa-IR").format(Math.floor(minutes / 60))} ساعت پیش بررسی شد`;
}
