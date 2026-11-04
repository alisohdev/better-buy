# Mobile shopping release

Release `ad930a747397a9ce56dbbc73cace03ce9089b514` was deployed to https://better-buy.ir on 2 November 2026 UTC from branch `alisohdev/fixes-feature`.

## Delivered behavior

- Mobile navigation exposes carts, wishlist, notifications and history, with secondary actions in the header menu.
- SnappMarket and Okala are selected by default. At least one remains selected. Two collector slots allow both jobs to run concurrently.
- New scans collect offers from 15% upward. The visible 15–80% slider filters stored offers through GET requests without creating another scan.
- Combined product results carry provider logos. Product details expose larger images, store offers and logos where supplied, full-name favorites and compact cart actions.
- Personal ordering prioritizes wishlist matches, then the current user's cart quantities, then discount.
- Wishlist entries persist individual 15–80% notification thresholds.
- Delivery location entry opens a larger map by default, removes numeric coordinate inputs, searches through the configured geocoder with Photon fallback, and moves the map to search results.
- Admin analytics records visits and searches and exposes account emails, saved locations, scans, wishlist entries and cart contents behind verified-email authorization.

## Verification

The Go suite, TypeScript checks, 84 shared/web unit tests, frontend production export and Linux binaries passed. All 108 browser scenarios passed across the main run and focused reruns after fixes. The combined-feed suite also passed all eight checks against the final export. Production `/`, `/healthz`, provider assets and signed-out browser rendering passed; private `/api/me` and `/api/admin/analytics` returned 401 without authentication. One API process was running after rollout.

Before migrations, the production backup service produced `/var/backups/better-buy/better-buy-20261102T205922Z.sqlite`. The prior release remains in `/srv/better-buy/releases/ce99fd56895a97da0e87c79821e28e3046c0010b`. Prior API and migration binaries are retained under `/srv/better-buy/releases/ad930a7/bin/previous-*`.

## Operational notes

`ADMIN_EMAILS` was not configured on production and has deliberately not been inferred from an account. Set that environment variable to the intended verified administrator emails and restart the service to enable access. Analytics begins collecting with this release; it does not invent historical visits.

Store buttons link to the official provider websites. Product-specific purchase routes and cart transfer were not verified, so the interface labels these links as website links. Digikala Jet remains available for historical results only, consistent with the existing disabled collector.

Existing scans collected above 15% cannot recover offers that were never collected. A fresh scan creates the broader result set.

Photon API contract reference: https://github.com/komoot/photon/blob/master/docs/api-v1.md. Provider icons were retrieved from each official website's declared app icon assets.
