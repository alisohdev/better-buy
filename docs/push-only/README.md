# Push notifications only: backend + frontend handoff

This folder contains a minimal Go + SQLite backend and TypeScript/React frontend adapted from Better Buy. No wishlist, scanning, inbox, campaign or business-module tables are required. It is integration code: connect your application's database, session authentication and HTTP middleware. The minimal sender is synchronous and has no durable retry queue; use your existing job runner if reliable retries are required.

## Files

- schema.sql: the single subscription table and owner index.
- backend.go: authenticated subscription routes, encryption, validation, sending and expired-device cleanup.
- push.ts: browser registration, subscribe/save, disable/unsubscribe and logout cleanup.
- PushButtons.tsx: example React controls with error/busy states.
- sw.js: push reception, visible notification and safe same-origin click navigation.
- vapid-keygen.go.txt: standalone key generator; copy as main.go in a separate command directory.

## Backend steps

1. Add `github.com/SherClockHolmes/webpush-go v1.4.0` to your Go module (the version used by this project).
2. Apply schema.sql to SQLite. Keep the same table in this app if already present; do not run CREATE TABLE twice.
3. Generate VAPID keys with the included generator. Set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT (mailto:you@example.com or an HTTPS contact URL). Generate BOX_KEY as 32 random bytes encoded as 64 hex characters. Keep private values server-side and preserve them across deployments.
4. Put backend.go in a `push` package, and create the service using your database and secrets:

```go
service := &push.Service{
 DB: db,
 Config: push.PushConfig{PublicKey: os.Getenv("VAPID_PUBLIC_KEY"), PrivateKey: os.Getenv("VAPID_PRIVATE_KEY"), Subject: os.Getenv("VAPID_SUBJECT")},
 BoxKey: os.Getenv("BOX_KEY"),
}
if err := push.ValidatePushConfig(service.Config); err != nil { log.Fatal(err) }
// Validate BOX_KEY as exactly 64 hex characters at startup.
service.Register(mux, func(r *http.Request) (string, bool) {
 // Replace this with YOUR trusted session middleware/context API.
 user, ok := yourAuth.UserFromRequest(r)
 return user.ID, ok
})
```

The auth callback above is intentionally application-specific, not a supplied authentication implementation. Wrap mutation routes in your existing same-origin/CSRF protection and rate limiting. Do not trust user IDs sent by the frontend. The code refuses endpoint reassignment between accounts and allows five device subscriptions per account.

5. Call from a trusted backend module when it needs to notify a user:

```go
accepted, failed, err := service.SendToUser(ctx, recipientUserID, push.Message{
 ID: eventID, Title: "Your update", Body: "Open the app to see more.", URL: "/your-module/123",
})
```

Use a stable event ID, same-origin URL and short non-sensitive message. The recipient must be authorized for that event. Do not expose SendToUser directly to arbitrary browser requests. Inspect err and failed count; a successful call does not imply every subscription accepted the message. A 2xx means push-service acceptance, not device receipt. Expired 404/410 subscriptions are deleted. This minimal implementation reports other failures without retrying; schedule retries in your application's job system if needed. Notifications can be duplicated on retry, so retain a stable ID/tag.

## Frontend steps

1. Copy push.ts and PushButtons.tsx into the frontend and render PushButtons for signed-in users.
2. Copy sw.js to the public root so it is served as `/sw.js`, with JavaScript MIME type and Cache-Control: no-cache. Merge its event handlers into an existing root service worker rather than registering a competing one.
3. Supply `/icons/icon-192.png` or change the icon and badge paths in sw.js.
4. Use HTTPS in production. Enable is a user action; never request notification permission on initial page load. If permission is denied, the user must change browser permissions manually.
5. Before logout, call `await cleanupPushBeforeSignOut()` while the session still exists, then sign out. If cleanup fails, handle it explicitly before allowing account switching.
6. Existing subscriptions are resaved when Enable is pressed. For automatic account reconciliation, inspect getSubscription on authenticated mount and sync it only after verifying the device's account ownership. Do not repeatedly prompt for permission.
7. Deep-link targets must perform normal authentication/authorization. Reuse subscriptions and the VAPID pair when adding another module in the same origin. A different origin requires a new browser subscription. Key rotation requires intentional unsubscribe/re-subscribe handling.

## Endpoints

| Route                          | Input                           | Response              |
| ------------------------------ | ------------------------------- | --------------------- |
| GET /api/push/config           | authenticated session           | 200 `{publicKey}`     |
| POST /api/push/subscriptions   | `{endpoint,keys:{p256dh,auth}}` | 201, no response body |
| DELETE /api/push/subscriptions | `{endpoint}`                    | 204                   |

Errors: 401 unauthenticated, 400 invalid input, 409 subscription conflict/limit, 500 storage error, 503 missing/invalid push configuration. The config response differs from Better Buy's wishlist response; use the provided frontend with these routes.

## Database fields

| Column                 | Purpose                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------- |
| id                     | SHA-256 hex of the endpoint; stable device subscription identity                      |
| user_id                | Authenticated account owner                                                           |
| encrypted_subscription | AES-GCM encrypted endpoint and keys; Base64 nonce+ciphertext; owner/id bound with AAD |
| created_at             | UTC creation timestamp                                                                |

Endpoint and keys are sensitive. Never log them or include real secrets in a handoff. Restrict backup/database access and add account-deletion cleanup. The endpoint host allowlist is copied from this project's supported providers; review it for your supported platforms before rollout.

## Verification before production

Check valid/invalid subscription input, account isolation, enable/disable/logout, multiple devices, expired subscription cleanup and sender failures. On a consenting test device, enable push, close the page, send a test message and verify the notification click reaches the authorized module. Verify your actual target browsers/devices; this handoff does not claim physical-device testing. This package was prepared as a source handoff, not deployed into another module.
