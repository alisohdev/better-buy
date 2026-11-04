import { useEffect, useState, type ReactNode } from "react";
import { Button } from "../../components/ui/button";
import { Panel, ReadNotice } from "../dashboard/Primitives";
import { faDate, faNumber, money } from "../dashboard/format";
import { safeOfferUrl } from "./contracts";
import { useInbox } from "./useAlerts";

export function NotificationInbox({
  open: controlledOpen,
  onOpenChange,
  trigger,
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger?: ReactNode;
} = {}) {
  const { query, read } = useInbox();
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const unread = query.data?.filter((item) => item.readAt === null).length ?? 0;
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("inbox") === "1" || params.has("notification")) {
      setLocalOpen(true);
      onOpenChange?.(true);
    }
  }, [onOpenChange]);
  return (
    <Panel
      title="صندوق اعلان‌ها"
      open={open}
      onOpenChange={(open) => {
        setLocalOpen(open);
        onOpenChange?.(open);
      }}
      trigger={
        trigger === undefined ? (
          <Button variant="ghost">
            اعلان‌ها
            {unread > 0 ? " (" + faNumber.format(unread) + " خوانده‌نشده)" : ""}
          </Button>
        ) : (
          trigger
        )
      }
    >
      <div className="alerts-content">
        <p className="muted">
          اعلان‌های حساب، حتی بدون فعال‌سازی اعلان مرورگر، اینجا نمایش داده
          می‌شوند.
        </p>
        <Button
          variant="outline"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          تازه‌سازی اعلان‌ها
        </Button>
        {query.isPending && <p role="status">در حال دریافت اعلان‌ها…</p>}
        {query.error && (
          <ReadNotice
            title="اعلان‌ها دریافت نشدند"
            retry={() => void query.refetch()}
            busy={query.isFetching}
          >
            {query.error.message}
          </ReadNotice>
        )}
        {query.data?.length === 0 && (
          <p>
            هنوز اعلانی ندارید. پیشنهادهای مرتبط با علاقه‌مندی‌ها اینجا قرار
            می‌گیرند.
          </p>
        )}
        {read.error && (
          <p role="alert" className="form-error">
            {read.error.message}
          </p>
        )}
        <ul className="inbox-items">
          {query.data?.map((item) => (
            <li
              key={item.id}
              className="inbox-item"
              data-unread={item.readAt === null}
            >
              <article>
                <div className="inbox-heading">
                  <h3>{item.title}</h3>
                  {item.readAt === null && (
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
                  {item.matches.map((match, index) => {
                    const href = safeOfferUrl(match.url);
                    return (
                      <li key={match.phrase + "-" + index}>
                        <strong>{match.title}</strong>
                        <p className="muted">
                          برای «{match.phrase}» ·{" "}
                          {match.source === "okala"
                            ? "اکالا"
                            : match.source === "snappmarket"
                              ? "اسنپ‌مارکت"
                              : match.source === "digikalajet"
                                ? "دیجی‌کالا جت"
                                : match.source}
                        </p>
                        <p>
                          {["okala", "snappmarket", "digikalajet"].includes(
                            match.source
                          )
                            ? money(
                                match.price,
                                match.source as
                                  "okala" | "snappmarket" | "digikalajet"
                              )
                            : faNumber.format(match.price)}{" "}
                          · {faNumber.format(match.discountPercent)}٪ تخفیف
                        </p>
                        {href && <a href={href}>مشاهده نتیجه اسکن</a>}
                      </li>
                    );
                  })}
                </ul>
                <a href={"/?scan=" + encodeURIComponent(item.scanId)}>
                  باز کردن اسکن این اعلان
                </a>
                {item.readAt === null && (
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
      </div>
    </Panel>
  );
}
