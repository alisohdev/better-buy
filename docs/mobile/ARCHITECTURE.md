# Mobile M0 architecture

M0 is a separate Expo development app and Go module under `apps/mobile`. The web app and server retain their existing behavior. The engine uses synthetic fixtures and never contacts retailers.

## Boundary and ownership

React Native calls an Expo module backed by generated GoMobile Java and Objective-C bindings. The bridge exposes version, start, status, cancel, controlled error, and logs. All native invocations are Expo `AsyncFunction` calls. Go starts a goroutine and returns immediately. The app root coordinator polls the latest immutable JSON snapshot after each previous poll completes. Go allows one scan at a time and publishes cancellation and completion under the same lock.

Expo SQLite owns the mobile database. A successful snapshot is saved by a single parameterized upsert; a cancelled scan cannot overwrite it. Startup restores the last persisted snapshot. An in-progress scan is not resumed after process death, and a process kill between engine completion and the SQLite commit can lose that particular result. Go does not open the database. Using Go-owned SQLite would be a viable alternative if durable mobile engine checkpoints become mandatory, but would require on-device driver and lifecycle validation and replacing Expo SQLite for the same data.

## Server reuse audit

| Existing server area            | Mobile reuse path                                                                                                                                                                                                                                                                                                                   |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider HTTP and normalization | Extract provider parsing and normalization as pure code with injected transport, location policy and context. The existing transport has deadlines and provider retries, but request reservation and response replay depend on a server scan claim. Preserve those policies behind interfaces. Do not bind the collectors directly. |
| Scan engine                     | Reuse context cancellation, progress snapshots, deduplication identities and completeness rules. The server queue implements leases, idempotency, user ownership, transaction fencing and restarts through SQLite. M0 does not port this queue.                                                                                     |
| Products and carts              | Extract grouping and bounded basket search from their SQL-backed service wrappers. Preserve vendor-level identity, freshness, location validity, and the optimizer's budget and partial-result semantics.                                                                                                                           |
| Server-only dependencies        | HTTP handlers, authenticated and guest identities, account ownership, environment-based server configuration, and wishlist cron/push remain on the server. A later permissioned mobile feature can evaluate foreground scheduling and local notifications; periodic background work is a separate platform constraint.              |

References: [provider collector](../../apps/api/internal/providers/collect.go), [request journal](../../apps/api/internal/providers/journal.go), [server queue](../../apps/api/internal/scans/queue.go), [products](../../apps/api/internal/products/products.go), [carts](../../apps/api/internal/carts/carts.go), [prior acquisition audit](../snapp-market-acquisition-audit.md).

## Diagnostics

Go emits only fixed event names, stable codes, random scan IDs, engine version, elapsed milliseconds and request counts through a `slog` JSON handler. The 32-event ring lives in memory and resets on process death. The app explicitly shares sanitized JSON on request with app and engine versions. The export excludes saved offers, coordinates, response bodies and exception text. The fixture error is a stable code and bridge exceptions map to a generic local code.

Remote monitoring is off. No Sentry SDK, transport, or automatic report is enabled in this slice. If configured and reviewed, initialize only after explicit consent, make delivery non-blocking, and allowlist diagnostic fields before send. Keep local diagnostics independent of it. TanStack Query and Expo Notifications are deferred because native polling and a single local snapshot suffice.
