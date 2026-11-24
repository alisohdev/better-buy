# Better Buy screenshot gallery

These captures show the actual Persian application in Chromium. The account, delivery location, offer prices, and scan progress are demo fixtures. Product photographs come from public catalogue assets. The captures contain no production account data.

## Browse deals

![Desktop shopping dashboard with retailer offers and search tools](dashboard.webp)

<img src="mobile-dark.webp" alt="Mobile shopping feed in dark mode" width="320"> <img src="live-scan.webp" alt="Mobile scan progress and provisional offer" width="320">

## Inspect a product and plan a basket

![Product details dialog with an image and a store offer](product-details.webp)

![Basket panel with quantities, retailer groups, and an estimated subtotal](basket.webp)

## Save interests and select a delivery location

![Wishlist dialog with saved phrases and per-item discount controls](wishlist.webp)

<img src="location-map.webp" alt="Interactive Tehran delivery map with fixed pin, zoom controls, and map attribution" width="446">

The desktop, mobile, details, basket, and wishlist screens were captured against a local Vite production build using the [combined feed fixture](../../apps/web/tests/combined-feed.spec.ts) with additional synthetic catalogue and basket responses. The scan and map screens come from existing [dashboard](../../apps/web/tests/dashboard.spec.ts) and [guest](../../apps/web/tests/guest.spec.ts) fixtures. Images are compressed WebP captures.

[Back to Better Buy](../../README.md)
