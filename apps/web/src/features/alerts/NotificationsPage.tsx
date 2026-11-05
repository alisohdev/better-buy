import { Button } from "../../components/ui/button";
import { faDate, faNumber } from "../dashboard/format";
import { useInbox } from "./useAlerts";

export function NotificationsPage() {
  const { query, read } = useInbox();
  return (
    <main className="notification-page" dir="rtl">
      <header className="notification-page-header">
        <a href="/">بازگشت به پیشنهادها</a>
        <h1>اعلان‌ها</h1>
        <p>پیشنهادهای ذخیره‌شده برای علاقه‌مندی‌های شما</p>
      </header>
      <div className="notification-page-toolbar">
        <span>
          {query.data
            ? `${faNumber.format(query.data.filter((item) => !item.readAt).length)} خوانده‌نشده`
            : ""}
        </span>
        <Button
          variant="outline"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          تازه‌سازی
        </Button>
      </div>
      {query.isPending && <p role="status">در حال دریافت اعلان‌ها…</p>}
      {query.error && (
        <p role="alert">
          دریافت اعلان‌ها انجام نشد.{" "}
          <Button onClick={() => void query.refetch()}>تلاش دوباره</Button>
        </p>
      )}
      {query.data?.length === 0 && (
        <p>
          هنوز اعلانی ندارید. پیشنهادهای مرتبط با علاقه‌مندی‌ها اینجا نمایش داده
          می‌شوند.
        </p>
      )}
      {read.error && <p role="alert">ثبت وضعیت خواندن انجام نشد.</p>}
      <ul className="inbox-items">
        {query.data?.map((item) => (
          <li
            key={item.id}
            className="inbox-item"
            data-unread={item.readAt === null}
          >
            <article>
              <div className="inbox-heading">
                <h2>{item.title}</h2>
                {!item.readAt && (
                  <strong className="unread-label">خوانده‌نشده</strong>
                )}
              </div>
              <p>{item.body}</p>
              <time dateTime={item.createdAt}>
                {Number.isNaN(Date.parse(item.createdAt))
                  ? item.createdAt
                  : faDate.format(new Date(item.createdAt))}
              </time>
              <ul className="notification-matches">
                {item.matches.map((match, index) => (
                  <li key={`${match.phrase}-${index}`}>
                    <strong>{match.title}</strong>
                    <p>
                      {match.source === "snappmarket"
                        ? "اسنپ‌مارکت"
                        : match.source === "okala"
                          ? "اکالا"
                          : match.source}
                      {match.vendorTitle ? ` · ${match.vendorTitle}` : ""}
                    </p>
                    <p>
                      {faNumber.format(match.price)} تومان ·{" "}
                      {faNumber.format(match.discountPercent)}٪ تخفیف
                    </p>
                    <a
                      href={
                        match.productKey
                          ? `/?page=product&scan=${encodeURIComponent(item.scanId)}&product=${encodeURIComponent(match.productKey)}`
                          : `/?scan=${encodeURIComponent(item.scanId)}`
                      }
                    >
                      {match.productKey
                        ? "مشاهده جزئیات کالا"
                        : "مشاهده نتیجه اسکن"}
                    </a>
                  </li>
                ))}
              </ul>
              <a href={`/?scan=${encodeURIComponent(item.scanId)}`}>
                باز کردن اسکن
              </a>
              {!item.readAt && (
                <Button
                  variant="outline"
                  disabled={read.isPending}
                  onClick={() => read.mutate(item.id)}
                >
                  علامت‌گذاری به‌عنوان خوانده‌شده
                </Button>
              )}
            </article>
          </li>
        ))}
      </ul>
    </main>
  );
}
