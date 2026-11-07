import * as React from "react";
import type { VendorOfferRecord } from "@better-buy/shared";
import type { DealSource } from "../dashboard/types";

export function ProductDestination({
  offer,
  source,
}: {
  offer: VendorOfferRecord | null | undefined;
  source: DealSource;
}) {
  const destination = offer?.productDestination;
  let href: string | undefined;
  if (
    destination &&
    offer &&
    offer.state !== "no_longer_present" &&
    offer.stock > 0 &&
    destination.vendorId === offer.vendorId &&
    destination.productVariationId === offer.productVariationId
  ) {
    try {
      const url = new URL(destination.url);
      const hosts =
        source === "snappmarket"
          ? ["snapp.market", "www.snapp.market"]
          : source === "okala"
            ? ["okala.com", "www.okala.com"]
            : [];
      if (
        url.protocol === "https:" &&
        hosts.includes(url.hostname) &&
        !url.username &&
        !url.password &&
        !url.port &&
        !url.search &&
        !url.hash &&
        url.pathname !== "/" &&
        !url.pathname.includes("%") &&
        !destination.url.includes("\\")
      )
        href = url.href;
    } catch {
      /* Malformed destinations remain unavailable. */
    }
  }
  return href ? (
    <a
      className="provider-website"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`باز کردن کالا در ${offer?.vendorTitle}`}
    >
      باز کردن کالا در فروشگاه ↗
    </a>
  ) : (
    <small className="product-link-unavailable" aria-disabled="true">
      لینک مستقیم کالا تأیید نشده است
    </small>
  );
}
