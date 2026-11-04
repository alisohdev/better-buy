# Wishlist and notifications

## Behavior

- Each signed-in account can save up to 30 keyword phrases and explicitly select one owned delivery location for automatic scans. Clearing that selection or removing all keywords stops new automatic work. Existing baskets are separate.
- Matching normalizes Persian/Arabic letters, half-spaces, whitespace, and Persian/Arabic digits. Every word in a phrase must occur in the product title; category and store names alone do not match. Matching is literal, not fuzzy or semantic.
- The UI defaults to Wishlist first. This sort promotes current wishlist matches before pagination and uses highest discount within each group. Price and discount sorts order all available products by their selected metric. Unavailable historical products remain last. Wishlist changes invalidate old product cursors.
- The existing five-minute Cloudflare cron enqueues both stores at 09:00 and 18:00 Asia/Tehran (05:30 and 14:30 UTC). These are start times, not guaranteed notification arrival times. Jobs drain across subsequent ticks, respecting active manual scans and configured global Workflow capacity. Jobs older than two hours are skipped instead of producing stale catch-up scans.
- Automatic scans use durable full-mode collection of the supported promotional feeds, with minimum discounts of 40% for SnappMarket and 30% for Okala. They do not scan either store's entire catalog or bypass upstream completeness checks. A missing match does not prove the item is out of stock everywhere.
- The selected location and its coordinates/revision are frozen per schedule. Changing or deleting it skips undispatched work. Failed or cancelled scans do not publish matches or replace successful history.
- For each successful scan, the notification processor checks up to three cheapest currently available products per keyword. New products in this shortlist and price drops produce one inbox notification per store scan. Unchanged matches do not repeat. Observations are isolated by account, keyword, store and location revision.
- Notifications are processed on five-minute ticks, including successful manual scans. The inbox shows the latest 50 notifications, with prices in tomans and links back to the saved scan. The inbox works without push permission or push keys.
- Web Push is one delivery channel for browser tabs and installed PWAs. It requires HTTPS, service-worker and Push API support, permission granted by a user gesture, and a registered subscription. On supported iOS/iPadOS versions, users must install the app on their Home Screen. Denied or unsupported push does not block wishlist or inbox use.
- Subscription secrets are encrypted with BOX_KEY. The push outbox retries transient failures up to five times and removes expired subscriptions on HTTP 404/410. Notification tags collapse replayed sends: delivery is at least once, not exactly once. Credentials and raw subscription endpoints are never logged. Only recognized browser push-service HTTPS endpoints are accepted, without redirects.

## Activation and release

1. Build and run tests locally; never use the production database for fixtures.
2. Confirm the Cloudflare account, Worker, D1 database and exact release revision. Back up the target database and verify the backup before applying migrations.
3. Apply migrations 0013_wishlist.sql and 0014_wishlist_schedule.sql for wishlist, inbox, push-outbox and scheduling tables. Migration 0015_remove_scan_collection_limits.sql drops obsolete budget columns and must be coordinated with the updated Worker; the old Worker references those columns. Historical scans and baskets are preserved.
4. Keep the existing SCAN_WORKFLOW binding. WISHLIST_SCHEDULE_ENABLED=true enables automatic wishlist jobs independently of SCAN_WORKFLOW_ENABLED, which still controls manual execution. Setting WISHLIST_SCHEDULE_ENABLED=false stops new automatic starts and queue dispatch; already-running Workflows still reconcile and inbox/push processing continues.
5. Generate one stable P-256 VAPID pair locally: export the uncompressed EC public point and private scalar as unpadded base64url. Keep the pair across deployments; rotating it requires browser resubscription.
6. Configure VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT as Worker secrets using wrangler secret put. The subject must be a valid mailto: address or HTTPS contact URL. Never commit private keys or local .dev.vars. Only the public key is returned to clients. Without all three values, push is unavailable but the inbox continues to work.
7. Build the static export, dry-run the Worker build, publish with explicit deployment authority, then verify authenticated wishlist CRUD, the default location, both scheduled store scans, inbox delivery and real device push separately. A mocked push-service response or encrypted-payload test does not prove delivered device notifications.

## Operational limits

Each user's delivery location requires its own store scans; collection is not shared globally. Workflow/D1/provider capacity can delay or expire queued jobs. There is no application-wide Workflow concurrency cap. Scheduling does not override active-user exclusivity or provider limits. Notifications and receipts are durable records; operational retention should be reviewed as the user base grows.

In Next development mode with Worker DEV_MODE=true, the wishlist modal offers an immediate full scheduled scan for the signed-in account. SnappMarket and Okala run sequentially, with provider failures and real notification results shown separately. Closing the modal keeps monitoring active; reloading resumes the saved user-scoped run. The browser path uses the authenticated account and validates the configured application origin. The signed wishlist:scan CLI remains available for selecting another local user.

For local cron timing tests use Wrangler scheduled-event testing. Use mocked upstream data for repeatable automated tests rather than repeated live grocery requests.

### Scan collection limits

Full scans enumerate all discovered stores, supported campaigns and provider pages
until verified terminal evidence. Application request, page, offer, discovery,
response-size and overall duration budgets are removed, including the legacy
collector timeouts. Independent users can run scans concurrently; one active scan
per user remains an ownership and consistency rule.

Migration 0015 removes the obsolete budget columns. Apply local migrations before
starting the updated Worker (the normal dev command does this automatically).
Existing failed scans stay failed; use the modal button to start a fresh run.
The CLI waits indefinitely by default; --timeout-ms optionally bounds only its polling.
Network request timeouts, finite retries, dispatch recovery, authentication and
provider contract checks remain. Provider and Cloudflare platform limits still
apply. No new caching is introduced.
