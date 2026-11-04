# Better Buy architecture

## Runtime

The Go API in `apps/api` owns authentication, HTTP routes, provider collection, SQLite persistence, and background maintenance. The operating system starts one Go process. Inside it, the HTTP server, a single-consumer persistent scan queue, and bounded maintenance loops run together. Queued scans survive process restarts because their state is stored in SQLite.

The Next and React frontend in `apps/web` is built as a static export. `packages/shared` supplies TypeScript contracts and display helpers to the frontend. The `/sw.js` file runs only in a user's browser for Web Push; it does not run on the VPS.

## Backend boundaries

| Package                                  | Responsibility                                                                                                  |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `cmd/server`                             | Configuration, SQLite startup, HTTP listener, scan queue, maintenance goroutines, and graceful shutdown         |
| `cmd/migrate`                            | Apply embedded SQLite application and scan-engine migrations                                                    |
| `internal/api`                           | HTTP routes, JSON validation, CORS, authentication middleware, and response mapping                             |
| `internal/auth`                          | Email and Google sign-in, sessions, password hashing, and cookie compatibility                                  |
| `internal/scans`                         | Durable scan submission, idempotency, cancellation, restart recovery, retries, progress, and result persistence |
| `internal/providers`                     | SnappMarket and Okala HTTP collection and offer normalization                                                   |
| `internal/storage`                       | SQLite connection, WAL settings, and embedded migrations                                                        |
| `internal/wishlist`                      | Wishlist reads/writes, scheduled scans, match notifications, push delivery, and bounded cleanup                 |
| `internal/products` and `internal/carts` | Product grouping, scan reads, cart persistence, and recommendations                                             |

All user-owned reads and writes are scoped by authenticated user ID. Scan ownership, active-scan exclusivity, cancellation, and result publication are enforced in SQLite transactions. The queue processes one scan at a time and retries transient collection errors with bounded delays.

## Frontend boundaries

React components own interaction state. Query hooks own API reads, polling, and mutations. `packages/shared` provides the request and response schemas, UI types, grouping helpers, and money formatting used by the web app. The frontend talks to the Go API over HTTP.

Browser push uses the root-scoped `/sw.js` registration and same-origin notification links. The service worker has no fetch handler and does not cache authenticated responses.

## Run and verify

From the repository root:

```sh
pnpm dev
pnpm build
go -C apps/api run ./cmd/migrate
```

`pnpm dev` starts the Go server and Next development server. `pnpm build` builds the web app and compiles every Go package. The Go API reads configuration from process environment variables.

## Incomplete work

Snapp store-campaign enrichment and Okala shared-offer caching are not in the Go collector. Compatibility with the existing production SQLite database, complete API/provider parity, real push delivery, and VPS idle memory remain unverified. Do not infer a Go memory reduction from language choice; measure RSS after a separately authorized rollout.
