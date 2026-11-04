# Better Buy

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Signed-in users in Iran who want to quickly compare unusually deep grocery discounts from supported stores across several saved delivery locations.

## Product Purpose

Better Buy scans supported store APIs, keeps deeply discounted products, and makes changes between scans visible. Users can scan manually or save wishlist keywords and a delivery location for twice-daily checks. Success means identifying worthwhile available deals without searching stores one by one.

## Positioning

The product turns a location-specific promotional feed into a durable, comparable shelf of high-discount products, including what is new and what disappeared since the previous run.

## Operating Context

The application uses a Go HTTP backend with SQLite and a static Next.js frontend. Each signed-in user owns private delivery locations and scan history and starts scans manually. A valid Tehran location is enough to start a SnappMarket scan: the API obtains public PWA guest access automatically. Okala uses public nearby-store and multi-store campaign feeds without customer credentials; Digikala Jet is disabled for new activity and keeps read-only history.

## Capabilities and Constraints

- Persian RTL web interface.
- Go API, static Next.js frontend, tenant-isolated SQLite history, and location-specific wishlist scans scheduled for 09:00 and 18:00 Asia/Tehran.
- API collection only; DOM scraping and purchasing are excluded. Wishlist matches appear in an in-app inbox and, with explicit permission and configured VAPID keys, encrypted browser/PWA Web Push notifications.
- SnappMarket price amounts are presented as the tomans supplied by the API, without a unit conversion.
- Authentication material must stay out of browser-readable responses and logs.
- Each signed-in user can keep separate SnappMarket and Okala baskets. Basket lines and quantities persist when the selected delivery location changes; the provider recommendation is recalculated from the latest successful scan compatible with that location and its coordinates, independently of any historical scan being viewed.
- The compact header basket button opens a provider-specific drawer with grouped store assignments, editable quantities, missing-item details, and a persistent observed-price subtotal. Changing providers keeps their baskets separate; changing locations keeps saved lines and refreshes the recommendation when compatible scan data is available.
- Recommend one observed store when it covers every basket quantity. Otherwise assign available products across the fewest stores proven by the supported promotional feed, and identify products with missing or insufficient observed quantity. A bounded search must say when it could not prove the minimum.
- Cart recommendations describe supported promotional-feed observations only. They do not establish universal product availability or place orders.

## Evidence on Hand

The supplied market-party response establishes vendor-grouped products with discount ratio, original price, discount amount, stock, imagery, category, delivery, and vendor metadata. No commercial claims or external brand assets are available.

## Product Principles

- Make the best deal legible at a glance.
- Treat location and scan time as essential context.
- Preserve successful history even when upstream collection fails.
- Okala scans ignore legacy credential rows and use no customer or guest tokens. Keep Snapp guest access ephemeral in the Go server, out of browser responses and logs.
- Promotional feed absence does not establish that a product is out of stock across Okala.
- Prefer explicit operational states over silent failure.

## Accessibility & Inclusion

Persian RTL reading order, keyboard access, visible focus, reduced-motion support, responsive layouts, and live announcements for scan progress are required.
