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
  busy,
  historical,
  onOpenCart,
}: {
  filters: ReturnType<typeof useDealFilters>;
  feeds: DealFeed[];
  minDiscount: number;
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
  return (
    <section className="deal-section" aria-labelledby="offers-title">
      <header className="section-heading">
        <div>
          <h1 id="offers-title">{historical ? "نتیجه تاریخی" : "پیشنهادها"}</h1>
          <p>
            حداقل {faNumber.format(minDiscount)}٪ تخفیف ·{" "}
            {feeds.map((feed) => sourceLabel(feed.source)).join(" و ")}
          </p>
        </div>
        {hasResults && (
          <details className="scan-details">
            <summary>جزئیات نتیجه</summary>
            {feeds.map(
              ({ source, ledger }) =>
                ledger.scan && (
                  <div key={source}>
                    <strong>
                      {sourceLabel(source)} · {ledger.scan.locationName}
                    </strong>
                    <p>
                      <time
                        dateTime={
                          ledger.scan.finishedAt ?? ledger.scan.createdAt
                        }
                      >
                        {faDate.format(
                          new Date(
                            ledger.scan.finishedAt ?? ledger.scan.createdAt
                          )
                        )}
                      </time>
                    </p>
                    <p>
                      {faNumber.format(ledger.scan.vendorCount)} فروشگاه
                      بررسی‌شده · {faNumber.format(ledger.scan.productCount)}{" "}
                      رکورد کالا
                    </p>
                    {ledger.scan.context == null && (
                      <p>موقعیت و پوشش تاریخی این نتیجه تأیید نشده است.</p>
                    )}
                  </div>
                )
            )}
          </details>
        )}
      </header>
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
          {!historical && !ledger.scan && !busy && hasScan && (
            <p className="provider-empty-note">
              <ProviderMark source={source} />
              هنوز نتیجه‌ای برای {sourceLabel(source)} در این موقعیت ندارید.
            </p>
          )}
        </div>
      ))}
      {hasScan && (
        <div className="results-toolbar">
          <Label className="search">
            جست‌وجو
            <Input
              type="search"
              aria-label="جست‌وجوی کالا یا فروشگاه"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="نام کالا یا فروشگاه"
            />
          </Label>
          <Label className="sort-control">
            مرتب‌سازی
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
          {query && (
            <Button variant="outline" onClick={reset}>
              پاک‌کردن جست‌وجو
            </Button>
          )}
        </div>
      )}
      {sort === "wishlist" && hasScan && (
        <p className="personalized-note">
          اول علاقه‌مندی‌ها، سپس تعداد در سبد و درصد تخفیف
        </p>
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
            <p className="result-count" role="status">
              {faNumber.format(visible.length)} محصول نمایش‌داده‌شده
              {fetching && " · در حال تازه‌سازی"}
            </p>
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
                        if (feed.source !== "digikalajet")
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
            <div className="feed-pagination">
              {feeds.map(({ source, ledger }) => (
                <div key={source}>
                  {ledger.nextCursor && (
                    <Button
                      variant="outline"
                      disabled={ledger.results.isFetching}
                      onClick={ledger.loadMore}
                    >
                      نمایش محصولات بیشتر · {sourceLabel(source)}
                    </Button>
                  )}
                  {ledger.hasPreviousPages && (
                    <Button variant="outline" onClick={ledger.firstPage}>
                      بازگشت به صفحه نخست · {sourceLabel(source)}
                    </Button>
                  )}
                </div>
              ))}
            </div>
            <p className="observation-note">
              قیمت و موجودی، مشاهده زمان اسکن است. پیش از خرید در فروشگاه بررسی
              کنید.
            </p>
            <Button
              variant="outline"
              className="refresh-result"
              disabled={fetching}
              onClick={() => {
                for (const feed of feeds)
                  if (feed.ledger.scan) void feed.ledger.results.refetch();
              }}
            >
              تازه‌سازی نتیجه
            </Button>
          </>
        )
      )}
    </section>
  );
}
