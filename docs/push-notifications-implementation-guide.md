# Web push notifications: implementation and porting guide

Based on the Better Buy source inspected on 2026-11-16. This is an implementation handoff, not a claim that another module has already been built. Examples below use a generic `notifications` module; current repository names are identified explicitly.

## 1. Choose the integration boundary

**Another module in this app:** reuse `push_subscriptions`, `/api/push/subscriptions`, the VAPID pair, browser registration, and `/sw.js`. A browser subscription belongs to an account/device/origin, not to a business module. Add a generic notification/outbox layer or a module-specific outbox and feed it business events. Do not register competing service workers at `/` or make a subscription per module.

**Another application/origin:** provision its own HTTPS origin, service worker, subscription storage, authentication, encryption key and preferably its own VAPID pair. Existing subscriptions cannot simply be copied to a different origin. Users must subscribe there.

## 2. End-to-end flow

1. Authenticated user presses Enable notifications.
2. Frontend checks browser support and requests permission from that user action.
3. Frontend registers the service worker, obtains or creates a PushSubscription, and POSTs its endpoint and encryption keys to the API.
4. API validates it, derives its endpoint identity, encrypts it, and saves it against the authenticated user.
5. A business event creates a durable notification and one outbox row per current subscription **in the same database transaction**.
6. A background worker claims due outbox rows, decrypts subscriptions and sends encrypted Web Push requests signed with VAPID.
7. Browser push service accepts the request; browser later invokes the worker's `push` event, which displays the OS notification.
8. Clicking opens an allowed application URL. The destination still performs normal authentication and ownership checks.
9. Inbox read state is updated separately. Push acceptance does not prove display, reading, or clicking.

Delivery is at least once: a crash after send but before database acknowledgement can produce a duplicate. Use a stable notification ID/tag; do not promise exactly-once delivery.

## 3. Repository source map

| Concern                                                        | Existing file                                                               |
| -------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Authenticated routes and response shapes                       | `apps/api/internal/api/wishlist.go`                                         |
| Subscription validation, encryption, ownership and persistence | `apps/api/internal/wishlist/service.go`                                     |
| Notification creation and durable delivery worker              | `apps/api/internal/wishlist/maintenance.go`                                 |
| VAPID validation and Web Push HTTP sender                      | `apps/api/internal/wishlist/push_sender.go`                                 |
| Config loading                                                 | `apps/api/internal/config/config.go`                                        |
| Server/maintenance wiring                                      | `apps/api/cmd/server/main.go`                                               |
| Key generation                                                 | `apps/api/cmd/vapid-keygen`                                                 |
| Operator push test                                             | `apps/api/cmd/push-test`, `apps/api/internal/wishlist/push_test_command.go` |
| Browser helpers                                                | `apps/web/src/features/alerts/push.ts`                                      |
| Permission/subscription UI                                     | `apps/web/src/features/alerts/PushSettings.tsx`                             |
| Background reception and click handling                        | `apps/web/public/sw.js`                                                     |
| Initial database schema                                        | `apps/api/internal/storage/migrations/app/0013_wishlist.sql`                |

## 4. Configuration and infrastructure

Set backend `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, and `BOX_KEY`. The subject is a valid `mailto:` contact or HTTPS URL. Public/private VAPID values must form the same P-256 keypair. This project validates the 65-byte uncompressed public key and 32-byte private scalar. Never put the private key or BOX_KEY into frontend variables, bundles or logs.

Generate keys with `go -C apps/api run ./cmd/vapid-keygen`; store output in your secret manager or protected service environment. Keep the pair stable across deployments. Rotation requires a deliberate browser re-subscription migration. Preserve BOX_KEY so stored subscriptions remain decryptable. For a new implementation use a random 32-byte encryption key, rather than copying the legacy padding/truncation fallback in `boxKey`.

Production requires HTTPS and a service worker served from the correct origin/scope. Serve `/sw.js` as JavaScript with `Cache-Control: no-cache`; registration uses `updateViaCache: "none"`. Supply notification icons and a web manifest. Allow outbound HTTPS to the supported push services. No Firebase SDK or Firebase service-account key is needed for this implementation; Chrome's subscription endpoint may use FCM automatically.

## 5. Tables to implement in a new module

The following is a **proposed generic schema**, not an existing migration. Enable SQLite foreign keys on every connection. For another database, adapt timestamp and conflict syntax.

```sql
CREATE TABLE push_subscriptions (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL,
 encrypted_subscription TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE INDEX push_subscriptions_owner ON push_subscriptions(user_id);

CREATE TABLE notifications (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL,
 module TEXT NOT NULL,
 event_key TEXT NOT NULL,
 title TEXT NOT NULL,
 body TEXT NOT NULL,
 target_url TEXT NOT NULL,
 created_at TEXT NOT NULL,
 read_at TEXT,
 UNIQUE(user_id, module, event_key)
);
CREATE INDEX notifications_inbox ON notifications(user_id, created_at DESC, id);

CREATE TABLE push_deliveries (
 notification_id TEXT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
 subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0,
 next_attempt_at TEXT NOT NULL,
 lease_token TEXT,
 lease_until TEXT,
 delivered_at TEXT,
 PRIMARY KEY(notification_id, subscription_id)
);
CREATE INDEX push_pending ON push_deliveries(delivered_at, next_attempt_at);

-- Optional per-module opt-out, independent of browser permission.
CREATE TABLE notification_preferences (
 user_id TEXT NOT NULL,
 module TEXT NOT NULL,
 push_enabled INTEGER NOT NULL DEFAULT 1,
 updated_at TEXT NOT NULL,
 PRIMARY KEY(user_id,module)
);
```

`event_key` is a stable business-event identifier, such as `order:123:shipped:v1`; retries must reuse it. `id` on subscriptions is the SHA-256 hex digest of the endpoint in this project. Store the entire endpoint/keys JSON encrypted, not just the auth secret. Associate ciphertext with `push:{userID}:{subscriptionID}` as authenticated additional data. Current encryption is AES-GCM with a fresh nonce prepended to ciphertext and standard Base64 encoding.

All joins and updates must check matching user IDs. The sample schema does not enforce cross-table ownership with composite foreign keys, so enforce it transactionally in code or strengthen the schema. Add user foreign keys/account-deletion cleanup to fit the host application's identity model. Decide retention for old notifications and exhausted delivery rows; the generic schema alone does not clean them up.

## 6. Current tables and what to reuse

| Table                      | Role                                                          | Needed for generic push?                                  |
| -------------------------- | ------------------------------------------------------------- | --------------------------------------------------------- |
| `push_subscriptions`       | Encrypted account/device subscription                         | Yes; reuse in the same app                                |
| `wishlist_notifications`   | Persistent inbox notification including scan/location/matches | Replace with generic notification or module table         |
| `wishlist_push_deliveries` | Retry state per notification/device                           | Reuse pattern; currently tied to wishlist notification FK |
| `wishlist_items`           | Search phrases and discount preferences                       | Only wishlist business logic                              |
| `wishlist_preferences`     | Default location                                              | Only wishlist business logic                              |
| `wishlist_seen`            | Prior matches/prices for deduplication                        | Replace with the new module's event deduplication         |
| `wishlist_scan_receipts`   | Leased scan processing and completion receipts                | Only scan processing; generalize if events need claims    |

The exact initial schema is included in the appendix. Later migrations must also be applied when deploying the existing app; the initial wishlist schema is not a full database bootstrap.

## 7. Backend implementation steps

1. Add migrations before releasing code that reads new tables. Back up the database and verify foreign-key behavior.
2. Expose the VAPID public key to the authenticated settings client. Current app returns it in the wishlist settings response; a generic app can use `GET /api/push/config` returning `{data:{publicKey:"..."}}`.
3. Implement authenticated POST/DELETE subscription routes. Derive user identity from the session, never request JSON. Check origin/CSRF using the host app's middleware, enforce body limits and rate limits.
4. Validate endpoint and keys before storing or sending. Current code requires HTTPS, no userinfo/port/fragment, endpoint length <=2048, P-256 key 65 bytes beginning with 4, auth key 16 bytes, Base64URL decoded. Its host allowlist covers FCM, Apple, Mozilla and Windows push services. Recheck supported provider hosts when porting; do not accept arbitrary URLs (SSRF).
5. Upsert subscription only for the same owner. The existing implementation allows five subscriptions per user, supports same-owner resync, and refuses reassignment of an endpoint to another account.
6. On business events, check module preferences, deduplicate by event_key, insert notification, then insert per-device outbox rows from subscriptions belonging to that user. Commit atomically. Users without subscriptions can still receive an inbox notification.
7. Run the worker continuously or on a durable schedule. HTTP handlers must not depend on a long synchronous send completing.
8. Claim due rows atomically with a random lease token, increment attempts and set lease expiry. Update completion/retry only with the same token. Recover abandoned leases after expiry.
9. Send using `github.com/SherClockHolmes/webpush-go` (this repo pins v1.4.0), decrypting immediately before use. Existing sender timeout is 5 seconds, TTL 3600 seconds, urgency normal, and it drains/closes the HTTP response body.
10. Treat 2xx as push-service acceptance. Delete subscription on 404/410 (dependent delivery rows cascade). Retry temporary failures; for a new module distinguish 429/5xx/timeouts from permanent payload/config errors and respect Retry-After. Alert on auth/config failures instead of repeatedly retrying every device.
11. Expose authenticated inbox/read endpoints and perform ownership checks on the notification destination.
12. Add retention, failed-delivery metrics and an operator test command. Avoid logging endpoints, subscription keys, private keys or decrypted payload secrets.

Current worker specifics: due query selects at most five rows, claims a two-minute lease, and allows at most five attempts. Retry delay is 5 minutes times 2 to the pre-claim attempt count (5, 10, 20, 40, 80 minutes; the fifth failed row is then exhausted). The current implementation retries all failures except 404/410, and names its acceptance timestamp `delivered_at`. For a new schema consider `accepted_at` to avoid implying device delivery.

## 8. API contracts

| Method/path                         | Input                            | Current result                                                            |
| ----------------------------------- | -------------------------------- | ------------------------------------------------------------------------- |
| POST `/api/push/subscriptions`      | `{endpoint, keys:{p256dh,auth}}` | 201 `{data:{ok:true}}`                                                    |
| DELETE `/api/push/subscriptions`    | `{endpoint}`                     | 200 `{data:{ok:true}}`; owner-scoped                                      |
| GET `/api/notifications`            | Session                          | 200 `{data:[...]}` inbox                                                  |
| POST `/api/notifications/{id}/read` | Session                          | 200 `{data:{ok:true}}`                                                    |
| GET `/api/wishlist`                 | Session                          | Includes settings/public key; inspect service Read response when adapting |

POST errors include 400 `INVALID_SUBSCRIPTION`, 503 `PUSH_NOT_CONFIGURED`, and 409 `SUBSCRIPTION_LIMIT_OR_CONFLICT`. API body reader caps at 8192 bytes. Keep your generic config endpoint and module preference routes separate from these existing contracts unless deliberately versioning them.

## 9. Frontend implementation steps

1. Detect secure context plus ServiceWorker, PushManager and Notification support. Show clear unsupported/permission-denied states.
2. On settings mount, register `/sw.js`, wait for readiness with a bounded timeout (current helper: 12 seconds), inspect permission and existing subscription. Do not trigger a permission prompt automatically.
3. On an explicit Enable click, request permission. If denied, explain that the user must change browser settings. If dismissed, leave retry available.
4. Decode the Base64URL VAPID public key to bytes. Reuse an existing subscription or call `pushManager.subscribe({userVisibleOnly:true, applicationServerKey})`.
5. POST endpoint and `subscription.toJSON().keys` to the authenticated API. Show enabled only after persistence succeeds. If a newly created subscription fails to save, unsubscribe it to avoid an orphan; handle retry for an existing unsynced subscription.
6. On Disable, DELETE the server record first, then unsubscribe locally. Report partial failure accurately. Do not confuse browser permission with server synchronization.
7. Before logout/account switch, remove the account's server subscription, unsubscribe, and close visible notifications. The existing helper performs this before sign-out while authentication still exists. Handle cleanup failure explicitly to prevent another account inheriting the device association.
8. Reconcile subscription on future visits; handle changed VAPID keys by intentional unsubscribe/re-subscribe. Background renewal handling is a follow-up design concern: the current worker has no `pushsubscriptionchange` handler.
9. Add module-specific preference switches without requesting browser permission separately for each module.
10. On click navigation, preserve target through login if required; always reauthorize access after login. Mark read when appropriate, not merely because a push was sent.

## 10. Service worker payload and handling

```json
{
  "id": "notification-uuid",
  "title": "Order shipped",
  "body": "Your order is on its way.",
  "url": "/orders/123"
}
```

Copy the event lifecycle pattern from `apps/web/public/sw.js`: install/activate, `push` parsing with safe fallback, `event.waitUntil(registration.showNotification(...))`, and `notificationclick` with `waitUntil`. Use `id` as the notification tag, set icon/badge and localized language/direction. Keep messages short and non-sensitive because lock-screen previews may be visible.

Validate URL origin both when receiving and clicking. Allow only same-origin HTTP(S), use a safe inbox fallback, close the notification on click, focus an existing exact matching window or open a new window. Do not trust a payload URL to bypass authorization. Avoid importing React/browser window APIs into the service worker.

The current worker does not cache application pages or implement offline mode. Push does not require adding a cache layer.

## 11. Verification and rollout checklist

- [ ] Subscription accepted with valid keys; malformed endpoints/keys rejected; unconfigured server returns clear status.
- [ ] Account A cannot delete, read or take over account B's subscription/notification.
- [ ] Same-device resync is idempotent; multiple devices get independent delivery rows.
- [ ] Duplicate business events create one notification; notification/outbox inserts roll back together.
- [ ] Worker races, process restart, expired lease and retry exhaustion are tested.
- [ ] 2xx, 404, 410, 429, 5xx and timeout responses are covered using a mock transport.
- [ ] Permission denied/dismissed, unsupported browser, failed save, failed unsubscribe and logout are covered.
- [ ] Real opt-in device receives a notification with the page closed and follows the correct authorized deep link.
- [ ] Verify supported desktop/mobile browsers on physical devices; permission and installation requirements vary by platform. Check current platform documentation before promising support.
- [ ] Confirm service worker MIME/scope/cache headers, HTTPS, icons, manifest, private-key secrecy and outbound connectivity.
- [ ] Deploy additive migration, backend worker/API, then frontend assets/worker. Keep old payload fields compatible during rollout.
- [ ] Monitor queue age, retries, exhausted rows, expired subscriptions and acceptance rate. Keep backups and rollback binaries.

Do not send a production test push to a person without their authorization. Use a dedicated consenting test account/device. The existing operator tool can be inspected with `go -C apps/api run ./cmd/push-test --help`; use that tool's actual flags rather than putting session cookies or secrets into documentation.

## 12. Suggested implementation order

Database migration → shared subscription service → authenticated API → event-to-outbox transaction → leased sender worker → frontend enable/disable settings → service-worker reception/click routing → unit/integration tests → consenting device acceptance test → deployment and monitoring.

## Appendix: exact initial wishlist migration

This is copied verbatim from `0013_wishlist.sql` for reference, not a standalone generic module migration.

```sql
CREATE TABLE wishlist_items (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  phrase TEXT NOT NULL,
  normalized_phrase TEXT NOT NULL,
  tokens_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(user_id, normalized_phrase)
);
CREATE TABLE wishlist_preferences (
  user_id TEXT PRIMARY KEY,
  default_location_id TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE wishlist_notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  scan_id TEXT NOT NULL,
  location_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  matches_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT
);
CREATE INDEX wishlist_notifications_inbox ON wishlist_notifications(user_id, created_at DESC, id);
CREATE TABLE wishlist_seen (
  user_id TEXT NOT NULL,
  wishlist_id TEXT NOT NULL REFERENCES wishlist_items(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  product_id TEXT NOT NULL,
  price REAL NOT NULL,
  PRIMARY KEY(user_id, wishlist_id, scope, product_id)
);
CREATE TABLE wishlist_scan_receipts (
  scan_id TEXT PRIMARY KEY REFERENCES scans(id) ON DELETE CASCADE,
  lease_token TEXT NOT NULL,
  lease_until TEXT NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  encrypted_subscription TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX push_subscriptions_owner ON push_subscriptions(user_id);
CREATE TABLE wishlist_push_deliveries (
  notification_id TEXT NOT NULL REFERENCES wishlist_notifications(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  lease_token TEXT,
  lease_until TEXT,
  delivered_at TEXT,
  PRIMARY KEY(notification_id, subscription_id)
);
CREATE INDEX wishlist_push_pending ON wishlist_push_deliveries(delivered_at, next_attempt_at);

```
