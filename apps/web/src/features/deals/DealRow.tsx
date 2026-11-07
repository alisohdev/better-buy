import { ProductDestination } from "./ProductDestination";
import { useState } from "react";
import type { DealGroupRecord } from "@better-buy/shared";
import type { DealSource } from "../dashboard/types";
import { faNumber, money } from "../dashboard/format";
import { bestOffer, feedStateLabel } from "./presentation";
function ProductImage({ src }: { src: string | null }) {
  const [broken, setBroken] = useState(false);
  return (
    <div className="product-image">
      {src && !broken ? (
        <img
          src={src}
          alt=""
          width={88}
          height={88}
          loading="lazy"
          decoding="async"
          onError={() => setBroken(true)}
        />
      ) : (
        <span>تصویر در دسترس نیست</span>
      )}
    </div>
  );
}
export function DealRow({
  group,
  source,
}: {
  group: DealGroupRecord;
  source: DealSource;
}) {
  const best = bestOffer(group);
  const historical = best.state === "no_longer_present";
  const hasCurrent = group.groupKeyVersion === 1 || !!group.bestCurrentOffer;
  const offers = [...group.vendors].sort(
    (a, b) =>
      Number(a.state === "no_longer_present") -
        Number(b.state === "no_longer_present") ||
      a.finalPriceRials - b.finalPriceRials ||
      a.vendorTitle.localeCompare(b.vendorTitle, "fa")
  );
  return (
    <article className={`deal-row ${historical ? "historical-offer" : ""}`}>
      <ProductImage key={group.image} src={group.image} />
      <div className="product-copy">
        <h2>
          <bdi>{group.title}</bdi>
        </h2>
        <p>{hasCurrent ? best.vendorTitle : "پیشنهاد جاری قابل مقایسه نیست"}</p>
        <small>
          {feedStateLabel(group.state)}
          {group.categoryTitle && ` · ${group.categoryTitle}`}
        </small>
      </div>
      {hasCurrent ? (
        <div className="price-label">
          <div className="original-price">
            <del>
              <bdi>{money(best.priceRials, source)}</bdi>
            </del>
            {best.discountRatio > 0 && (
              <span className="discount">
                {faNumber.format(Math.round(best.discountRatio))}٪
              </span>
            )}
          </div>
          <strong>
            <bdi>{money(best.finalPriceRials, source)}</bdi>
          </strong>
          {historical && <small>قیمت تاریخی</small>}
        </div>
      ) : (
        <div className="price-label">
          <small>قیمت جاری در دسترس نیست</small>
        </div>
      )}
      <details className="vendor-disclosure">
        <summary>
          مقایسه فروشگاه‌ها{" "}
          <span>
            {faNumber.format(group.currentStoreOfferCount ?? offers.length)}
          </span>
        </summary>
        <div className="vendor-offers" aria-label={`پیشنهادهای ${group.title}`}>
          {offers.map((v) => (
            <div
              className={`vendor-offer ${v.state === "no_longer_present" ? "historical-offer" : ""}`}
              key={v.offerKey}
            >
              <div>
                <strong>
                  <bdi>{v.vendorTitle}</bdi>
                </strong>
                <small>
                  {feedStateLabel(v.state)}
                  <ProductDestination offer={v} source={source} />
                  {v.state !== "no_longer_present" &&
                    ` · موجودی ثبت‌شده ${faNumber.format(v.stock)}`}
                </small>
              </div>
              <div>
                <del>
                  <bdi>{money(v.priceRials, source)}</bdi>
                </del>
                <strong>
                  <bdi>{money(v.finalPriceRials, source)}</bdi>
                </strong>
                <small>
                  {v.state === "no_longer_present"
                    ? "قیمت تاریخی"
                    : `${faNumber.format(v.discountRatio)}٪ تخفیف`}
                </small>
              </div>
            </div>
          ))}
        </div>
      </details>
      {!!group.conditionalOffers?.length && (
        <details className="vendor-disclosure">
          <summary>پیشنهادهای مشروط</summary>
          {group.conditionalOffers.map((offer) => (
            <div className="vendor-offer" key={offer.offerKey}>
              <strong>{offer.vendorTitle}</strong>
              <bdi>{money(offer.finalPriceRials, source)}</bdi>
              <small>{offer.benefit?.terms ?? "شرایط استفاده مشخص نیست"}</small>
            </div>
          ))}
        </details>
      )}
    </article>
  );
}
