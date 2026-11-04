"use client";
import { Button } from "@/components/ui/button";

import { useRef, useState } from "react";
import { Dialog } from "radix-ui";
import type {
  CartAssignedItem,
  CartLine,
  CartMissingItem,
  CartStoreRecommendation,
} from "@better-buy/shared";
import { faDate, faNumber, money, sourceLabel } from "../dashboard/format";
import { RequestFailure } from "../../lib/api";
import { type CartProvider, type useProviderCart } from "./useProviderCart";
import "./provider-cart.css";

type Controller = ReturnType<typeof useProviderCart>;

export function ProviderCart({
  source,
  locationId,
  locationName,
  controller,
  open,
  onOpenChange,
}: {
  source: CartProvider;
  locationId: string;
  locationName: string;
  controller: Controller;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const response = controller.cart.data;
  const titleRef = useRef<HTMLHeadingElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const rowControls = useRef(new Map<string, Map<string, HTMLButtonElement>>());
  const count = response?.lines.length ?? 0;
  const shouldRestoreFocus = (origin: Element | null) => {
    const active = document.activeElement;
    const disabledOrigin =
      origin instanceof HTMLButtonElement && origin.disabled;
    return (
      active === document.body ||
      active === contentRef.current ||
      (active === origin && disabledOrigin)
    );
  };
  const focusAfterMutation = (key: string, control: string) => {
    const origin = document.activeElement;
    return () => {
      requestAnimationFrame(() => {
        if (!shouldRestoreFocus(origin)) return;
        const controls = rowControls.current.get(key);
        const fallback = control === "minus" ? "plus" : "minus";
        const target = [controls?.get(control), controls?.get(fallback)].find(
          (button) => button && !button.disabled
        );
        target?.focus();
      });
    };
  };
  const refFor =
    (key: string, control: string) => (node: HTMLButtonElement | null) => {
      const controls = rowControls.current.get(key) ?? new Map();
      if (node) controls.set(control, node);
      else controls.delete(control);
      if (controls.size) rowControls.current.set(key, controls);
      else rowControls.current.delete(key);
    };
  const lines = response?.lines ?? [];
  const assigned = new Map<string, CartAssignedItem>();
  response?.recommendation.stores.forEach((store) =>
    store.items.forEach((item) => assigned.set(item.key, item))
  );
  const missing = new Map<string, CartMissingItem>(
    response?.recommendation.missingItems.map((item) => [item.key, item]) ?? []
  );
  const unassigned = lines.filter((line) => !assigned.has(line.key));
  const assignedKeys = new Set(assigned.keys());
  const totalLabel =
    response?.recommendation.status === "partial"
      ? "جمع اقلام دارای پیشنهاد"
      : "جمع قیمت‌های مشاهده‌شده";
  const footerLabel = response?.recommendation.missingItems.length
    ? "جمع اقلام دارای پیشنهاد"
    : totalLabel;

  const removeLine = (key: string) => {
    const origin = document.activeElement;
    const index = lines.findIndex((line) => line.key === key);
    const nextKey = lines[index + 1]?.key ?? lines[index - 1]?.key;
    controller.remove(key, () => {
      requestAnimationFrame(() => {
        if (!shouldRestoreFocus(origin)) return;
        const nextControl = nextKey
          ? rowControls.current.get(nextKey)
          : undefined;
        const nextTarget = [
          nextControl?.get("minus"),
          nextControl?.get("plus"),
        ].find((button) => button && !button.disabled);
        (nextTarget ?? titleRef.current)?.focus();
      });
    });
  };

  return (
    <>
      <Dialog.Root open={open} onOpenChange={onOpenChange}>
        <Dialog.Trigger asChild>
          <Button
            variant="outline"
            className="cart-trigger"
            aria-label={`سبد ${sourceLabel(source)}، ${faNumber.format(count)} کالا`}
          >
            <CartIcon />
            <span className="cart-trigger-count" aria-hidden="true">
              {faNumber.format(count)}
            </span>
          </Button>
        </Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Overlay className="sheet-backdrop cart-backdrop" />
          <Dialog.Content
            ref={contentRef}
            className="provider-cart-drawer"
            dir="rtl"
          >
            <header className="provider-cart-header">
              <div>
                <Dialog.Title
                  ref={titleRef}
                  tabIndex={-1}
                  className="provider-cart-title"
                >
                  سبد {sourceLabel(source)}
                </Dialog.Title>
                <Dialog.Description className="provider-cart-description">
                  کالاها برای هر ارائه‌دهنده جداگانه ذخیره می‌شوند.
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="cart-close"
                  aria-label="بستن سبد"
                >
                  ×
                </Button>
              </Dialog.Close>
            </header>
            {open && controller.writeError && (
              <div
                className="cart-read-error cart-drawer-write-error"
                role="alert"
              >
                <p>{cartErrorMessage(controller.writeError)}</p>
                <Button variant="outline" onClick={controller.clearWriteError}>
                  بستن پیام
                </Button>
              </div>
            )}

            <div className="provider-cart-scroll" aria-live="polite">
              {!locationId ? (
                <p className="cart-state-note">
                  برای پیشنهاد فروشگاه، موقعیت تحویل را انتخاب کنید. کالاهای
                  ذخیره‌شده در سبد باقی می‌مانند.
                </p>
              ) : controller.cart.isPending ? (
                <p role="status" className="cart-state-note">
                  در حال دریافت سبد و قیمت‌های این موقعیت…
                </p>
              ) : controller.cart.error && !response ? (
                <ReadError
                  error={controller.cart.error}
                  busy={controller.cart.isFetching}
                  retry={() => void controller.cart.refetch()}
                />
              ) : response ? (
                <>
                  {controller.cart.error && (
                    <ReadError
                      error={controller.cart.error}
                      busy={controller.cart.isFetching}
                      cached
                      retry={() => void controller.cart.refetch()}
                    />
                  )}
                  {response.recommendation.status === "empty" ? (
                    <div className="cart-empty">
                      <span className="cart-empty-icon">
                        <CartIcon />
                      </span>
                      <h3>سبد {sourceLabel(source)} خالی است</h3>
                      <p>
                        از پیشنهادهای همین ارائه‌دهنده کالا اضافه کنید. سبد
                        اسنپ‌مارکت و اکالا جداگانه ذخیره می‌شوند.
                      </p>
                    </div>
                  ) : (
                    <>
                      {response.recommendation.status !== "no_scan" && (
                        <CartSummary response={response} />
                      )}
                      {response.recommendation.status === "no_scan" && (
                        <p className="cart-state-note">
                          کالاها ذخیره شده‌اند؛ برای این موقعیت هنوز اسکن موفق
                          سازگاری نداریم.
                        </p>
                      )}
                      {response.recommendation.status !== "no_scan" &&
                        !response.recommendation.optimal && (
                          <p
                            className="cart-state-note cart-bounded-note"
                            role="status"
                          >
                            جست‌وجو به نتیجه‌ای رسیده که کمترین تعداد فروشگاه در
                            آن تأیید نشده است.
                          </p>
                        )}
                      {response.recommendation.stores.map((store) => (
                        <StoreSection
                          key={store.vendorId}
                          store={store}
                          source={source}
                          assignedKeys={assignedKeys}
                          lines={lines}
                          writing={controller.writePending}
                          refFor={refFor}
                          onQuantity={(key, quantity, control) =>
                            controller.setQuantity(
                              key,
                              quantity,
                              focusAfterMutation(key, control)
                            )
                          }
                          onRemove={removeLine}
                        />
                      ))}
                      {unassigned.length > 0 && (
                        <section
                          className="cart-unassigned"
                          aria-labelledby="cart-unassigned-title"
                        >
                          <h3 id="cart-unassigned-title">
                            {response.recommendation.status === "no_scan"
                              ? "کالاهای ذخیره‌شده"
                              : "بدون پیشنهاد قیمت"}
                          </h3>
                          {response.recommendation.status !== "no_scan" && (
                            <p>برای این کالاها پیشنهاد سازگار پیدا نشد.</p>
                          )}
                          {unassigned.map((line) => (
                            <CartLineRow
                              key={line.key}
                              line={line}
                              source={source}
                              writing={controller.writePending}
                              reason={missing.get(line.key)?.reason}
                              controlsRef={refFor}
                              onQuantity={(quantity, control) =>
                                controller.setQuantity(
                                  line.key,
                                  quantity,
                                  focusAfterMutation(line.key, control)
                                )
                              }
                              onRemove={() => removeLine(line.key)}
                            />
                          ))}
                        </section>
                      )}
                    </>
                  )}
                  <details className="cart-context">
                    <summary>جزئیات قیمت و پوشش</summary>
                    <p>
                      موقعیت {locationName} ·{" "}
                      {response.observedAt
                        ? `مشاهده ${faDate.format(new Date(response.observedAt))}`
                        : "بدون اسکن موفق سازگار"}
                    </p>
                    <p>
                      {response.coverage === "legacy_unverified"
                        ? "پوشش اسکن تاریخی کامل تأیید نشده است."
                        : "قیمت‌ها از فهرست‌های تخفیف پشتیبانی‌شده‌اند و همه کالاهای فروشگاه‌ها را پوشش نمی‌دهند."}
                    </p>
                  </details>
                </>
              ) : (
                <p className="cart-state-note">اطلاعات سبد آماده نیست.</p>
              )}
            </div>

            <footer className="provider-cart-footer">
              <div className="cart-total-line">
                <span>{response?.lines.length ? footerLabel : "جمع سبد"}</span>
                <strong>
                  {response?.recommendation.status === "no_scan" ||
                  !response?.lines.length
                    ? "—"
                    : money(response.recommendation.totalRials, source)}
                </strong>
              </div>
              <Dialog.Close asChild>
                <Button variant="outline" className="cart-continue">
                  ادامه انتخاب کالا
                </Button>
              </Dialog.Close>
              <small>
                قیمت‌ها مربوط به زمان اسکن هستند؛ پیش از خرید بررسی کنید.
              </small>
            </footer>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
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

function CartSummary({
  response,
}: {
  response: NonNullable<Controller["cart"]["data"]>;
}) {
  const rec = response.recommendation;
  const complete =
    rec.status === "complete" ||
    (rec.status === "search_limit" && rec.missingItems.length === 0);
  return (
    <section className="cart-summary" aria-live="polite">
      <strong>
        {complete
          ? rec.stores.length === 1
            ? "همه کالاها در یک فروشگاه"
            : `همه کالاها در ${faNumber.format(rec.stores.length)} فروشگاه`
          : rec.status === "partial"
            ? `پیشنهاد برای ${faNumber.format(rec.stores.reduce((sum, store) => sum + store.items.length, 0))} کالا`
            : "پیشنهاد فروشگاه‌ها"}
      </strong>
      <span>
        {rec.optimal
          ? "کمترین تعداد فروشگاه تأییدشده"
          : "کمترین تعداد فروشگاه تأیید نشده"}
      </span>
    </section>
  );
}

function StoreSection({
  store,
  source,
  assignedKeys,
  lines,
  writing,
  refFor,
  onQuantity,
  onRemove,
}: {
  store: CartStoreRecommendation;
  source: CartProvider;
  assignedKeys: Set<string>;
  lines: CartLine[];
  writing: boolean;
  refFor: (
    key: string,
    control: string
  ) => (node: HTMLButtonElement | null) => void;
  onQuantity: (key: string, quantity: number, control: string) => void;
  onRemove: (key: string) => void;
}) {
  const items = store.items.filter((item) => assignedKeys.has(item.key));
  if (!items.length) return null;
  return (
    <section className="cart-store" aria-label={`اقلام ${store.vendorTitle}`}>
      <header className="cart-store-heading">
        <ProviderLogo
          key={store.logoUrl ?? store.vendorId}
          title={store.vendorTitle}
          logoUrl={store.logoUrl}
        />
        <div className="cart-store-copy">
          <h3>
            <bdi>{store.vendorTitle}</bdi>
          </h3>
          <p className="cart-store-total">
            جمع این فروشگاه · {money(store.totalRials, source)}
          </p>
        </div>
      </header>
      {items.map((item) => {
        const line = lines?.find((value) => value.key === item.key);
        if (!line) return null;
        return (
          <CartLineRow
            key={line.key}
            line={line}
            source={source}
            writing={writing}
            unitPrice={item.priceRials}
            subtotal={item.lineTotalRials}
            controlsRef={refFor}
            onQuantity={(quantity, control) =>
              onQuantity(line.key, quantity, control)
            }
            onRemove={() => onRemove(line.key)}
          />
        );
      })}
    </section>
  );
}

function CartLineRow({
  line,
  source,
  writing,
  unitPrice,
  subtotal,
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
            <strong className="cart-line-price">
              {money(subtotal, source)}
            </strong>
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

function ProviderLogo({
  title,
  logoUrl,
}: {
  title: string;
  logoUrl: string | null;
}) {
  const [broken, setBroken] = useState(false);
  const initials = title.trim().slice(0, 1) || "ف";
  return logoUrl && !broken ? (
    <img
      key={logoUrl}
      className="provider-cart-logo"
      src={logoUrl}
      alt=""
      width={40}
      height={40}
      onError={() => setBroken(true)}
    />
  ) : (
    <span
      className="provider-cart-logo provider-cart-logo-fallback"
      aria-hidden="true"
    >
      {initials}
    </span>
  );
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
