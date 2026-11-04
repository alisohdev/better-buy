import { Button } from "../../components/ui/button";
import { sourceLabel } from "../dashboard/format";
import type { useDevWishlistScan } from "./useDevWishlistScan";

export function DevWishlistScan({
  canStart,
  scan,
}: {
  canStart: boolean;
  scan: ReturnType<typeof useDevWishlistScan>;
}) {
  return (
    <section
      className="dev-wishlist-scan"
      aria-label="اسکن آزمایشی علاقه‌مندی‌ها"
    >
      <h3>آزمایش اسکن علاقه‌مندی‌ها</h3>
      <p className="muted">
        اسکن کامل اسنپ‌مارکت و اکالا برای حساب شما، با موقعیت انتخاب‌شده اجرا
        می‌شود.
      </p>
      <Button
        type="button"
        disabled={!canStart || !scan.ready || scan.running}
        onClick={scan.start}
      >
        {scan.running
          ? "در حال اجرای اسکن علاقه‌مندی‌ها…"
          : "اجرای اسکن علاقه‌مندی‌ها اکنون"}
      </Button>
      {!canStart && (
        <p>برای اجرا، حداقل یک عبارت و یک موقعیت معتبر انتخاب کنید.</p>
      )}
      {scan.error && (
        <div role="alert">
          <p>{scan.error}</p>
          <Button variant="outline" onClick={scan.resume}>
            ادامه دریافت وضعیت
          </Button>
        </div>
      )}
      <ol className="dev-wishlist-progress" aria-live="polite">
        {scan.run?.steps.map((step) => {
          const result = step.result;
          const status = result?.status;
          return (
            <li key={step.source}>
              <strong>{sourceLabel(step.source)}</strong>
              {!result && <p>در انتظار شروع</p>}
              {(status === "queued" || status === "running") && (
                <p>اسکن در حال اجراست.</p>
              )}
              {status === "processing" && (
                <p>در حال آماده‌سازی نتیجه و اعلان…</p>
              )}
              {(result?.status === "failed" ||
                result?.status === "cancelled") && (
                <p className="form-error">
                  {result.errorMessage &&
                  /[\u0600-\u06ff]/.test(result.errorMessage)
                    ? result.errorMessage
                    : "اسکن فروشگاه کامل نشد؛ می‌توانید دوباره تلاش کنید."}
                  {result.errorCode && (
                    <span dir="ltr"> ({result.errorCode})</span>
                  )}
                </p>
              )}
              {result?.status === "succeeded" && (
                <>
                  <p>اسکن کامل شد.</p>
                  {result.notification ? (
                    <article>
                      <strong>{result.notification.title}</strong>
                      <p>{result.notification.body}</p>
                      <ul>
                        {result.notification.matches.map((match, index) => (
                          <li key={index}>{match.title}</li>
                        ))}
                      </ul>
                      <a
                        href={`/?notification=${encodeURIComponent(result.notification.id)}`}
                      >
                        مشاهده در صندوق اعلان‌ها
                      </a>
                    </article>
                  ) : (
                    <p>
                      پیشنهاد تازه یا ارزان‌تری پیدا نشد؛ اعلان جدیدی ایجاد نشد.
                    </p>
                  )}
                </>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
