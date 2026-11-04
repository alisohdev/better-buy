"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Panel } from "../dashboard/Primitives";
import { faDate, faNumber } from "../dashboard/format";
import {
  useAdminOverview,
  useAdminUser,
  useAdminUsers,
} from "./useAdminAnalytics";
import "./admin.css";

const date = (value: string | null) =>
  value ? faDate.format(new Date(value)) : "ثبت نشده";
const provider = (source: string) =>
  source === "all"
    ? "همه فروشگاه‌ها"
    : source === "okala"
      ? "اکالا"
      : source === "digikalajet"
        ? "جت"
        : "اسنپ‌مارکت";
const dayDate = new Intl.DateTimeFormat("fa-IR", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

function ReadError({ retry }: { retry: () => void }) {
  return (
    <div className="admin-read-error" role="alert">
      <p>دریافت اطلاعات انجام نشد. اتصال و دسترسی حساب را بررسی کنید.</p>
      <Button variant="outline" onClick={retry}>
        دریافت دوباره
      </Button>
    </div>
  );
}

function UserDetails({ id, email }: { id: string; email: string }) {
  const [open, setOpen] = useState(false);
  const detail = useAdminUser(open ? id : null);
  const data = detail.data;
  return (
    <Panel
      title="جزئیات کاربر"
      trigger={
        <Button variant="link" className="admin-email">
          <bdi>{email}</bdi>
        </Button>
      }
      open={open}
      onOpenChange={setOpen}
    >
      {detail.isPending && <p role="status">در حال دریافت اطلاعات کاربر…</p>}
      {detail.isError && !data && (
        <ReadError retry={() => void detail.refetch()} />
      )}
      {data && (
        <div className="admin-user-detail">
          {detail.isError && <ReadError retry={() => void detail.refetch()} />}
          <header>
            <strong>{data.user.name}</strong>
            <p>
              <bdi>{data.user.email}</bdi>
            </p>
            <small>
              {data.user.emailVerified ? "ایمیل تأیید شده" : "ایمیل تأیید نشده"}{" "}
              · عضویت: {date(data.user.createdAt)}
            </small>
          </header>
          <dl className="admin-user-counts">
            <div>
              <dt>اسکن‌ها</dt>
              <dd>{faNumber.format(data.user.scans)}</dd>
            </div>
            <div>
              <dt>بازدیدها</dt>
              <dd>{faNumber.format(data.user.visits)}</dd>
            </div>
            <div>
              <dt>جست‌وجوها</dt>
              <dd>{faNumber.format(data.user.searches)}</dd>
            </div>
          </dl>
          <section>
            <h3>موقعیت‌های ذخیره‌شده</h3>
            {data.locations.length ? (
              <ul className="admin-detail-list">
                {data.locations.map((location) => (
                  <li key={location.id}>
                    <strong>{location.name}</strong>
                    {location.isDefault && <small>پیش‌فرض</small>}
                    <bdi dir="ltr">
                      {location.latitude.toFixed(6)},{" "}
                      {location.longitude.toFixed(6)}
                    </bdi>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="admin-empty">موقعیتی ذخیره نشده است.</p>
            )}
          </section>
          <section>
            <h3>علاقه‌مندی‌ها</h3>
            {data.wishlist.length ? (
              <ul className="admin-detail-list">
                {data.wishlist.map((item) => (
                  <li key={item.id}>
                    <span>
                      {item.phrase} · حداقل {faNumber.format(item.minDiscount)}٪
                      تخفیف
                    </span>
                    <small>{date(item.createdAt)}</small>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="admin-empty">فهرست علاقه‌مندی‌ها خالی است.</p>
            )}
          </section>
          <section>
            <h3>سبدهای خرید</h3>
            {data.cart.length ? (
              <ul className="admin-detail-list">
                {data.cart.map((item) => (
                  <li key={`${item.source}:${item.key}`}>
                    <strong>{item.title}</strong>
                    <span>
                      {provider(item.source)} · تعداد{" "}
                      {faNumber.format(item.quantity)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="admin-empty">سبدهای خرید خالی هستند.</p>
            )}
          </section>
          <section>
            <h3>۳۰ جست‌وجوی اخیر</h3>
            {data.recentSearches.length ? (
              <ol className="admin-detail-list">
                {data.recentSearches.map((item, index) => (
                  <li key={`${item.createdAt}:${index}`}>
                    <strong>{item.query}</strong>
                    <small>
                      {provider(item.source)} · {date(item.createdAt)}
                    </small>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="admin-empty">جست‌وجویی ثبت نشده است.</p>
            )}
          </section>
        </div>
      )}
    </Panel>
  );
}

export function AdminDashboard({ onClose }: { onClose: () => void }) {
  const overview = useAdminOverview();
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const users = useAdminUsers(search, page);
  const data = overview.data;
  const userPage = users.data;
  const pages = userPage
    ? Math.max(1, Math.ceil(userPage.total / userPage.pageSize))
    : 1;
  return (
    <div className="admin-dashboard" dir="rtl">
      <header className="admin-heading">
        <div>
          <h1>مدیریت بهتر بخر</h1>
          <p>آمار استفاده و اطلاعات حساب‌ها</p>
        </div>
        <div className="admin-actions">
          <Button
            variant="outline"
            disabled={overview.isFetching || users.isFetching}
            onClick={() => {
              void overview.refetch();
              void users.refetch();
            }}
          >
            به‌روزرسانی
          </Button>
          <Button variant="ghost" onClick={onClose}>
            بازگشت به پیشنهادها
          </Button>
        </div>
      </header>
      {overview.isPending && <p role="status">در حال دریافت آمار…</p>}
      {overview.isError && <ReadError retry={() => void overview.refetch()} />}
      {data && (
        <>
          <Card className="admin-summary">
            <dl>
              {[
                ["بازدیدها", data.totals.visits],
                ["بازدیدکنندگان", data.totals.visitors],
                ["جست‌وجوها", data.totals.searches],
                ["حساب‌های کاربری", data.totals.users],
                ["اسکن‌ها", data.totals.scans],
                ["موقعیت‌های ذخیره‌شده", data.totals.locations],
                ["عبارت‌های علاقه‌مندی", data.totals.wishlistItems],
                ["کالاهای سبد خرید", data.totals.cartItems],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>
                    {typeof value === "number" ? faNumber.format(value) : value}
                  </dd>
                </div>
              ))}
            </dl>
            <p>
              بازدیدکنندگان، تعداد مرورگرهای متمایز هستند و با تعداد حساب‌ها
              تفاوت دارند. تعداد کالاهای سبد، مجموع تعداد انتخاب‌شده است.
            </p>
            <small>
              {data.trackingSince
                ? `ثبت بازدید و جست‌وجو از ${date(data.trackingSince)}`
                : "ثبت بازدید و جست‌وجو هنوز آغاز نشده است."}{" "}
              · آخرین دریافت: {date(data.generatedAt)}
            </small>
          </Card>
          <div className="admin-activity-grid">
            <Card className="admin-section admin-top-searches">
              <h2>جست‌وجوهای پرتکرار</h2>
              {data.topSearches.length ? (
                <div className="admin-table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">عبارت</th>
                        <th scope="col">جست‌وجو</th>
                        <th scope="col">کاربر</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.topSearches.map((item) => (
                        <tr key={item.query}>
                          <th scope="row">{item.query}</th>
                          <td>{faNumber.format(item.searches)}</td>
                          <td>{faNumber.format(item.users)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="admin-empty">
                  پس از جست‌وجوی کاربران، عبارت‌های پرتکرار اینجا نمایش داده
                  می‌شوند.
                </p>
              )}
            </Card>
            <Card className="admin-section">
              <h2>فعالیت ۳۰ روز اخیر</h2>
              <p className="admin-note">
                روزها بر اساس ساعت جهانی (UTC) هستند.
              </p>
              <div
                className="admin-table-wrap admin-daily-table"
                tabIndex={0}
                role="region"
                aria-label="آمار روزانه"
              >
                <table>
                  <thead>
                    <tr>
                      <th scope="col">روز</th>
                      <th scope="col">بازدید</th>
                      <th scope="col">بازدیدکننده</th>
                      <th scope="col">جست‌وجو</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...data.days].reverse().map((day) => (
                      <tr key={day.date}>
                        <th scope="row">
                          <time dateTime={day.date}>
                            {dayDate.format(new Date(`${day.date}T00:00:00Z`))}
                          </time>
                        </th>
                        <td>{faNumber.format(day.visits)}</td>
                        <td>{faNumber.format(day.visitors)}</td>
                        <td>{faNumber.format(day.searches)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </div>
        </>
      )}
      <Card className="admin-section admin-users">
        <div className="admin-users-heading">
          <h2>
            کاربران{" "}
            {userPage && <small>({faNumber.format(userPage.total)})</small>}
          </h2>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setSearch(draft.trim());
              setPage(1);
            }}
          >
            <label htmlFor="admin-user-search" className="sr-only">
              جست‌وجو با ایمیل یا نام
            </label>
            <Input
              id="admin-user-search"
              type="search"
              maxLength={120}
              value={draft}
              placeholder="ایمیل یا نام کاربر"
              onChange={(event) => setDraft(event.target.value)}
            />
            <Button variant="outline" type="submit">
              جست‌وجو
            </Button>
            {search && (
              <Button
                variant="ghost"
                onClick={() => {
                  setSearch("");
                  setDraft("");
                  setPage(1);
                }}
                type="button"
              >
                پاک کردن
              </Button>
            )}
          </form>
        </div>
        {users.isPending && <p role="status">در حال دریافت کاربران…</p>}
        {users.isError && <ReadError retry={() => void users.refetch()} />}
        {userPage && (
          <>
            {userPage.users.length ? (
              <div
                className="admin-table-wrap"
                tabIndex={0}
                role="region"
                aria-label="فهرست کاربران"
              >
                <table className="admin-user-table">
                  <thead>
                    <tr>
                      <th scope="col">حساب کاربری</th>
                      <th scope="col">عضویت</th>
                      <th scope="col">اسکن</th>
                      <th scope="col">موقعیت</th>
                      <th scope="col">علاقه‌مندی</th>
                      <th scope="col">کالای سبد</th>
                      <th scope="col">بازدید</th>
                      <th scope="col">جست‌وجو</th>
                    </tr>
                  </thead>
                  <tbody>
                    {userPage.users.map((user) => (
                      <tr key={user.id}>
                        <th scope="row">
                          <UserDetails id={user.id} email={user.email} />
                          <small>{user.name}</small>
                        </th>
                        <td>
                          <time dateTime={user.createdAt}>
                            {date(user.createdAt)}
                          </time>
                        </td>
                        <td>{faNumber.format(user.scans)}</td>
                        <td>{faNumber.format(user.locations)}</td>
                        <td>{faNumber.format(user.wishlistItems)}</td>
                        <td>{faNumber.format(user.cartItems)}</td>
                        <td>{faNumber.format(user.visits)}</td>
                        <td>{faNumber.format(user.searches)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="admin-empty">کاربری با این مشخصات پیدا نشد.</p>
            )}
            <footer className="admin-pagination">
              <span>
                صفحه {faNumber.format(page)} از {faNumber.format(pages)}
              </span>
              <div>
                <Button
                  variant="outline"
                  disabled={page <= 1 || users.isFetching}
                  onClick={() => setPage((value) => value - 1)}
                >
                  قبلی
                </Button>
                <Button
                  variant="outline"
                  disabled={page >= pages || users.isFetching}
                  onClick={() => setPage((value) => value + 1)}
                >
                  بعدی
                </Button>
              </div>
            </footer>
          </>
        )}
      </Card>
    </div>
  );
}
