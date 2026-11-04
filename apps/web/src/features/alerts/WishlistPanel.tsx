import { useEffect, useState, type ReactNode } from "react";
import type { LocationRecord } from "@better-buy/shared";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Panel, ReadNotice } from "../dashboard/Primitives";
import { useWishlist } from "./useAlerts";
import { PushSettings } from "./PushSettings";
import { DevWishlistScan } from "./DevWishlistScan";
import { useDevWishlistScan } from "./useDevWishlistScan";
import type { WishlistItem } from "./contracts";
import { faNumber } from "../dashboard/format";
import "./alerts.css";

export function WishlistPanel({
  locations,
  locationsReady,
  open,
  onOpenChange,
  trigger = <Button variant="ghost">علاقه‌مندی‌ها</Button>,
}: {
  locations: LocationRecord[];
  locationsReady: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger?: ReactNode;
}) {
  const { query, mutation } = useWishlist();
  const devEnabled =
    process.env.NODE_ENV === "development" &&
    query.data?.devScanEnabled === true;
  const devScan = useDevWishlistScan(devEnabled);
  const [phrase, setPhrase] = useState("");
  const [minDiscount, setMinDiscount] = useState(15);
  const [notice, setNotice] = useState("");
  const savedLocation = query.data?.defaultLocationId;
  const missingLocation =
    savedLocation &&
    locationsReady &&
    !locations.some((location) => location.id === savedLocation);
  return (
    <Panel
      title="فهرست علاقه‌مندی‌ها"
      trigger={trigger}
      open={open}
      onOpenChange={onOpenChange}
    >
      <div className="alerts-content">
        <p className="muted">
          عبارت‌های دلخواه را ثبت کنید تا پیشنهادهای مرتبط را زودتر ببینید.
        </p>
        <p>اسکن زمان‌بندی‌شده: هر روز ساعت ۹ و ۱۸ به وقت تهران</p>
        {query.data?.scheduleEnabled === false && (
          <ReadNotice title="اسکن زمان‌بندی‌شده هنوز فعال نیست">
            زمان‌بندی از سمت سرویس غیرفعال است؛ می‌توانید علاقه‌مندی‌ها و موقعیت
            را برای زمان فعال‌سازی آماده کنید.
          </ReadNotice>
        )}
        {query.isPending && <p role="status">در حال دریافت علاقه‌مندی‌ها…</p>}
        {query.error && (
          <ReadNotice
            title="علاقه‌مندی‌ها دریافت نشدند"
            retry={() => void query.refetch()}
            busy={query.isFetching}
          >
            {query.error.message}
          </ReadNotice>
        )}
        {query.data && (
          <>
            <form
              className="wishlist-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (!phrase.trim() || mutation.isPending) return;
                setNotice("");
                mutation.mutate(
                  { kind: "add", phrase: phrase.trim(), minDiscount },
                  {
                    onSuccess: () => {
                      setPhrase("");
                      setNotice("عبارت اضافه شد.");
                    },
                  }
                );
              }}
            >
              <label htmlFor="wishlist-phrase">نام کالا یا عبارت دلخواه</label>
              <div className="alerts-actions">
                <Input
                  id="wishlist-phrase"
                  value={phrase}
                  onChange={(event) => setPhrase(event.target.value)}
                  placeholder="مثلاً چای ایرانی"
                  disabled={mutation.isPending}
                />
                <Button
                  type="submit"
                  disabled={!phrase.trim() || mutation.isPending}
                >
                  افزودن
                </Button>
              </div>
              <div className="wishlist-discount">
                <label htmlFor="wishlist-min-discount">
                  حداقل تخفیف برای اعلان: {faNumber.format(minDiscount)}٪
                </label>
                <Input
                  id="wishlist-min-discount"
                  type="range"
                  min={15}
                  max={80}
                  step={1}
                  value={minDiscount}
                  onChange={(event) =>
                    setMinDiscount(Number(event.target.value))
                  }
                  disabled={mutation.isPending}
                />
                <p className="muted">
                  برای هر عبارت، تخفیف بین ۱۵ تا ۸۰ درصد را انتخاب کنید.
                </p>
              </div>
            </form>
            {query.data.items.length === 0 ? (
              <p className="muted">هنوز عبارتی ثبت نکرده‌اید.</p>
            ) : (
              <ul className="wishlist-items">
                {query.data.items.map((item) => (
                  <WishlistRow
                    key={item.id}
                    item={item}
                    busy={mutation.isPending}
                    onDiscount={(minDiscount) => {
                      setNotice("");
                      mutation.mutate(
                        { kind: "discount", id: item.id, minDiscount },
                        { onSuccess: () => setNotice("حداقل تخفیف ذخیره شد.") }
                      );
                    }}
                    onDelete={() => {
                      setNotice("");
                      mutation.mutate(
                        { kind: "delete", id: item.id },
                        { onSuccess: () => setNotice("عبارت حذف شد.") }
                      );
                    }}
                  />
                ))}
              </ul>
            )}
            <div className="wishlist-location">
              <label htmlFor="wishlist-location">
                موقعیت اسکن زمان‌بندی‌شده
              </label>
              <select
                id="wishlist-location"
                value={savedLocation ?? ""}
                disabled={!locationsReady || mutation.isPending}
                onChange={(event) => {
                  setNotice("");
                  mutation.mutate(
                    {
                      kind: "location",
                      locationId: event.target.value || null,
                    },
                    { onSuccess: () => setNotice("موقعیت اسکن ذخیره شد.") }
                  );
                }}
              >
                <option value="">غیرفعال؛ بدون موقعیت</option>
                {missingLocation && (
                  <option value={savedLocation}>
                    موقعیت قبلی در دسترس نیست
                  </option>
                )}
                {locations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name}
                  </option>
                ))}
              </select>
              <p className="muted">
                این انتخاب مستقل از موقعیت نمایش پیشنهادهاست. برای اسکن خودکار
                یک موقعیت انتخاب کنید.
              </p>
              {!locationsReady && (
                <p role="status">
                  برای انتخاب موقعیت، ابتدا دریافت موقعیت‌ها باید کامل شود.
                </p>
              )}
            </div>
          </>
        )}
        {mutation.error && (
          <p className="form-error" role="alert">
            {mutation.error.message}
          </p>
        )}
        <p role="status">{mutation.isPending ? "در حال ذخیره…" : notice}</p>
        {devEnabled && (
          <DevWishlistScan
            scan={devScan}
            canStart={
              !!query.data?.items.length &&
              !!savedLocation &&
              !missingLocation &&
              locationsReady &&
              !mutation.isPending
            }
          />
        )}
        <PushSettings
          publicKey={query.data?.pushPublicKey ?? null}
          loading={query.isPending}
        />
      </div>
    </Panel>
  );
}

function WishlistRow({
  item,
  busy,
  onDiscount,
  onDelete,
}: {
  item: WishlistItem;
  busy: boolean;
  onDiscount: (minDiscount: number) => void;
  onDelete: () => void;
}) {
  const [minDiscount, setMinDiscount] = useState(item.minDiscount);
  useEffect(() => setMinDiscount(item.minDiscount), [item.minDiscount]);
  return (
    <li>
      <form
        className="wishlist-item-settings"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && minDiscount !== item.minDiscount)
            onDiscount(minDiscount);
        }}
      >
        <strong>{item.phrase}</strong>
        <label htmlFor={"wishlist-discount-" + item.id}>
          حداقل تخفیف: {faNumber.format(minDiscount)}٪
        </label>
        <Input
          id={"wishlist-discount-" + item.id}
          type="range"
          min={15}
          max={80}
          step={1}
          value={minDiscount}
          onChange={(event) => setMinDiscount(Number(event.target.value))}
          disabled={busy}
        />
        <div className="alerts-actions">
          <Button
            type="submit"
            variant="outline"
            disabled={busy || minDiscount === item.minDiscount}
            aria-label={"ذخیره حداقل تخفیف " + item.phrase}
          >
            ذخیره تخفیف
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            aria-label={"حذف " + item.phrase}
            onClick={onDelete}
          >
            حذف
          </Button>
        </div>
      </form>
    </li>
  );
}
