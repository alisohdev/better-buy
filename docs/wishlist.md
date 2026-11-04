# Wishlist and notifications

## Behavior

- Each signed-in account can save up to 30 keyword phrases and explicitly select one owned delivery location for automatic scans. Clearing that selection or removing all keywords stops new automatic work. Existing baskets are separate.
- Matching normalizes Persian/Arabic letters, half-spaces, whitespace, and Persian/Arabic digits. Every word in a phrase must occur in the product title; category and store names alone do not match. Matching is literal, not fuzzy or semantic.
- Current wishlist matches sort before other products on the server, before pagination, within every supported manual-scan sort order. Unavailable historical products are not promoted. Wishlist changes invalidate old product cursors.
- The Go server checks the schedule every 30 seconds and enqueues both stores at 09:00 and 18:00 Asia/Tehran (05:30 and 14:30 UTC). These are start times, not guaranteed notification arrival times. SQLite schedule rows make dispatch idempotent. Jobs drain from the same server process, one scan at a time. Jobs older than two hours are skipped instead of producing stale catch-up scans.
- Automatic scans use queued full-mode collection of the supported promotional feeds, with minimum discounts of 40% for SnappMarket and 30% for Okala. They do not scan either store's entire catalog or bypass upstream completeness checks. A missing match does not prove the item is out of stock everywhere.
- The selected location and its coordinates/revision are frozen per schedule. Changing or deleting it skips undispatched work. Failed or cancelled scans do not publish matches or replace successful history.
- For each successful scan, the notification processor checks up to three cheapest currently available products per keyword. New products in this shortlist and price drops produce one inbox notification per store scan. Unchanged matches do not repeat. Observations are isolated by account, keyword, store and location revision.
- Notifications are processed by the Go maintainer every 30 seconds, including successful manual scans. The inbox shows the latest 50 notifications, with prices in tomans and links back to the saved scan. The inbox works without push permission or push keys.
- Web Push is one delivery channel for browser tabs and installed PWAs. It requires HTTPS, service-worker and Push API support, permission granted by a user gesture, and a registered subscription. On supported iOS/iPadOS versions, users must install the app on their Home Screen. Denied or unsupported push does not block wishlist or inbox use.
- Subscription secrets are encrypted with BOX_KEY. The push outbox retries transient failures up to five times and removes expired subscriptions on HTTP 404/410. Notification tags collapse replayed sends: delivery is at least once, not exactly once. Credentials and raw subscription endpoints are never logged. Only recognized browser push-service HTTPS endpoints are accepted, without redirects.

## Activation and release

1. Build and run the required checks locally; never use the production database for fixtures.
2. Before a rollout, confirm the target VPS and exact revision. Back up the SQLite database and verify restoration before applying migrations.
3. Run the Go migration command before starting a new release. It applies embedded application and scan-queue migrations without deleting historical scans or baskets.
4. `WISHLIST_SCHEDULE_ENABLED=true` enables automatic wishlist jobs. Setting it to `false` stops new scheduled starts; manual scans, notifications, and push delivery continue.
5. Generate one stable P-256 VAPID pair locally: export the uncompressed EC public point and private scalar as unpadded base64url. Keep the pair across deployments; rotating it requires browser resubscription.
6. Set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and VAPID_SUBJECT in the Go server environment. The subject must be a valid `mailto:` address or HTTPS contact URL. Never commit private keys. Only the public key is returned to clients. Without all three values, push is unavailable but the inbox continues to work.
7. Build the static frontend and Go binary, then verify authenticated wishlist CRUD, the default location, both scheduled store scans, inbox delivery, and real device push separately. A mocked push-service response or encrypted-payload build does not prove delivered device notifications.

## Operational limits

Each user's delivery location requires its own store scans; collection is not shared globally. Provider availability can delay or expire queued jobs. The Go queue processes one scan at a time. Scheduling does not override active-user exclusivity or provider limits. Notifications and receipts are durable records; operational retention should be reviewed as the user base grows.

Use mocked upstream data for repeatable automated checks rather than repeated live grocery requests.
