# Go VPS production readiness

The target runtime is one Go server process with a persistent SQLite scan queue. The Next frontend is built as static files for the existing web host. This checklist records work that must pass before replacing the current VPS services. No rollout is authorized by this document.

## Runtime and queue

- [ ] Build the Go binary for the VPS operating system and architecture.
- [ ] Start the server under systemd with one process; confirm HTTP, queued scans, schedule, notifications, and cleanup run together.
- [ ] Verify graceful shutdown requeues an active scan and startup recovers queued/running/waiting jobs.
- [ ] Verify cancellation, bounded provider retries, idempotent starts, active-scan exclusivity, and recovery after forced termination.
- [ ] Measure request duration, scan duration, provider retries, queue age, and failure codes with sanitized logs.
- [ ] Measure Go idle and peak RSS on the actual VPS. Compare the same workload and accounting method against the recorded previous-process snapshot.

## SQLite data and migrations

- [ ] Take a consistent backup of the existing database and restore it to an isolated copy.
- [ ] Run the embedded Go migrations against that copy; verify users, sessions, locations, scans, deals, wishlist, carts, and notification counts.
- [ ] Confirm indexes, foreign keys, WAL mode, synchronous mode, and single-process database ownership.
- [ ] Exercise migration failure and rollback on a disposable copy.
- [ ] Define retention for scan history, deals, sessions, rate-limit rows, maintenance ticks, and push deliveries.
- [ ] Verify disk-space monitoring and backup rotation for the SQLite database and WAL files.

## Authentication, security, and privacy

- [ ] Verify email sign-in, Google OAuth, session cookies, sign-out, trusted origins, CORS, and existing-session behavior on staging.
- [ ] Keep production `DEV_MODE=false`; verify the dev-only login and wishlist routes return 404.
- [ ] Keep secrets in systemd environment configuration or a secrets manager, never in tracked files or logs.
- [ ] Verify BOX_KEY compatibility with retained encrypted rows and keep it stable through rollout.
- [ ] Verify VAPID key configuration, push endpoint host allowlisting, redirect rejection, and expired-subscription cleanup.
- [ ] Review request size limits, per-user rate limits, security headers, and sanitized error responses.
- [ ] Keep exact locations, credentials, OAuth tokens, push endpoints, and raw provider responses out of logs.

## API and provider compatibility

- [ ] Compare all HTTP routes and JSON responses with the frontend contracts, including errors and pagination.
- [ ] Verify Snapp guest access, pagination completeness, normalization, cancellation, and retry behavior using fixtures and a controlled staging run.
- [ ] Verify Okala nearby-store and campaign collection, threshold/stock rules, incomplete-pagination handling, and safe failures.
- [ ] Explicitly decide whether to port Snapp store-campaign enrichment and Okala shared-offer caching; both are absent from the current Go collector.
- [ ] Verify previous successful scan results remain available after a later scan fails or is cancelled.
- [ ] Verify wishlist schedules, notification deduplication, inbox reads, and real browser push delivery.

## Web build and delivery

- [ ] Build the Next static export and verify API requests reach the Go server through the production reverse proxy.
- [ ] Verify Caddy serves the static frontend and routes `/api/*` and `/healthz` to the Go listener.
- [ ] Verify secure cookies and Google OAuth redirect URLs through the production domain.
- [ ] Test service restart, process failure, disk-full behavior, and SQLite backup restoration on staging.
- [ ] Record a rollback plan for the Go binary, static assets, environment configuration, and database migrations.
- [ ] Roll out only after a separate explicit deployment authorization.

## Current status

The Go implementation and frontend static export compile locally. Full API/provider parity, existing-production-database compatibility, systemd behavior, actual push delivery, and VPS memory remain unverified. Snapp store-campaign enrichment and Okala shared-offer caching are not implemented. Do not claim a memory reduction until the Go process is measured on the VPS.
