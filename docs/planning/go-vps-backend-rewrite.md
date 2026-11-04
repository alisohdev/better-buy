# Go VPS backend rewrite

## Goal

Replace the old backend runtimes with one Go server. Preserve the HTTP and sign-in behavior, SQLite data, queued scan lifecycle, provider collection, and maintenance jobs. Keep the existing frontend, Caddy static hosting, and browser push notifications outside this backend migration.

## Baseline and scope

The server snapshot provided on 2026-11-02 reports 1.9 GiB RAM, 519 MiB used, and 1.4 GiB available. The Bun HTTP process used 93,972 KiB RSS (91.8 MiB), and the Bun scan worker used 57,592 KiB RSS (56.2 MiB). Caddy used 50 MiB RSS. No single process used 600 MiB, and the snapshot does not show memory pressure.

The read-only reference checkout supplied the live VPS entrypoints. It contains uncommitted and untracked source changes. This work reads it as reference and writes only to the `go-rewrite` checkout. The retired TypeScript backend and VPS adapters were removed from this checkout after the Go server was added.

The rewrite covers Google and email sign-in, sessions, authenticated HTTP routes, tenant-scoped SQLite access, retailer collection, queued scan persistence and restart recovery, wishlist jobs, notifications, and maintenance. The browser API and existing SQLite database remain the compatibility boundaries. Production deployment and database migration remain separate operational steps.

## Candidate designs

### Separate HTTP and scan-worker services

Build one Go module with separate HTTP and worker commands. Both commands use the same typed configuration and SQLite package. Keep the current process boundary so an HTTP failure does not stop background scans and a scan failure does not stop API requests.

### One combined service

Run HTTP requests, scan jobs, and maintenance loops in one Go process. This removes the second service and its runtime baseline. A process failure takes down both HTTP and background work until systemd restarts it.

### Decision

Use one Go server process with bounded background goroutines. The user asked for a normal Go server without a separate scan service. Keep durable scan state in SQLite so systemd restarts can recover queued work. The expected memory reduction is not yet measured; check the server's idle memory after the production rollout.

The browser's `apps/web/public/sw.js` handles push notifications. It is separate from the VPS scan process and remains outside this backend rewrite.

## Core data shapes

- `Config` contains the database path, listen address, trusted origins, feature switches, and secrets parsed from the environment at startup.
- `Principal` contains a validated user ID. HTTP handlers receive it only after session middleware resolves the cookie.
- API request and response structs own the JSON contract. Handlers decode and validate at the HTTP boundary.
- `ScanJobState` is `queued`, `running`, `waiting`, or `stopped`.
- SQLite transactions own tenant checks, scan claims, cancellation, and terminal-state changes. The Go server uses the existing schema and database path.

## Phases

1. [x] Read the Principles section of poteto-mode.
2. [x] Ground the VPS adapters, route contract, authentication schema, persistence invariants, and current memory use.
3. [x] Compare separate Go services with one combined Go service. The user selected one server process.
4. [x] Add the Go module, configuration parser, SQLite adapter, and migration reader.
5. [x] Port authentication, CORS, session middleware, rate limiting, and health routes. Preserve the browser's sign-in behavior.
6. [x] Port locations, settings, carts, wishlist, notifications, scan reads, product pages, and history.
7. [x] Add the single-process Go HTTP server, persistent SQLite scan queue, direct SnappMarket and Okala collectors, cancellation, restart recovery, provider-operation retries, periodic stale-job reconciliation, idempotent maintenance ticks, wishlist scheduling, notifications, push delivery, and cleanup. Port the daily SQLite backup to Go and enabled Snapp campaign enrichment. Leave Okala shared-offer caching out because the VPS config disables it.
8. [x] Remove the backend TypeScript, JavaScript, and Wrangler project files and dependencies. Keep the Next and React frontend and its static export.
9. [x] Update workspace scripts and active architecture docs; Go package tests pass. Local migration, health, email sign-in/session, queued-scan creation, and cancellation smoke checks pass. Production-database compatibility remains unverified.
10. [ ] Deploy after VPS SSH access is available; measure idle memory after rollout.

## Module map

- `apps/api/cmd/server` owns the HTTP listener, scan loop, maintenance loop, and graceful shutdown.
- `internal/config` parses and validates process configuration once at startup.
- `internal/storage` owns SQLite connections, SQL statements, and transactions.
- `internal/auth` owns Google OAuth, password sign-in, password hashing, sessions, and cookie policy.
- `internal/api` owns JSON decoding, HTTP routing, CORS, authentication middleware, and response mapping.
- `internal/scans` owns scan state transitions, queue recovery, retries, and cancellation rules.
- `internal/providers` owns retailer HTTP contracts and offer normalization.
- `internal/wishlist` owns scheduled matching and notifications.
- `cmd/backup` creates consistent SQLite snapshots and prunes expired backups.

The HTTP handlers and background loops share one SQLite pool and run in one process. The scan loop uses a concurrency of one, matching the current VPS configuration. Successful provider responses are stored per scan in `scan_discovery`; validated pages are recorded in `scan_pages` and `scan_units`. A process restart replays those saved responses and requests only pages that have no checkpoint. The scan keeps one stable provider device ID and persists Snapp's one-time guest refresh claim. Provider requests time out after eight seconds and each operation can use up to three attempts. The Go maintenance loop reconciles stale jobs each minute and records five-minute maintenance tasks in `vps_maintenance_ticks`.

## Current continuation checkpoint

- [x] Read the pstack principles that apply to the migration and define the completion criteria.
- [x] Compare the queue SQL with the schema after migration 0015. Remove queries for dropped columns and use the existing per-operation attempt table.
- [x] Stop the cancellation watcher when collection returns. The first Go version waited for a watcher that only stopped after context cancellation.
- [x] Load queued scan coordinates from the saved scan context. Use three persisted attempts per full provider request identity.
- [x] Design and port the enabled Snapp campaign enrichment flow, including a frozen scan manifest and accepted or quarantined campaign contributions.
- [x] Audit the Go backend and VPS deployment files for Cloudflare, Bun, and TypeScript or JavaScript runtime references.
- [x] Build the Go packages and inspect the changed files. Keep production migration, deployment, and VPS memory measurement out of scope.

## Risks and limits

Google OAuth, cookie signing, and persisted session format must remain compatible or existing sessions may require sign-in again. Web Push subscription encryption uses the existing AES-GCM envelope, but push delivery has not been exercised against a browser subscription. Snapp campaign collection compiles but has not been exercised against live provider responses. The Okala shared-offer cache remains omitted because the VPS configuration disables it. No Go memory saving is claimed until the Go server runs on the VPS.

## Cart port design

### Data shape

A cart line is owned by `(userID, provider, productGroupKey)` and stores its quantity plus display metadata and the scan that supplied the product. A cart response combines those lines with the current successful scan for the selected location and a recommendation derived from eligible offers in the Go product groups.

### Candidates

1. Recompute cart offers by querying the saved product projection tables on each read. This matches the previous implementation directly, but those projection tables are not produced by the Go scan path yet.
2. Ask the existing Go product service for the selected scan's product groups, then use each group's current vendor offers for cart recommendations. This shares the Go grouping and offer rules with product pages and avoids adding another scan result store.

### Decision

Use candidate 2 while the Go backend does not materialize the saved product projection. The cart service owns cart persistence, quantity eligibility, location freshness, and recommendation search. The product service remains the source of group keys and vendor offers.

### Work sequence

- [x] Add the settings compatibility routes and verify `go build ./...`.
- [x] Add cart domain records, recommendation search, and tenant-scoped persistence methods.
- [x] Register the cart HTTP routes with the existing auth and rate-limit middleware.
- [x] Verify the Go build and inspect request and response JSON against the shared TypeScript contract.
- [x] Continue with wishlist, notification, push, schedule, and maintenance after carts compile.
