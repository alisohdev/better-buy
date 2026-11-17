import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
type Row = {
  id: string;
  userId: string;
  source: string;
  status: string;
  errorCode: string;
  createdAt: string;
  productCount: number;
  dealCount: number;
};
function rows(value: unknown): Row[] {
  if (!Array.isArray(value)) throw new Error("Invalid admin response");
  return value.map((v: unknown) => {
    if (!v || typeof v !== "object") throw new Error("Invalid row");
    const o = v as Record<string, unknown>;
    for (const k of [
      "id",
      "userId",
      "source",
      "status",
      "errorCode",
      "createdAt",
    ])
      if (typeof o[k] !== "string") throw new Error("Invalid row");
    if (typeof o.productCount !== "number" || typeof o.dealCount !== "number")
      throw new Error("Invalid counts");
    return o as Row;
  });
}
export function AdminScans({ userId = "" }: { userId?: string }) {
  const [inspect, setInspect] = useState<string | null>(null);
  const [productPage, setProductPage] = useState(1);
  const inspected = useQuery({
    queryKey: ["admin", "scan-products", inspect, productPage],
    enabled: !!inspect,
    queryFn: ({ signal }) =>
      api(
        `/api/admin/scans/${encodeURIComponent(inspect!)}/products?page=${productPage}`,
        { signal },
        (value) => {
          if (!Array.isArray(value)) throw new Error("Invalid products");
          return value.map((item: unknown) => {
            if (!item || typeof item !== "object")
              throw new Error("Invalid product");
            const o = item as Record<string, unknown>;
            if (
              typeof o.title !== "string" ||
              typeof o.vendorTitle !== "string" ||
              typeof o.price !== "number" ||
              typeof o.discount !== "number"
            )
              throw new Error("Invalid product");
            return {
              title: o.title,
              vendorTitle: o.vendorTitle,
              price: o.price,
              discount: o.discount,
            };
          });
        }
      ),
  });
  const client = useQueryClient();
  const [selectedUser, setSelectedUser] = useState(userId);
  const [logs, setLogs] = useState(false);
  const [page, setPage] = useState(1);
  const [target, setTarget] = useState<{
    userId?: string;
    scanId?: string;
    label: string;
  } | null>(null);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [notice, setNotice] = useState("");
  const data = useQuery({
    queryKey: ["admin", "scan-manager", selectedUser, logs, page],
    queryFn: ({ signal }) =>
      api(
        `/api/admin/${logs ? "scan-logs" : "scans"}?${new URLSearchParams({ userId: selectedUser, page: String(page) })}`,
        { signal },
        rows
      ),
    refetchInterval: 30000,
  });
  const deletion = useMutation({
    mutationFn: () =>
      api<{ queued: number }>("/api/admin/scans", {
        method: "DELETE",
        body: JSON.stringify({
          userId: target?.userId ?? "",
          scanId: target?.scanId ?? "",
          confirmation,
          password,
        }),
      }),
    onSuccess: (result) => {
      setPassword("");
      setConfirmation("");
      setTarget(null);
      setNotice(
        `${result.queued} اسکن برای حذف ثبت شد. اسکن‌های فعال ابتدا متوقف می‌شوند.`
      );
      void client.invalidateQueries({ queryKey: ["admin"] });
    },
  });
  return (
    <Card className="admin-section">
      <h2>
        {userId ? "اسکن‌ها و گزارش‌های این کاربر" : "مدیریت اسکن‌ها و گزارش‌ها"}
      </h2>
      <p>
        سه اسکن آخر هر موقعیت و فروشگاه تا ۲۴ ساعت؛ گزارش‌های تشخیصی فقط سه روز.
        این نما حساب شما را تغییر نمی‌دهد.
      </p>
      {!userId && (
        <Input
          aria-label="شناسه کاربر برای بررسی"
          value={selectedUser}
          onChange={(e) => {
            setSelectedUser(e.target.value);
            setPage(1);
          }}
          placeholder="شناسه کاربر یا خالی برای همه"
        />
      )}
      <Button
        variant="outline"
        onClick={() => {
          setLogs(!logs);
          setPage(1);
        }}
      >
        {logs ? "نمایش اسکن‌ها" : "گزارش خطاهای سه روز اخیر"}
      </Button>
      <Button
        variant="destructive"
        onClick={() => {
          setTarget({
            userId: selectedUser,
            label: selectedUser
              ? "تمام اسکن‌های این کاربر"
              : "تمام اسکن‌های همه کاربران",
          });
          setNotice("");
        }}
      >
        حذف {selectedUser ? "اسکن‌های کاربر" : "تمام اسکن‌ها"}
      </Button>
      {notice && <p role="status">{notice}</p>}
      {data.isPending && <p>در حال دریافت…</p>}
      {data.error && <p role="alert">دریافت گزارش انجام نشد.</p>}
      <div className="admin-table-wrap">
        <table>
          <thead>
            <tr>
              <th>کاربر / اسکن</th>
              <th>فروشگاه</th>
              <th>وضعیت / خطا</th>
              <th>زمان</th>
              <th>نتیجه</th>
              <th>عملیات</th>
            </tr>
          </thead>
          <tbody>
            {data.data?.map((row) => (
              <tr key={row.id}>
                <td>
                  <button
                    onClick={() => {
                      setSelectedUser(row.userId);
                      setPage(1);
                    }}
                  >
                    {row.userId}
                  </button>
                  <small>
                    <bdi>{row.id}</bdi>
                  </small>
                </td>
                <td>{row.source}</td>
                <td>
                  {row.status}
                  <br />
                  {row.errorCode || "بدون خطای ثبت‌شده"}
                </td>
                <td>{new Date(row.createdAt).toLocaleString("fa-IR")}</td>
                <td>
                  {row.productCount} بررسی / {row.dealCount} پیشنهاد
                </td>
                <td>
                  {!logs && (
                    <Button
                      variant="outline"
                      onClick={() => {
                        setInspect(row.id);
                        setProductPage(1);
                      }}
                    >
                      بررسی نتیجه
                    </Button>
                  )}
                  {!logs && (
                    <Button
                      variant="outline"
                      onClick={() =>
                        setTarget({
                          scanId: row.id,
                          userId: row.userId,
                          label: `اسکن ${row.id}`,
                        })
                      }
                    >
                      حذف اسکن
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!data.isPending && !data.data?.length && (
        <p>موردی برای نمایش وجود ندارد.</p>
      )}
      <Button
        variant="outline"
        disabled={page <= 1}
        onClick={() => setPage(page - 1)}
      >
        قبلی
      </Button>
      <span> صفحه {page} </span>
      <Button
        variant="outline"
        disabled={(data.data?.length ?? 0) < 100}
        onClick={() => setPage(page + 1)}
      >
        بعدی
      </Button>
      {inspect && (
        <section aria-label="بررسی نتیجه کاربر">
          <h3>نتیجه ذخیره‌شده اسکن</h3>
          <p>
            این اطلاعات مربوط به زمان اسکن است؛ قیمت فعلی فروشگاه را تضمین
            نمی‌کند.
          </p>
          {inspected.error && <p role="alert">دریافت نتیجه انجام نشد.</p>}
          {inspected.data?.map((item, index) => (
            <p key={index}>
              {item.title} · {item.vendorTitle} · {item.price} · {item.discount}
              ٪
            </p>
          ))}
          <Button
            disabled={productPage <= 1}
            onClick={() => setProductPage(productPage - 1)}
          >
            قبلی
          </Button>
          <Button
            disabled={(inspected.data?.length ?? 0) < 50}
            onClick={() => setProductPage(productPage + 1)}
          >
            بعدی
          </Button>
          <Button onClick={() => setInspect(null)}>بستن نتیجه</Button>
        </section>
      )}
      {target && (
        <section role="dialog" aria-label="تأیید حذف اسکن">
          <h3>حذف {target.label}</h3>
          <p>
            نتیجه‌ها و داده‌های اسکن حذف می‌شوند؛ حساب‌ها، آدرس‌ها و فهرست خرید
            باقی می‌مانند. این کار قابل بازگشت نیست.
          </p>
          <Input
            type="password"
            autoComplete="current-password"
            aria-label="رمز عبور مدیر"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <Input
            aria-label="عبارت تأیید حذف"
            placeholder="DELETE SCANS"
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
          />
          {deletion.error && (
            <p role="alert">
              درخواست انجام نشد؛ رمز عبور و دسترسی خود را بررسی کنید.
            </p>
          )}
          <Button
            variant="destructive"
            disabled={
              deletion.isPending || confirmation !== "DELETE SCANS" || !password
            }
            onClick={() => deletion.mutate()}
          >
            حذف دائمی
          </Button>
          <Button
            variant="outline"
            disabled={deletion.isPending}
            onClick={() => {
              setTarget(null);
              setPassword("");
              setConfirmation("");
            }}
          >
            انصراف
          </Button>
        </section>
      )}
    </Card>
  );
}
