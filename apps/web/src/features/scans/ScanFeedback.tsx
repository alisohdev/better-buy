import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { LocationRecord, ScanRecord } from "@better-buy/shared";
import { AppIcon, ProviderMark } from "../dashboard/AppIcon";
import { ReadNotice } from "../dashboard/Primitives";
import { faNumber, sourceLabel } from "../dashboard/format";
import type { useScanPolling } from "./useScanPolling";
import type { useStartScan } from "./useStartScan";
import { useCancelScan } from "./useCancelScan";
export function ScanFeedback({
  active,
  polling,
  start,
  locations,
  onOpenContext,
}: {
  active: ScanRecord | null;
  polling: ReturnType<typeof useScanPolling>;
  start: ReturnType<typeof useStartScan>;
  locations: LocationRecord[];
  onOpenContext: (run: ScanRecord) => void;
}) {
  const cancel = useCancelScan();
  return (
    <>
      {active && (
        <Card asChild>
          <section className="active-scan" role="status" aria-live="polite">
            <div>
              <span className="scan-provider">
                <ProviderMark source={active.source} />
                {sourceLabel(active.source)}
              </span>
              <strong>
                {polling.error
                  ? "وضعیت اسکن تازه‌سازی نشد"
                  : active.status === "queued"
                    ? "اسکن در انتظار بررسی است"
                    : "در حال پیدا کردن تخفیف‌ها…"}
              </strong>
              <p className="scan-status-badges">
                {active.locationName} · {sourceLabel(active.source)} · حداقل{" "}
                {faNumber.format(active.threshold)}٪
              </p>
              {active.productCount > 0 && (
                <p>
                  {faNumber.format(active.vendorCount)} فروشگاه بررسی‌شده ·{" "}
                  {faNumber.format(active.productCount)} رکورد کالا
                </p>
              )}
              {polling.error && (
                <p>
                  آخرین وضعیت شناخته‌شده نمایش داده می‌شود. این خطا به معنی شکست
                  اسکن نیست.
                </p>
              )}
              {active.execution && (
                <div className="scan-progress-card">
                  <div className="scan-sweep" aria-hidden="true" />
                  <p className="scan-phase">
                    {active.execution.cancelRequested
                      ? "در حال توقف و حفظ نتیجه قبلی…"
                      : active.execution.phase === "queued"
                        ? "در انتظار شروع بررسی فروشگاه‌ها"
                        : "در حال دریافت و مقایسه پیشنهادهای فروشگاه‌ها"}
                  </p>
                  <div
                    className="scan-progress-track"
                    role="progressbar"
                    aria-label="پیشرفت اسکن"
                    aria-valuemin={0}
                    aria-valuemax={active.execution.totalUnits || undefined}
                    aria-valuenow={
                      active.execution.totalUnits
                        ? active.execution.completedUnits
                        : undefined
                    }
                  >
                    <span
                      style={{
                        width: `${active.execution.totalUnits ? Math.min(100, (active.execution.completedUnits / active.execution.totalUnits) * 100) : 0}%`,
                      }}
                    />
                  </div>
                  <p className="scan-progress-count">
                    {faNumber.format(active.execution.completedUnits)} از{" "}
                    {faNumber.format(active.execution.totalUnits)} بخش ·{" "}
                    {faNumber.format(active.execution.observedRows)} کالا
                    بررسی‌شده
                  </p>
                  <details>
                    <summary>جزئیات به‌روزرسانی</summary>
                    <p>
                      {faNumber.format(active.execution.completedPages)} صفحه
                      دریافت‌شده ·{" "}
                      {faNumber.format(active.execution.observedRows)} رکورد
                      مشاهده‌شده
                    </p>
                    <p>
                      {faNumber.format(active.execution.completedUnits)} از{" "}
                      {faNumber.format(active.execution.totalUnits)} بخش تکمیل
                      شده
                    </p>
                  </details>
                </div>
              )}
              {cancel.error && (
                <p className="form-error">
                  لغو تأیید نشد؛ وضعیت اسکن را بررسی کنید.{" "}
                  {cancel.error.message}
                </p>
              )}
            </div>
            <div>
              <Button
                variant="outline"
                disabled={cancel.isPending}
                onClick={() => cancel.mutate(active.id)}
              >
                {cancel.isPending ? "در حال لغو…" : "لغو به‌روزرسانی"}
              </Button>
              {polling.error && (
                <Button
                  variant="outline"
                  disabled={polling.isFetching}
                  onClick={() => void polling.refetch()}
                >
                  بررسی دوباره وضعیت
                </Button>
              )}
              <Button
                variant="outline"
                size="icon-xs"
                aria-label="نمایش موقعیت اسکن"
                onClick={() => onOpenContext(active)}
              >
                <AppIcon name="location" />
              </Button>
            </div>
          </section>
        </Card>
      )}
      {start.unresolved && start.uncertain && (
        <ReadNotice
          title="نتیجه شروع اسکن مشخص نیست"
          retry={() => void start.reconciliation.refetch()}
          busy={start.reconciliation.isFetching}
        >
          شروع اسکن تأیید نشد. درخواست دیگری ارسال نشده است؛ تاریخچه حساب برای
          پیدا کردن اسکن بررسی می‌شود.{" "}
          {locations.find((l) => l.id === start.uncertain?.target.locationId)
            ?.name ?? "موقعیت درخواست‌شده"}{" "}
          · {sourceLabel(start.uncertain.target.source)} · حداقل{" "}
          {faNumber.format(start.uncertain.target.threshold)}٪.{" "}
          {start.checked && !active && (
            <>
              در آخرین بررسی اسکن تازه‌ای پیدا نشد؛ نتیجه درخواست قبلی همچنان
              نامشخص است.{" "}
              <Button
                variant="outline"
                disabled={start.submitting}
                onClick={start.retryIntent}
              >
                بررسی دوباره درخواست قبلی
              </Button>
            </>
          )}
        </ReadNotice>
      )}
      {start.error && (
        <ReadNotice title="شروع اسکن انجام نشد">
          {start.error.message}
        </ReadNotice>
      )}
    </>
  );
}
