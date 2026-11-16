import type { ScanRecord } from "@better-buy/shared";

export function scanFailureMessage(scan: ScanRecord): string {
  if (scan.errorCode === "INCOMPLETE_PAGINATION")
    return "فهرست کالاهای فروشگاه کامل دریافت نشد؛ اسکن ناموفق بود و نتیجه‌ای منتشر نشد. دوباره تلاش کنید.";
  if (scan.errorMessage && /[\u0600-\u06ff]/.test(scan.errorMessage))
    return scan.errorMessage;
  return "اسکن کامل نشد و نتیجه‌ای منتشر نشد. دوباره تلاش کنید.";
}
