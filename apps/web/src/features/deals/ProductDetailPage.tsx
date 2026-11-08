import { ProductDestination } from "./ProductDestination";
import { useQuery } from "@tanstack/react-query";
import { displayToman, productGroupSchema } from "@better-buy/shared";
import { api } from "../../lib/api";
import { faDate, faNumber, sourceLabel } from "../dashboard/format";
import type { DealSource } from "../dashboard/types";
import { useWishlist } from "../alerts/useAlerts";
import { Button } from "../../components/ui/button";
import { useProviderCart } from "../carts/useProviderCart";

export function ProductDetailPage({
  scanId,
  productKey,
}: {
  scanId: string;
  productKey: string;
}) {
  const wishlist = useWishlist();
  const query = useQuery({
    queryKey: ["product-detail", scanId, productKey],
    enabled: !!scanId && !!productKey,
    queryFn: async ({ signal }) => {
      const data = await api<{
        product: unknown;
        source: DealSource;
        locationId?: string;
        locationName?: string;
        observedAt?: string | null;
      }>(
        `/api/scans/${encodeURIComponent(scanId)}/product-detail?key=${encodeURIComponent(productKey)}`,
        { signal }
      );
      return {
        product: productGroupSchema.parse(data.product),
        source: data.source,
        locationId: data.locationId,
        locationName: data.locationName,
        observedAt: data.observedAt,
      };
    },
  });
  const result = query.data;
  const cart = useProviderCart({
    source: result?.source ?? "snappmarket",
    locationId: result?.locationId ?? "",
    scanId,
    coordinateRevision: 1,
    enabled: !!result,
  });
  const saved =
    result &&
    wishlist.query.data?.items.find(
      (item) =>
        item.phrase.normalize("NFKC").trim() ===
        result.product.title.normalize("NFKC").trim()
    );
  return (
    <main className="notification-page product-page" dir="rtl">
      <header className="notification-page-header">
        <a href="/?page=notifications">بازگشت به اعلان‌ها</a>
        <h1>جزئیات کالا</h1>
      </header>
      {query.isPending && !!scanId && !!productKey && (
        <p role="status">در حال دریافت جزئیات کالا…</p>
      )}
      {(query.isError || !scanId || !productKey) && (
        <p role="alert">
          این کالا یا اسکن در دسترس نیست.{" "}
          <a href="/?page=notifications">بازگشت به اعلان‌ها</a>
        </p>
      )}
      {result && (
        <article>
          <div
            className="product-detail-overview"
            data-has-image={!!result.product.image}
          >
            {result.product.image && (
              <div className="product-detail-image">
                <img src={result.product.image} alt="" />
              </div>
            )}
            <div className="product-detail-copy">
              <h2>{result.product.title}</h2>
              <p>{sourceLabel(result.source)}</p>
              {result.locationName && <p>موقعیت اسکن: {result.locationName}</p>}
              {result.observedAt &&
                !Number.isNaN(Date.parse(result.observedAt)) && (
                  <p>
                    زمان اسکن:{" "}
                    <time dateTime={result.observedAt}>
                      {faDate.format(new Date(result.observedAt))}
                    </time>
                  </p>
                )}
              <p>
                اطلاعات بر اساس زمان اسکن ذخیره شده است و ممکن است تغییر کرده
                باشد.
              </p>
              {cart.cart.isSuccess &&
                cart.cart.data.scanId === scanId &&
                result.product.bestCurrentOffer && (
                  <Button
                    disabled={cart.writePending || cart.byKey.has(productKey)}
                    onClick={() => cart.add(productKey)}
                  >
                    {cart.byKey.has(productKey)
                      ? "در سبد خرید"
                      : "افزودن به سبد خرید"}
                  </Button>
                )}
              {cart.writeError && (
                <p role="alert">افزودن به سبد انجام نشد؛ دوباره تلاش کنید.</p>
              )}
              <Button
                variant="outline"
                disabled={
                  !wishlist.query.isSuccess || wishlist.mutation.isPending
                }
                onClick={() =>
                  saved
                    ? wishlist.mutation.mutate({ kind: "delete", id: saved.id })
                    : wishlist.mutation.mutate({
                        kind: "add",
                        phrase: result.product.title,
                        minDiscount: 15,
                      })
                }
              >
                {saved ? "حذف از علاقه‌مندی‌ها" : "افزودن به علاقه‌مندی‌ها"}
              </Button>
              {wishlist.mutation.error && (
                <p role="alert">
                  تغییر علاقه‌مندی انجام نشد؛ دوباره تلاش کنید.
                </p>
              )}
            </div>
          </div>
          <h2>پیشنهاد فروشگاه‌ها</h2>
          <ul className="notification-matches">
            {result.product.vendors.map((offer) => (
              <li key={offer.offerKey}>
                <strong>{offer.vendorTitle}</strong>
                <ProductDestination offer={offer} source={result.source} />
                <p>
                  {faNumber.format(offer.discountRatio)}٪ تخفیف ·{" "}
                  {faNumber.format(
                    offer.finalAmountToman ??
                      displayToman(offer.finalPriceRials, result.source)
                  )}{" "}
                  تومان
                </p>
                <p>
                  {offer.state === "no_longer_present" || offer.stock <= 0
                    ? "در این اسکن موجود نیست"
                    : "قیمت مشاهده‌شده در اسکن"}
                </p>
              </li>
            ))}
          </ul>
          <a href={`/?scan=${encodeURIComponent(scanId)}`}>
            مشاهده اسکن کامل و افزودن به سبد
          </a>
        </article>
      )}
    </main>
  );
}
