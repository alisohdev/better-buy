import { DiscountSelect } from "../dashboard/DiscountSelect";
import { useEffect, useRef } from "react";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  displayToman,
  type CartSource,
  type ScanRecord,
} from "@better-buy/shared";
import type { DealSource } from "../dashboard/types";
import { faDate, faNumber, sourceLabel } from "../dashboard/format";
import { ProductRow } from "./ProductRow";
import type { useDealFilters } from "./useDealFilters";
import type { useScanLedger } from "../scans/useScanLedger";
import type { useProviderCart } from "../carts/useProviderCart";
import { useWishlist } from "../alerts/useAlerts";
import { Dialog } from "radix-ui";
import { AppIcon } from "../dashboard/AppIcon";
import { ProviderMark } from "../dashboard/AppIcon";

export type DealFeed = {
  source: DealSource;
  ledger: ReturnType<typeof useScanLedger>;
  cart: ReturnType<typeof useProviderCart> | null;
  latestAvailableScan: ScanRecord | null;
};
const normalized = (value: string) =>
  value
    .normalize("NFKC")
    .replaceAll("ي", "ی")
    .replaceAll("ك", "ک")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();

export function DealShelf({
  filters,
  feeds,
  minDiscount,
  onMinDiscount,
  busy,
  historical,
  onOpenCart,
}: {
  filters: ReturnType<typeof useDealFilters>;
  feeds: DealFeed[];
  minDiscount: number;
  onMinDiscount: (value: number) => void;
  busy: boolean;
  historical: boolean;
  onOpenCart: (source: CartSource) => void;
}) {
  const { query, setQuery, sort, setSort, reset } = filters;
  const wishlist = useWishlist();
  const savedItems = wishlist.query.data?.items ?? [];
  const visible = feeds
    .flatMap((feed) => {
      const scan = feed.ledger.scan;
      return scan
        ? feed.ledger.dealGroups.map((group) => ({ group, feed, scan }))
        : [];
    })
    .sort((a, b) => {
      const priceA = displayToman(a.group.finalPriceRials, a.feed.source);
      const priceB = displayToman(b.group.finalPriceRials, b.feed.source);
      if (sort === "price")
        return priceA - priceB || b.group.discountRatio - a.group.discountRatio;
      if (sort === "wishlist") {
        const personalized =
          Number(b.group.wishlistMatch) - Number(a.group.wishlistMatch) ||
          b.group.cartQuantity - a.group.cartQuantity;
        if (personalized) return personalized;
      }
      return (
        b.group.discountRatio - a.group.discountRatio ||
        priceA - priceB ||
        a.group.key.localeCompare(b.group.key)
      );
    });
  const hasScan = feeds.some((feed) => !!feed.ledger.scan);
  const hasResults = feeds.some((feed) => feed.ledger.hasResults);
  const loading =
    busy ||
    feeds.some(
      (feed) =>
        !!feed.ledger.scan &&
        !feed.ledger.hasResults &&
        feed.ledger.results.isPending
    );
  const fetching = feeds.some((feed) => feed.ledger.results.isFetching);
  const loadMoreSentinel = useRef<HTMLDivElement>(null);
  const totalCount = feeds.reduce(
    (sum, feed) => sum + (feed.ledger.totalCount ?? 0),
    0
  );
  const countReady = feeds.every(
    (feed) => !feed.ledger.scan || feed.ledger.totalCount !== null
  );
  useEffect(() => {
    const target = loadMoreSentinel.current;
    if (!target || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          for (const feed of feeds) feed.ledger.loadMore();
        }
      },
      { rootMargin: "600px" }
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [feeds]);
  return (
    <section className="deal-section" aria-labelledby="offers-title">
      <h2 id="offers-title" className="sr-only">
        {historical ? "نتیجه تاریخی" : "تخفیف‌های مناسب شما"}
      </h2>
      <div className="deal-summary">
        <span role="status">
          {historical && "نتیجه تاریخی · "}
          {hasResults && countReady
            ? `${faNumber.format(totalCount)} محصول`
            : "پیشنهادها"}
          {fetching && " · در حال تازه‌سازی"}
        </span>
        {hasResults && (
          <Dialog.Root>
            <Dialog.Trigger asChild>
              <button type="button" className="result-details-trigger">
                <AppIcon name="list" />
                جزئیات نتیجه
              </button>
            </Dialog.Trigger>
            <Dialog.Portal>
              <Dialog.Overlay className="sheet-backdrop" />
              <Dialog.Content
                className="result-details-modal"
                dir="rtl"
                aria-describedby="result-details-description"
              >
                <header>
                  <div>
                    <Dialog.Title>جزئیات نتیجه</Dialog.Title>
                    <Dialog.Description id="result-details-description">
                      زمان و پوشش آخرین نتیجه هر فروشگاه
                    </Dialog.Description>
                  </div>
                  <Dialog.Close asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="بستن جزئیات"
                    >
                      <AppIcon name="close" />
                    </Button>
                  </Dialog.Close>
                </header>
                <div className="result-details-providers">
                  {feeds.map(
                    ({ source, ledger }) =>
                      ledger.scan && (
                        <article key={source}>
                          <div className="result-provider-heading">
                            <ProviderMark source={source} />
                            <strong>{sourceLabel(source)}</strong>
                          </div>
                          <p className="result-detail-location">
                            <AppIcon name="location" />
                            <bdi>{ledger.scan.locationName}</bdi>
                          </p>
                          <p className="result-detail-time">
                            <AppIcon name="history" />
                            <time
                              dateTime={
                                ledger.scan.finishedAt ?? ledger.scan.createdAt
                              }
                            >
                              {faDate.format(
                                new Date(
                                  ledger.scan.finishedAt ??
                                    ledger.scan.createdAt
                                )
                              )}
                            </time>
                          </p>
                          <dl>
                            <div>
                              <dt>
                                <AppIcon name="home" />
                                فروشگاه بررسی‌شده
                              </dt>
                              <dd>
                                {faNumber.format(ledger.scan.vendorCount)}
                              </dd>
                            </div>
                            <div>
                              <dt>
                                <AppIcon name="basket" />
                                رکورد کالا
                              </dt>
                              <dd>
                                {faNumber.format(ledger.scan.productCount)}
                              </dd>
                            </div>
                          </dl>
                          {ledger.scan.context == null && (
                            <p className="result-detail-warning">
                              موقعیت و پوشش تاریخی این نتیجه تأیید نشده است.
                            </p>
                          )}
                        </article>
                      )
                  )}
                </div>
                <p className="result-details-footnote">
                  قیمت و موجودی مربوط به زمان اسکن است.
                </p>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
        )}
      </div>
      {feeds.map(({ source, ledger }) => (
        <div key={source} className="feed-read-state">
          {ledger.results.error && (
            <div className="result-error" role="status">
              <div>
                <span>{sourceLabel(source)}</span>
                <strong>
                  {ledger.hasResults
                    ? "تازه‌سازی نتیجه انجام نشد"
                    : "نتیجه اسکن دریافت نشد"}
                </strong>
                <p>
                  {ledger.hasResults
                    ? "نتیجه ذخیره‌شده با زمان خودش حفظ شده است."
                    : "نتیجه همین اسکن را دوباره دریافت کنید."}
                </p>
              </div>
              <Button
                variant="outline"
                disabled={ledger.results.isFetching}
                onClick={() => void ledger.results.refetch()}
              >
                دریافت دوباره نتیجه
              </Button>
            </div>
          )}
          {ledger.scan && ledger.requestedScan?.id !== ledger.scan.id && (
            <p className="muted" role="status">
              {sourceLabel(source)} · دریافت نتیجه تازه انجام نشد؛ نتیجه موفق
              قبلی با زمان خودش نمایش داده می‌شود.
            </p>
          )}
        </div>
      ))}
      {hasScan && (
        <div className="results-toolbar compact-results-toolbar">
          <Label className="search">
            <span className="sr-only">جست‌وجو</span>
            <Input
              type="search"
              aria-label="جست‌وجوی کالا یا فروشگاه"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="نام کالا یا فروشگاه"
            />
          </Label>
          <Label className="sort-control">
            <span className="sr-only">مرتب‌سازی</span>
            <Select value={sort} onValueChange={setSort}>
              <SelectTrigger aria-label="مرتب‌سازی">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="wishlist">پیشنهادهای شخصی</SelectItem>
                <SelectItem value="discount">بیشترین تخفیف</SelectItem>
                <SelectItem value="price">کمترین قیمت</SelectItem>
              </SelectContent>
            </Select>
          </Label>
          <div className="discount-control">
            <DiscountSelect value={minDiscount} onChange={onMinDiscount} />
          </div>
          {query && (
            <Button variant="outline" onClick={reset}>
              پاک‌کردن جست‌وجو
            </Button>
          )}
        </div>
      )}
      {wishlist.mutation.error && (
        <p className="form-error" role="alert">
          ذخیره علاقه‌مندی انجام نشد. {wishlist.mutation.error.message}
        </p>
      )}
      {loading && (
        <div className="result-loading" role="status">
          <p>
            {hasScan
              ? "در حال دریافت نتیجه ذخیره‌شده…"
              : "در حال دریافت اطلاعات…"}
          </p>
          {!visible.length && (
            <>
              <div className="skeleton-row" />
              <div className="skeleton-row" />
            </>
          )}
        </div>
      )}
      {!loading && !hasScan ? (
        <div className="empty">
          <h2>هنوز نتیجه‌ای برای این انتخاب ندارید</h2>
          <p>با «پیدا کردن تخفیف‌ها» پیشنهادهای این موقعیت را دریافت کنید.</p>
        </div>
      ) : (
        hasResults && (
          <>
            {visible.length ? (
              <div className="deal-list">
                {visible.map(({ group, feed, scan }) => {
                  const saved = savedItems.find(
                    (item) =>
                      normalized(item.phrase) === normalized(group.title)
                  );
                  const cart = feed.cart;
                  const canAdd =
                    !historical &&
                    !!cart &&
                    scan.status === "succeeded" &&
                    scan.id === feed.latestAvailableScan?.id &&
                    feed.ledger.hasResults &&
                    group.state !== "no_longer_present" &&
                    !!group.bestCurrentOffer;
                  const favoritePending =
                    wishlist.mutation.isPending &&
                    (wishlist.mutation.variables?.kind === "add"
                      ? wishlist.mutation.variables.phrase === group.title
                      : wishlist.mutation.variables?.kind === "delete" &&
                        wishlist.mutation.variables.id === saved?.id);
                  return (
                    <ProductRow
                      key={`${scan.id}:${group.key}:${minDiscount}`}
                      group={group}
                      source={feed.source}
                      scanId={scan.id}
                      minDiscount={minDiscount}
                      observedAt={scan.finishedAt ?? scan.createdAt}
                      canAddToCart={canAdd}
                      inCart={cart?.byKey.has(group.key)}
                      addPending={
                        cart?.writePending && cart.writingKey === group.key
                      }
                      cartWritePending={cart?.writePending}
                      onAddToCart={(key) => cart?.add(key)}
                      onOpenCart={() => {
                        onOpenCart(feed.source);
                      }}
                      inWishlist={!!saved}
                      favoritePending={favoritePending}
                      wishlistWritePending={wishlist.mutation.isPending}
                      wishlistReady={wishlist.query.isSuccess}
                      onFavorite={() => {
                        if (saved)
                          wishlist.mutation.mutate({
                            kind: "delete",
                            id: saved.id,
                          });
                        else
                          wishlist.mutation.mutate({
                            kind: "add",
                            phrase: group.title,
                            minDiscount: 15,
                          });
                      }}
                    />
                  );
                })}
              </div>
            ) : (
              !loading && (
                <div className="empty">
                  <h2>
                    {query
                      ? "چیزی با این جست‌وجو پیدا نشد"
                      : "پیشنهادی با این حداقل تخفیف پیدا نشد"}
                  </h2>
                  <p>
                    {query
                      ? "عبارت جست‌وجو را پاک کنید یا تغییر دهید."
                      : "حداقل تخفیف را کم کنید؛ نتیجه‌ها بدون اسکن دوباره فیلتر می‌شوند."}
                  </p>
                  {query && (
                    <Button variant="outline" onClick={reset}>
                      پاک‌کردن جست‌وجو
                    </Button>
                  )}
                </div>
              )
            )}
            <div
              ref={loadMoreSentinel}
              className="feed-load-sentinel"
              aria-hidden="true"
              style={{ height: 1 }}
            />
            {fetching && <p role="status">در حال دریافت محصولات…</p>}{" "}
          </>
        )
      )}
    </section>
  );
}
