import { motion, useReducedMotion } from "framer-motion";
import { AppIcon } from "../dashboard/AppIcon";
import type { ScanRecord } from "@better-buy/shared";
import { Button } from "@/components/ui/button";
import { ProviderMark } from "../dashboard/AppIcon";
import { sourceLabel, faNumber } from "../dashboard/format";
import { useScanProgress, formatScanDuration } from "./progress";
import { useCancelScan } from "./useCancelScan";
export function StickyScanProgress({
  runs,
  history = [],
  completedRuns = [],
  onDismiss,
}: {
  runs: ScanRecord[];
  history?: ScanRecord[];
  completedRuns?: ScanRecord[];
  onDismiss?: () => void;
}) {
  const cancel = useCancelScan();
  const reducedMotion = useReducedMotion();
  const complete = !runs.length;
  const visibleRuns = complete ? completedRuns : runs;
  const percent = useScanProgress(runs, history) ?? 0;
  if (!visibleRuns.length) return null;
  return (
    <motion.aside
      className="sticky-scan-progress"
      data-complete={complete}
      layoutId="scan-progress-panel"
      layout="position"
      transition={
        reducedMotion
          ? { duration: 0 }
          : { type: "spring", stiffness: 280, damping: 30 }
      }
      aria-label={complete ? "نتیجه اسکن" : "اسکن در حال انجام"}
    >
      <div className="sticky-scan-copy">
        <strong>
          {complete ? (
            <span className="scan-finished-mark">
              <AppIcon name="check" />
            </span>
          ) : (
            <span className="scan-loading-dot" aria-hidden="true" />
          )}
          {complete ? "اسکن تمام شد" : "اسکن هنوز ادامه دارد"}
        </strong>
        <p>
          {complete ? (
            "پیشنهادهای دریافت‌شده آماده‌اند."
          ) : (
            <>
              <span>پیشرفت تقریبی</span> <bdi>{faNumber.format(percent)}٪</bdi>
            </>
          )}
        </p>
      </div>
      <div className="sticky-scan-providers" data-count={visibleRuns.length}>
        {visibleRuns.map((run) => (
          <div key={run.id}>
            <ProviderMark source={run.source} />
            <div className="scan-provider-copy">
              <strong>{sourceLabel(run.source)}</strong>
              <small>
                {complete
                  ? `مدت اسکن: ${formatScanDuration(run) ?? "ثبت نشده"}`
                  : run.execution?.cancelRequested
                    ? "در حال توقف…"
                    : run.status === "queued"
                      ? "در انتظار بررسی"
                      : `${faNumber.format(run.productCount)} کالا بررسی شده`}
              </small>
            </div>
            {!complete && (
              <Button
                variant="ghost"
                size="icon"
                aria-label={`توقف اسکن ${sourceLabel(run.source)}`}
                title={`توقف اسکن ${sourceLabel(run.source)}`}
                disabled={cancel.isPending || run.execution?.cancelRequested}
                onClick={() => cancel.mutate(run.id)}
              >
                توقف
              </Button>
            )}
          </div>
        ))}
      </div>
      {complete && (
        <Button
          variant="ghost"
          size="icon"
          className="scan-banner-dismiss"
          aria-label="بستن نتیجه اسکن"
          onClick={onDismiss}
        >
          <AppIcon name="close" />
        </Button>
      )}
      <div
        className="sticky-scan-track"
        role="progressbar"
        aria-label="پیشرفت تقریبی اسکن"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={complete ? 100 : percent}
      >
        <span style={{ width: `${complete ? 100 : percent}%` }} />
      </div>
      <span className="sr-only" role="status">
        {complete ? "اسکن تمام شد." : "بررسی فروشگاه‌ها همچنان ادامه دارد."}
      </span>
      {cancel.error && (
        <p role="alert">توقف اسکن انجام نشد؛ دوباره تلاش کنید.</p>
      )}
    </motion.aside>
  );
}
