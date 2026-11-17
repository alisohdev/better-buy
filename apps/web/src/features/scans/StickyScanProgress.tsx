import type { ScanRecord } from "@better-buy/shared";
import { Button } from "@/components/ui/button";
import { ProviderMark } from "../dashboard/AppIcon";
import { sourceLabel, faNumber } from "../dashboard/format";
import { useCancelScan } from "./useCancelScan";
export function StickyScanProgress({ runs }: { runs: ScanRecord[] }) {
  const cancel = useCancelScan();
  if (!runs.length) return null;
  return (
    <aside className="sticky-scan-progress" aria-label="اسکن در حال انجام">
      <div className="sticky-scan-copy">
        <strong>
          <span className="scan-loading-dot" aria-hidden="true" />
          اسکن هنوز ادامه دارد
        </strong>
        <p>پیشنهادها به‌تدریج اضافه می‌شوند.</p>
      </div>
      <div className="sticky-scan-providers">
        {runs.map((run) => (
          <div key={run.id}>
            <ProviderMark source={run.source} />
            <span>{sourceLabel(run.source)}</span>
            <small>
              {run.execution?.cancelRequested
                ? "در حال توقف…"
                : run.status === "queued"
                  ? "در انتظار بررسی"
                  : `${faNumber.format(run.productCount)} کالا بررسی شده`}
            </small>
            <Button
              variant="ghost"
              disabled={cancel.isPending || run.execution?.cancelRequested}
              onClick={() => cancel.mutate(run.id)}
            >
              توقف
            </Button>
          </div>
        ))}
      </div>
      <div className="sticky-scan-track" aria-hidden="true" />
      <span className="sr-only" role="status">
        بررسی فروشگاه‌ها همچنان ادامه دارد.
      </span>
      {cancel.error && (
        <p role="alert">توقف اسکن انجام نشد؛ دوباره تلاش کنید.</p>
      )}
    </aside>
  );
}
