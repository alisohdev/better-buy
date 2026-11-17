import { scanExpired, useFreshnessClock, checkedAgo } from "./freshness";
import { Button } from "@/components/ui/button";
import { scanFailureMessage } from "./scanFailureMessage";
import { Card } from "@/components/ui/card";
import { digikalaSupermarketEnabled } from "./ScanControls";
import type { ScanRecord } from "@better-buy/shared";
import { faNumber, faDate, sourceLabel } from "../dashboard/format";
export function HistoryPanel({
  scans,
  onOpen,
  onRetry,
  blocked,
}: {
  scans: ScanRecord[];
  onOpen: (s: ScanRecord) => void;
  onRetry: (s: ScanRecord) => void;
  blocked: boolean;
}) {
  const now = useFreshnessClock();
  const visible = scans.filter(
    (s) =>
      s.status === "running" || s.status === "queued" || !scanExpired(s, now)
  );
  return (
    <section className="history-page">
      <header className="section-heading">
        <h1>تاریخچه اسکن‌ها</h1>
        <p>برای هر موقعیت و فروشگاه، سه اسکن آخر تا ۲۴ ساعت نگهداری می‌شود.</p>
      </header>
      {visible.length ? (
        <div className="run-list">
          {visible.map((s) => (
            <Card asChild key={s.id}>
              <article className="run-item" key={s.id}>
                <div>
                  <h2>{s.locationName}</h2>
                  <p>
                    {sourceLabel(s.source)} · حداقل{" "}
                    {faNumber.format(s.threshold)}٪
                  </p>
                  <time dateTime={s.createdAt}>
                    {faDate.format(new Date(s.createdAt))}
                  </time>
                  <p>{checkedAgo(s, now)}</p>
                </div>
                <div>
                  <strong>
                    {s.status === "succeeded"
                      ? `${faNumber.format(s.dealCount)} پیشنهاد`
                      : s.status === "failed"
                        ? "اسکن ناموفق"
                        : s.status === "cancelled"
                          ? "اسکن لغو شده"
                          : s.status === "queued"
                            ? "در انتظار بررسی"
                            : "در حال بررسی"}
                  </strong>
                  {s.status === "succeeded" &&
                    s.context?.coverage === "incomplete" && (
                      <p role="status">
                        بعضی فروشگاه‌ها پاسخ قابل بررسی ندادند؛ نتیجه ممکن است
                        کامل نباشد.
                      </p>
                    )}
                  {s.errorMessage && (
                    <p className="form-error">{scanFailureMessage(s)}</p>
                  )}
                  <details>
                    <summary>جزئیات اسکن</summary>
                    {s.context ? (
                      <p>
                        موقعیت ثبت‌شده:{" "}
                        <bdi dir="ltr">
                          {s.context.location.latitude},{" "}
                          {s.context.location.longitude}
                        </bdi>
                      </p>
                    ) : (
                      <p>
                        موقعیت و پوشش تاریخی تأیید نشده؛ مقایسه زمانی انجام
                        نمی‌شود.
                      </p>
                    )}
                    <p>
                      {faNumber.format(s.vendorCount)} فروشگاه بررسی‌شده ·{" "}
                      {faNumber.format(s.productCount)} رکورد کالا
                    </p>
                    {s.observation && (
                      <p>
                        زمان داده‌ها:{" "}
                        {faDate.format(new Date(s.observation.oldestAt))}
                        {s.observation.newestAt !== s.observation.oldestAt &&
                          ` تا ${faDate.format(new Date(s.observation.newestAt))}`}
                        {s.observation.reusedRequestCount > 0 &&
                          " · شامل پیشنهادهای بازیابی‌شده از بررسی مشترک"}
                      </p>
                    )}
                    <p>حالت ثبت‌شده: {s.mode === "full" ? "کامل" : "جزئی"}</p>
                  </details>
                </div>
                {s.status === "succeeded" ? (
                  <Button
                    variant="outline"
                    className="run-row"
                    onClick={() => onOpen(s)}
                  >
                    نمایش نتیجه
                  </Button>
                ) : (s.status === "failed" || s.status === "cancelled") &&
                  (s.source !== "digikalajet" || digikalaSupermarketEnabled) ? (
                  <Button
                    variant="outline"
                    disabled={blocked}
                    onClick={() => onRetry(s)}
                  >
                    اسکن تازه با این گزینه‌ها
                  </Button>
                ) : s.source === "digikalajet" ? (
                  <span className="muted">اسکن تازه غیرفعال</span>
                ) : null}
              </article>
            </Card>
          ))}
        </div>
      ) : (
        <div className="empty">
          <h2>هنوز اسکن ثبت نشده</h2>
          <p>
            نتیجه‌های قدیمی پس از ۲۴ ساعت حذف می‌شوند؛ برای بررسی قیمت و موجودی،
            اسکن تازه انجام دهید.
          </p>
        </div>
      )}
    </section>
  );
}
