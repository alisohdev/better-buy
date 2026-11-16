# Product navigation evidence

Research updated: 2026-11-16. Okala's store-bound offer route is now verified from a user-provided first-party example and a live HTTPS check. Snapp Market still has no verified route and remains disabled.

## Public checks

| Provider     | First-party observation                                                                                                                                                                                                                                               | Conclusion                                                                                                                                         |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Snapp Market | Opening [the official site](https://snapp.market/) through the web fetch tool returned a background image and no product links. Scoped product searches returned no usable first-party product examples.                                                              | No public product route or canonical product URL verified.                                                                                         |
| Okala        | The user supplied [`https://www.okala.com/store/2223/offer/87001`](https://www.okala.com/store/2223/offer/87001). A live HTTPS GET returned 200; the final URL and canonical path retained `/store/2223/offer/87001`, and the response referenced product ID `87001`. | Use `/store/{storeId}/offer/{productId}` only when both IDs are positive decimal values; the route binds the link to that exact store and product. |

Earlier scoped searches included `site:okala.com/product` and did not find the offer route; the user-provided URL and live first-party response provide direct route evidence that those searches missed.

Direct Python HTTPS requests to both official homepages failed with `SSL: UNEXPECTED_EOF_WHILE_READING`. The same failure affected the standard Android association and Apple association paths below. The web fetch tool also could not access the association documents. This establishes an access limitation, not an absence of association support.

- <https://snapp.market/.well-known/assetlinks.json>
- <https://www.okala.com/.well-known/assetlinks.json>
- <https://snapp.market/.well-known/apple-app-site-association>
- <https://www.okala.com/.well-known/apple-app-site-association>

No association contents, application identifiers, custom schemes, intent URLs, or supported product path matchers were verified. Even an accessible association document would require installed-app device testing before claiming app-opening behavior.

## Repository identity and collection evidence

The current [Go collector](../apps/api/internal/providers/collect.go) models Snapp Market `productVariationId`, product `vendorId`, `vendorCode`, and the containing vendor's `vendor_id`. Normalization checks that the product's owner matches the containing vendor and uses `vendorId:productVariationId` as the offer key. It does not model a canonical product-page URL. Snapp campaigns additionally have collection ID and benefit/provenance context in [campaigns.go](../apps/api/internal/providers/campaigns.go).

The Okala campaign response model in the same collector has product `id`, `storeId`, `storeName`, prices, quantity and image URL. Normalization preserves product ID in `productVariationId` and store ID in `vendorId`, with `storeId:productId` as its offer key. It does not model a canonical product-page URL. `imageUrl` is an image, not a product destination.

The collectors' `svc.snapp.market` and Okala API request destinations are service endpoints, not shopper product pages. They must never become external navigation links. No credentials, guest tokens, device identifiers, or customer coordinates should be copied into product destinations.

The existing [product projection](../apps/api/internal/products/products.go) groups observations and selects offers while retaining vendor/product identity, benefit identity and provenance. Navigation belongs to the selected offer, not the group title or an offer from another store. Historical records lacking destination data must remain readable and return null. Existing campaign feed observations in [the API research guide](snapp-market-discount-api-guide.md) document useful collector APIs, but do not verify shopper product routes.

## Verification status and activation gate

| Scenario                                  | Result                                                                                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Multiple real exact products per provider | One Okala product route was verified; broader product sampling remains outstanding. Snapp Market remains unverified.                  |
| Exact selected store                      | Okala URL includes the exact store and product IDs. No fallback to a different store or generic catalog page is allowed.              |
| Desktop product navigation                | The official product route returned HTTP 200 and a matching canonical path; an interactive browser click was not exercised.           |
| Changed location / out-of-area store      | Not separately tested. Okala links remain bound to the store from the offer, independent of the selected delivery location.           |
| Market Party or campaign preservation     | Unverified; IDs and provenance do not establish a destination route or continued price eligibility.                                   |
| Android, retailer app installed           | Not tested: no connected physical Android device used.                                                                                |
| Android, retailer app absent              | Not tested: no connected physical Android device used.                                                                                |
| iOS Universal Links                       | Not tested: no iOS device used and association documents inaccessible.                                                                |
| Expired / unavailable real product route  | Unverified because no real route was established. Locally suppressing historical/out-of-stock navigation can be tested independently. |

The Okala web resolver is enabled only for positive decimal store/product IDs and emits the verified route. Supplied canonical URLs must match those exact IDs. Further checks should cover several products and another store where available, changed locations, and expired products. Use ordinary HTTPS anchors; do not add app schemes, timeout redirects, or forced intent URLs. Mark Android and iOS app opening unverified until installed/uninstalled-device observations are recorded.

Snapp Market continues to show a clearly labeled unavailable action with a null destination. Okala links are ordinary web links only; no mobile-app opening behavior is claimed.

## Implemented behavior

Okala deal and vendor-offer responses now include a generated store-bound destination when both IDs are valid. Historical records still default to null; Snapp Market remains null. No schema migration, token propagation or custom app scheme is added. Existing out-of-stock suppression and HTTPS/host validation remain in effect; queries, fragments, ports, userinfo, encoded IDs, and mismatched canonical paths are rejected.

## Local validation

Go resolver and product tests pass, including checks that mismatched store/product IDs and nondecimal IDs remain unavailable. The live Okala route returned HTTP 200 with the expected canonical route. Desktop and mobile Playwright checks confirm the live-results card renders the store-bound link. Additional product/store sampling, expired-product behavior, and Android/iOS app opening remain unverified.
