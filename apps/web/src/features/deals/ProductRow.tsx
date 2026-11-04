import { useRef, useState } from "react";
import { Dialog } from "radix-ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  offerPageSchema,
  type OfferPage,
  type ProductSummary,
} from "@better-buy/shared";
import { api } from "../../lib/api";
import type { DealSource } from "../dashboard/types";
import { faDate, faNumber, money, sourceLabel } from "../dashboard/format";
import { AppIcon, ProviderMark } from "../dashboard/AppIcon";
import { feedStateLabel } from "./presentation";
import { Button } from "@/components/ui/button";

function StoreLogo({
  url,
  title,
}: {
  url: string | null | undefined;
  title: string;
}) {
  const [broken, setBroken] = useState(false);
  return (
    <span className="store-logo">
      {url && !broken ? (
        <img
          src={url}
          alt=""
          width={36}
          height={36}
          loading="lazy"
          onError={() => setBroken(true)}
        />
      ) : (
        <span aria-hidden="true">{title.slice(0, 1)}</span>
      )}
    </span>
  );
}

export function ProductRow({
  group,
  source,
  scanId,
  minDiscount = 15,
  observedAt,
  canAddToCart = false,
  inCart = false,
  addPending = false,
  cartWritePending = false,
  onAddToCart,
  onOpenCart,
  inWishlist = false,
  favoritePending = false,
  wishlistWritePending = false,
  wishlistReady = false,
  onFavorite,
}: {
  group: ProductSummary;
  source: DealSource;
  scanId: string;
  minDiscount?: number;
  observedAt?: string;
  canAddToCart?: boolean;
  inCart?: boolean;
  addPending?: boolean;
  cartWritePending?: boolean;
  onAddToCart?: (key: string) => void;
  onOpenCart?: () => void;
  inWishlist?: boolean;
  favoritePending?: boolean;
  wishlistWritePending?: boolean;
  wishlistReady?: boolean;
  onFavorite?: () => void;
}) {
  const [broken, setBroken] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const detailReturnFocus = useRef<HTMLButtonElement | null>(null);
  const openingCart = useRef(false);
  const client = useQueryClient();
  const baseKey = ["offers", scanId, source, group.key, minDiscount];
  const context = JSON.stringify(baseKey);
  const [paging, setPaging] = useState<{
    context: string;
    cursors: (string | null)[];
  }>({ context: "", cursors: [null] });
  const cursors = paging.context === context ? paging.cursors : [null];
  const cursor = cursors.at(-1) ?? null;
  const setCursors = (values: (string | null)[]) =>
    setPaging({ context, cursors: values });
  const canCompareStores = group.currentStoreOfferCount > 1;
  const offers = useQuery({
    queryKey: [...baseKey, cursor],
    enabled: canCompareStores && (expanded || detailOpen),
    staleTime: 600_000,
    gcTime: 600_000,
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams({ minDiscount: String(minDiscount) });
      if (cursor) params.set("cursor", cursor);
      const page = await api(
        `/api/scans/${scanId}/products/${encodeURIComponent(group.key)}/offers?${params}`,
        { signal },
        offerPageSchema.parse
      );
      if (cursors.length > 20)
        client.removeQueries({
          queryKey: [...baseKey, cursors[0]],
          exact: true,
        });
      return page;
    },
  });
  const best = group.bestCurrentOffer;
  const rows = new Map(
    cursors
      .flatMap(
        (value) =>
          (value === cursor
            ? offers.data
            : client.getQueryData<OfferPage>([...baseKey, value])
          )?.items ?? []
      )
      .map((offer) => [offer.offerKey, offer])
  );
  if (!canCompareStores && best) rows.set(best.offerKey, best);
  const image = (
    <>
      {group.image && !broken ? (
        <img
          src={group.image}
          alt=""
          width={detailOpen ? 360 : 88}
          height={detailOpen ? 360 : 88}
          loading="lazy"
          decoding="async"
          onError={() => setBroken(true)}
        />
      ) : (
        <span>تصویر در دسترس نیست</span>
      )}
    </>
  );
  const price = best ? (
    <>
      <div className="original-price">
        <del>
          <bdi>{money(best.priceRials, source)}</bdi>
        </del>
        <span className="discount">
          {faNumber.format(Math.round(best.discountRatio))}٪
        </span>
      </div>
      <strong>
        <bdi>{money(best.finalPriceRials, source)}</bdi>
      </strong>
    </>
  ) : (
    <small>قیمت جاری در دسترس نیست</small>
  );
  const favoriteButton = (detail = false) => (
    <Button
      variant="outline"
      className={`product-favorite ${inWishlist ? "is-favorite" : ""}`}
      aria-pressed={inWishlist}
      aria-busy={favoritePending}
      disabled={!wishlistReady || wishlistWritePending}
      aria-label={
        inWishlist
          ? `حذف ${group.title} از علاقه‌مندی‌ها`
          : `افزودن ${group.title} به علاقه‌مندی‌ها`
      }
      onClick={onFavorite}
    >
      <AppIcon name="heart" fill={inWishlist ? "currentColor" : "none"} />
      {detail &&
        (favoritePending
          ? "در حال ذخیره…"
          : inWishlist
            ? "در علاقه‌مندی‌ها"
            : "افزودن نام به علاقه‌مندی‌ها")}
    </Button>
  );
  const cartButton = (detail = false) =>
    (canAddToCart || inCart) && (
      <Button
        variant={detail ? "default" : "outline"}
        className="product-cart-add"
        aria-busy={addPending}
        disabled={!inCart && cartWritePending}
        aria-label={
          inCart
            ? `نمایش ${group.title} در سبد`
            : `افزودن ${group.title} به سبد`
        }
        onClick={() => {
          if (inCart) {
            openingCart.current = true;
            setDetailOpen(false);
            onOpenCart?.();
          } else onAddToCart?.(group.key);
        }}
      >
        <AppIcon name={inCart ? "check" : "plus"} />
      </Button>
    );
  const storeOffers = (
    <div className="vendor-offers" aria-label={`پیشنهادهای ${group.title}`}>
      {canCompareStores && offers.isPending && (
        <p role="status">در حال دریافت فروشگاه‌ها…</p>
      )}
      {offers.error && (
        <div role="status">
          <p>دریافت فروشگاه‌ها انجام نشد؛ پیشنهادهای دریافت‌شده حفظ شده‌اند.</p>
          <Button
            variant="outline"
            disabled={offers.isFetching}
            onClick={() => void offers.refetch()}
          >
            دریافت دوباره فروشگاه‌ها
          </Button>
        </div>
      )}
      {[...rows.values()].map((offer) => (
        <div
          className={`vendor-offer ${offer.state === "no_longer_present" ? "historical-offer" : ""}`}
          key={offer.offerKey}
        >
          <div className="store-identity">
            <StoreLogo
              url={offer.logoUrl ?? offer.vendorLogoUrl}
              title={offer.vendorTitle}
            />
            <div>
              <strong>
                <bdi>{offer.vendorTitle}</bdi>
              </strong>
              <small>
                {feedStateLabel(offer.state)}
                {offer.state !== "no_longer_present" &&
                  ` · موجودی ثبت‌شده ${faNumber.format(offer.stock)}`}
              </small>
              {offer.benefit?.kind === "conditional" && (
                <small>
                  {offer.benefit.terms ?? "شرایط استفاده مشخص نیست"}
                </small>
              )}
            </div>
          </div>
          <div>
            <del>
              <bdi>{money(offer.priceRials, source)}</bdi>
            </del>
            <strong>
              <bdi>{money(offer.finalPriceRials, source)}</bdi>
            </strong>
            <small>
              {offer.state === "no_longer_present"
                ? "قیمت تاریخی"
                : `${faNumber.format(offer.discountRatio)}٪ تخفیف`}
            </small>
          </div>
        </div>
      ))}
      {offers.data?.nextCursor && (
        <Button
          variant="outline"
          disabled={offers.isFetching}
          onClick={() => {
            const next = offers.data?.nextCursor;
            if (next && !cursors.includes(next))
              setCursors([...cursors.slice(-20), next]);
          }}
        >
          نمایش فروشگاه‌های بیشتر
        </Button>
      )}
      {cursors.length > 20 && (
        <Button variant="outline" onClick={() => setCursors([null])}>
          بازگشت به فروشگاه‌های نخست
        </Button>
      )}
    </div>
  );
  return (
    <Dialog.Root open={detailOpen} onOpenChange={setDetailOpen}>
      <article
        className={`deal-row ${group.state === "no_longer_present" ? "historical-offer" : ""}`}
      >
        <Dialog.Trigger asChild>
          <button
            type="button"
            className="product-image"
            aria-label={`جزئیات ${group.title}`}
            onClick={(event) => {
              detailReturnFocus.current = event.currentTarget;
            }}
          >
            {image}
          </button>
        </Dialog.Trigger>
        <div className="product-copy">
          <span className="product-provider">
            <ProviderMark source={source} />
            {sourceLabel(source)}
          </span>
          <h2>
            <Dialog.Trigger asChild>
              <button
                type="button"
                className="product-title"
                onClick={(event) => {
                  detailReturnFocus.current = event.currentTarget;
                }}
              >
                <bdi>{group.title}</bdi>
              </button>
            </Dialog.Trigger>
          </h2>
          <p className="product-store">
            <StoreLogo
              url={best?.logoUrl ?? best?.vendorLogoUrl}
              title={best?.vendorTitle ?? ""}
            />
            <bdi>{best?.vendorTitle ?? "پیشنهاد جاری قابل مقایسه نیست"}</bdi>
          </p>
          <small>
            {feedStateLabel(group.state)}
            {group.categoryTitle && ` · ${group.categoryTitle}`}
          </small>
        </div>
        <div className="price-label">
          {price}
          <div className="product-actions">
            {favoriteButton()}
            {cartButton()}
          </div>
        </div>
        {canCompareStores && (
          <details
            className="vendor-disclosure"
            onToggle={(event) => setExpanded(event.currentTarget.open)}
          >
            <summary>
              مقایسه فروشگاه‌ها{" "}
              <span>{faNumber.format(group.currentStoreOfferCount)}</span>
            </summary>
            {expanded && !detailOpen && storeOffers}
          </details>
        )}
        {canCompareStores && group.conditionalOfferCount > 0 && (
          <small className="product-conditional-note">
            پیشنهادهای مشروط در مقایسه فروشگاه‌ها مشخص شده‌اند.
          </small>
        )}
      </article>
      <Dialog.Portal>
        <Dialog.Overlay className="sheet-backdrop" />
        <Dialog.Content
          className="product-detail-dialog"
          dir="rtl"
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (!openingCart.current) detailReturnFocus.current?.focus();
            openingCart.current = false;
          }}
        >
          <header className="product-detail-header">
            <span className="product-provider">
              <ProviderMark source={source} />
              {sourceLabel(source)}
            </span>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon" aria-label="بستن جزئیات کالا">
                <AppIcon name="close" />
              </Button>
            </Dialog.Close>
          </header>
          <div className="product-detail-overview">
            <div className="product-detail-image">{image}</div>
            <div className="product-detail-copy">
              <Dialog.Title>
                <bdi>{group.title}</bdi>
              </Dialog.Title>
              {group.categoryTitle && (
                <p className="muted">{group.categoryTitle}</p>
              )}
              <div className="price-label">{price}</div>
              <div className="product-detail-actions">
                {cartButton(true)}
                {favoriteButton(true)}
              </div>
              {!wishlistReady && (
                <p className="muted">
                  برای ذخیره علاقه‌مندی، دریافت فهرست باید کامل شود.
                </p>
              )}
              <p className="observation-note">
                {observedAt && (
                  <time dateTime={observedAt}>
                    {faDate.format(new Date(observedAt))} ·{" "}
                  </time>
                )}
                قیمت و موجودی مشاهده زمان اسکن است.
              </p>
              {source !== "digikalajet" && (
                <a
                  className="provider-website"
                  href={
                    source === "okala"
                      ? "https://www.okala.com"
                      : "https://snapp.market"
                  }
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  باز کردن وب‌سایت {sourceLabel(source)}
                  <AppIcon name="external" />
                </a>
              )}
            </div>
          </div>
          <section
            className="product-detail-stores"
            aria-label="قیمت فروشگاه‌ها"
          >
            <h3>قیمت فروشگاه‌ها</h3>
            {storeOffers}
          </section>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
