# Product navigation evidence

Research date: 2026-11-07. Result: **no exact, store-specific public product destination was verified for either provider in this session**. Both providers must return null until that evidence exists. A provider-owned hostname alone does not establish a product destination.

## Public checks

| Provider     | First-party observation                                                                                                                                                                                                              | Conclusion                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Snapp Market | Opening [the official site](https://snapp.market/) through the web fetch tool returned a background image and no product links. Scoped product searches returned no usable first-party product examples.                             | No public product route or canonical product URL verified.                                              |
| Okala        | [The official site](https://okala.com/) redirected to `https://www.okala.com/`. Its fetched page asks the user to choose an address to determine the store. Scoped product searches returned no usable first-party product examples. | Location/store selection is an explicit site prerequisite; no exact product/store destination verified. |

Searches included `site:snapp.market/product`, `site:snapp.market "/products/"`, `site:snapp.market "شیر" "product"`, `site:okala.com/product`, `site:okala.com "/product/"`, and `site:okala.com "product" "شیر"`. Negative search results are a research limitation, not proof that routes do not exist. No route template is inferred from those queries.

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
| Multiple real exact products per provider | Blocked: no verified public product URL examples obtained.                                                                            |
| Exact selected store                      | Unverified; never substitute a different store or generic catalog page.                                                               |
| Desktop product navigation                | Unverified; official homepage fetches do not validate a product destination.                                                          |
| Changed location / out-of-area store      | Unverified; Okala explicitly requests an address before store selection.                                                              |
| Market Party or campaign preservation     | Unverified; IDs and provenance do not establish a destination route or continued price eligibility.                                   |
| Android, retailer app installed           | Not tested: no connected physical Android device used.                                                                                |
| Android, retailer app absent              | Not tested: no connected physical Android device used.                                                                                |
| iOS Universal Links                       | Not tested: no iOS device used and association documents inaccessible.                                                                |
| Expired / unavailable real product route  | Unverified because no real route was established. Locally suppressing historical/out-of-stock navigation can be tested independently. |

To enable a resolver, obtain a first-party canonical product URL or documented route with product and store binding. Validate at least several real products from each enabled provider and two stores where available. Confirm redirects retain exact identity and never silently land on a homepage, catalog, another store, or login-only generic landing. Repeat with a changed delivery location and expired/unavailable products. Document campaign terms separately from destination identity. Use an ordinary HTTPS anchor for verified web destinations; do not add app schemes, timeout redirects, or forced intent URLs. Mark Android and iOS app opening unverified until installed/uninstalled-device observations are recorded.

Until then, a clearly labeled unavailable action and null destination are the supported behavior. This is the remaining provider evidence blocker, not a claim that external navigation is live.

## Implemented behavior

`productDestination` is explicitly null on Go deal and vendor-offer responses. Shared parsers default missing historical fields to null. Each provider has a separate resolver; both remain closed pending evidence. Existing vendor/product IDs, vendor code, benefit and provenance are retained. No schema migration, network request, token propagation or custom app scheme is added. The product dialog homepage action is replaced by a direct-product action or unavailable label. Each store row owns its own action; historical and zero-stock offers cannot navigate. HTTPS host validation is necessary but never sufficient to activate a resolver. Queries, fragments, ports, userinfo and encoded paths remain unsupported until reviewed.

## Local validation

Go `go -C apps/api test ./...` passed; the subsequently added products legacy serialization test also passed. Shared tests (16) and web tests (73, including three new navigation tests) passed. Resolver tests exercise three synthetic product identities and two stores per provider: these prove closed behavior, not real retailer routes. Shared TypeScript checking passed. Workspace typechecking is blocked by the unresolved existing `maplibre-gl` import in `apps/web/src/app/LocationMap.tsx`. No browser layout inspection, physical-device tests, live product identity tests, changed-location navigation tests or real expired-product tests were completed; all remain unverified. No app-opening support is claimed.
