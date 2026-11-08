"use client";
import { Button } from "@/components/ui/button";

import { useRef, useState } from "react";
import { Dialog } from "radix-ui";

import { faNumber, money, sourceLabel } from "../dashboard/format";
import { RequestFailure } from "../../lib/api";
import { type CartProvider, type useProviderCart } from "./useProviderCart";
import "./provider-cart.css";
import { displayToman } from "@better-buy/shared";
import { ProviderMark } from "../dashboard/AppIcon";

type Controller = ReturnType<typeof useProviderCart>;

export function ProviderCart({
  carts,
  locationId,
  locationName,
  open,
  onOpenChange,
}: {
  carts: { source: CartProvider; controller: Controller }[];
  locationId: string;
  locationName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const controls = useRef(new Map<string, HTMLButtonElement>());
  const rows = carts.flatMap(({ source, controller }) => {
    const data = controller.cart.data;
    return (data?.lines ?? []).map((line) => {
      const store = data?.recommendation.stores.find((store) =>
        store.items.some((item) => item.key === line.key)
      );
      const offer = store?.items.find((item) => item.key === line.key);
      return {
        source,
        controller,
        line,
        store,
        offer,
        id: source + ":" + line.key,
      };
    });
  });
  const priced = rows.filter((row) => row.offer);
  const total = priced.reduce(
    (sum, row) =>
      sum + displayToman(row.offer?.lineTotalRials ?? 0, row.source),
    0
  );
  const originalKnown = priced.every(
    (row) => row.offer?.originalPriceRials !== undefined
  );
  const original = priced.reduce(
    (sum, row) =>
      sum +
      displayToman(
        (row.offer?.originalPriceRials ?? row.offer?.priceRials ?? 0) *
          row.line.quantity,
        row.source
      ),
    0
  );
  const amount = (value: number) => `${faNumber.format(value)} تومان`;
  const loading = carts.some(({ controller }) => controller.cart.isPending);
  const incomplete =
    priced.length !== rows.length ||
    carts.some(({ controller }) => !!controller.cart.error) ||
    loading;
  const after = (id: string, control: string) => () =>
    requestAnimationFrame(() =>
      controls.current.get(id + ":" + control)?.focus()
    );
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Trigger asChild>
        <Button
          variant="outline"
          className="cart-trigger"
          aria-label={`سبد خرید، ${faNumber.format(rows.length)} کالا`}
        >
          <CartIcon />
          <span className="cart-trigger-count" aria-hidden="true">
            {faNumber.format(rows.length)}
          </span>
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="sheet-backdrop cart-backdrop" />
        <Dialog.Content className="provider-cart-drawer" dir="rtl">
          <header className="provider-cart-header">
            <div>
              <Dialog.Title
                ref={titleRef}
                tabIndex={-1}
                className="provider-cart-title"
              >
                سبد خرید
              </Dialog.Title>
              <Dialog.Description className="provider-cart-description">
                همه کالاهای انتخاب‌شده · {locationName}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon" aria-label="بستن سبد">
                ×
              </Button>
            </Dialog.Close>
          </header>
          <div className="provider-cart-scroll" aria-live="polite">
            {carts.map(({ source, controller }) => (
              <div key={source}>
                {controller.cart.error && (
                  <ReadError
                    error={controller.cart.error}
                    busy={controller.cart.isFetching}
                    cached={!!controller.cart.data}
                    retry={() => void controller.cart.refetch()}
                  />
                )}
                {controller.writeError && (
                  <div role="alert" className="cart-read-error">
                    <p>{cartErrorMessage(controller.writeError)}</p>
                    <Button onClick={controller.clearWriteError}>
                      بستن پیام
                    </Button>
                  </div>
                )}
              </div>
            ))}
            {loading && <p role="status">در حال دریافت سبد…</p>}
            {!locationId && (
              <p className="cart-state-note">
                برای مشاهده قیمت‌ها موقعیت تحویل را انتخاب کنید.
              </p>
            )}
            {!loading && !rows.length && (
              <div className="cart-empty">
                <CartIcon />
                <h3>سبد خرید خالی است</h3>
                <p>از پیشنهادهای فروشگاه‌ها کالا اضافه کنید.</p>
              </div>
            )}
            {rows.map(({ id, source, controller, line, store, offer }) => (
              <div key={id} className="unified-cart-item">
                <div className="cart-item-source">
                  <ProviderMark source={source} />
                  <span>
                    {sourceLabel(source)}
                    {store ? ` · ${store.vendorTitle}` : ""}
                  </span>
                </div>
                <CartLineRow
                  line={line}
                  source={source}
                  writing={controller.writePending}
                  unitPrice={offer?.priceRials}
                  subtotal={offer?.lineTotalRials}
                  originalSubtotal={
                    offer?.originalPriceRials === undefined
                      ? undefined
                      : offer.originalPriceRials * line.quantity
                  }
                  reason={
                    controller.cart.data?.recommendation.missingItems.find(
                      (item) => item.key === line.key
                    )?.reason
                  }
                  controlsRef={(_, control) => (node) => {
                    if (node) controls.current.set(id + ":" + control, node);
                    else controls.current.delete(id + ":" + control);
                  }}
                  onQuantity={(quantity, control) =>
                    controller.setQuantity(
                      line.key,
                      quantity,
                      after(id, control)
                    )
                  }
                  onRemove={() => {
                    const index = rows.findIndex((row) => row.id === id);
                    const next = rows[index + 1] ?? rows[index - 1];
                    controller.remove(line.key, () =>
                      requestAnimationFrame(() =>
                        (next
                          ? controls.current.get(next.id + ":minus")
                          : titleRef.current
                        )?.focus()
                      )
                    );
                  }}
                />
                {!offer && (
                  <small className="cart-unpriced">
                    قیمت فعلی این کالا در دسترس نیست و در جمع محاسبه نشده است.
                  </small>
                )}
              </div>
            ))}
          </div>
          <footer className="provider-cart-footer">
            {incomplete && rows.length > 0 && (
              <p className="cart-state-note">
                جمع زیر فقط شامل کالاهای دارای قیمت است.
              </p>
            )}
            <div className="cart-total-line">
              <span>جمع بدون تخفیف</span>
              <del>
                {priced.length && originalKnown ? amount(original) : "—"}
              </del>
            </div>
            <div className="cart-total-line cart-savings">
              <span>سود شما از تخفیف</span>
              <strong>
                {priced.length && originalKnown
                  ? amount(Math.max(0, original - total))
                  : "—"}
              </strong>
            </div>
            <div className="cart-total-line">
              <span>جمع با تخفیف</span>
              <strong>{priced.length ? amount(total) : "—"}</strong>
            </div>
            <Dialog.Close asChild>
              <Button className="cart-continue">ادامه انتخاب کالا</Button>
            </Dialog.Close>
            <small>
              قیمت‌ها مربوط به زمان اسکن هستند؛ پیش از خرید بررسی کنید.
            </small>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function CartWriteNotice({
  controller,
  visible,
}: {
  controller: Controller;
  visible: boolean;
}) {
  if (!visible || !controller.writeError) return null;
  return (
    <div className="cart-write-notice" role="alert">
      <span>{cartErrorMessage(controller.writeError)}</span>
      <Button
        variant="outline"
        onClick={controller.clearWriteError}
        aria-label="بستن پیام سبد"
      >
        بستن
      </Button>
    </div>
  );
}

function CartLineRow({
  line,
  source,
  writing,
  unitPrice,
  subtotal,
  originalSubtotal,
  reason,
  controlsRef,
  onQuantity,
  onRemove,
}: {
  line: {
    key: string;
    title: string;
    image: string | null;
    categoryTitle: string | null;
    quantity: number;
  };
  source: CartProvider;
  writing: boolean;
  unitPrice?: number;
  subtotal?: number;
  originalSubtotal?: number;
  reason?: "insufficient_quantity" | "missing_product";
  controlsRef: (
    key: string,
    control: string
  ) => (node: HTMLButtonElement | null) => void;
  onQuantity: (quantity: number, control: string) => void;
  onRemove: () => void;
}) {
  const [broken, setBroken] = useState(false);
  return (
    <article className="cart-line" data-cart-key={line.key}>
      {line.image && !broken ? (
        <img
          className="cart-product-image"
          src={line.image}
          alt=""
          width={52}
          height={52}
          loading="lazy"
          onError={() => setBroken(true)}
        />
      ) : (
        <span className="cart-product-placeholder" aria-hidden="true">
          کالا
        </span>
      )}
      <div className="cart-line-content">
        <div className="cart-line-heading">
          <strong>
            <bdi>{line.title}</bdi>
          </strong>
        </div>
        {unitPrice !== undefined && line.quantity > 1 && (
          <small>{money(unitPrice, source)} برای هر عدد</small>
        )}
        {reason && (
          <small className="cart-line-reason">
            {reason === "insufficient_quantity"
              ? "تعداد موجود برای این پیشنهاد کافی نیست"
              : "در قیمت‌های مشاهده‌شده پیدا نشد"}
          </small>
        )}
        <div className="cart-line-controls">
          {subtotal !== undefined && (
            <span className="cart-price-stack">
              <strong className="cart-line-price">
                {money(subtotal, source)}
              </strong>
              {originalSubtotal !== undefined &&
                originalSubtotal > subtotal && (
                  <del>{money(originalSubtotal, source)}</del>
                )}
            </span>
          )}
          <div
            className="provider-cart-quantity"
            aria-label={`تعداد ${line.title}`}
            role="group"
          >
            <Button
              variant="ghost"
              className="provider-cart-stepper-leading"
              data-remove={line.quantity === 1 || undefined}
              ref={controlsRef(line.key, "minus")}
              aria-label={
                line.quantity === 1
                  ? `حذف ${line.title} از سبد`
                  : `کم‌کردن تعداد ${line.title}`
              }
              disabled={writing}
              onClick={() =>
                line.quantity === 1
                  ? onRemove()
                  : onQuantity(line.quantity - 1, "minus")
              }
            >
              {line.quantity === 1 ? <TrashIcon /> : <MinusIcon />}
            </Button>
            <span aria-live="polite">{faNumber.format(line.quantity)}</span>
            <Button
              variant="ghost"
              ref={controlsRef(line.key, "plus")}
              aria-label={`زیادکردن تعداد ${line.title}`}
              disabled={writing || line.quantity >= 99}
              onClick={() => onQuantity(line.quantity + 1, "plus")}
            >
              <PlusIcon />
            </Button>
          </div>
        </div>
      </div>
    </article>
  );
}

function ReadError({
  error,
  busy,
  retry,
  cached = false,
}: {
  error: unknown;
  busy: boolean;
  retry: () => void;
  cached?: boolean;
}) {
  return (
    <div className="cart-read-error" role={cached ? "status" : "alert"}>
      <p>
        {cartErrorMessage(error)}
        {cached && " اطلاعات قبلی سبد نمایش داده می‌شود."}
      </p>
      <Button variant="outline" disabled={busy} onClick={retry}>
        {busy ? "در حال دریافت…" : "تلاش دوباره"}
      </Button>
    </div>
  );
}

function cartErrorMessage(error: unknown): string {
  const code = error instanceof RequestFailure ? error.code : undefined;
  switch (code) {
    case "CART_LIMIT":
      return "این سبد به سقف ۲۴ کالا رسیده است. برای افزودن کالای دیگر، یکی را حذف کنید.";
    case "PRODUCT_UNAVAILABLE":
      return "این کالا با تعداد انتخاب‌شده در اسکن فعلی موجود نیست. نتیجه تازه را بررسی کنید.";
    case "STALE_SCAN":
      return "موقعیت تحویل از زمان این اسکن تغییر کرده است. یک اسکن تازه لازم است.";
    case "SCAN_NOT_PUBLISHED":
    case "PROJECTION_PENDING":
      return "نتیجه هنوز آماده نیست. کمی بعد دوباره تلاش کنید.";
    case "NOT_FOUND":
      return "کالا یا موقعیت پیدا نشد؛ سبد را تازه‌سازی کنید.";
    case "UNAUTHENTICATED":
      return "نشست ورود شما پایان یافته است. دوباره وارد شوید.";
    case "CART_READ_ERROR":
      return "پیشنهاد فروشگاه‌ها آماده نشد. دوباره تلاش کنید.";
    default:
      return error instanceof Error
        ? error.message
        : "تغییر سبد ذخیره نشد. دوباره تلاش کنید.";
  }
}

function CartIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 4h2l2.2 10.2a2 2 0 0 0 2 1.6h7.4a2 2 0 0 0 1.9-1.4L20 8H6" />
      <circle cx="10" cy="20" r="1" />
      <circle cx="18" cy="20" r="1" />
    </svg>
  );
}

function MinusIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
    >
      <path d="M4 10h12" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
    >
      <path d="M4 10h12M10 4v12" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3" />
    </svg>
  );
}
