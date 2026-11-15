# Better Buy

Better Buy compares discounted products from SnappMarket and Okala for saved delivery locations in Tehran. Signed-in users can keep scan history, provider carts, wishlist alerts, and browser push notifications.

## Architecture

- `apps/api` is the backend, written in Go. One server process serves HTTP, drains the durable SQLite scan queue, runs wishlist schedules, and delivers notifications.
- `apps/web` is the Next and React frontend. Its production build is a static export in `apps/web/out`.
- `packages/shared` contains TypeScript contracts and helpers used by the frontend.
- The browser's `/sw.js` handles web push events. Scan work runs in the Go server and does not use a separate process.

## Local development

Install the frontend dependencies and Go toolchain, then set the environment variables listed in `.env.example` in your shell. The server does not automatically load `.env` files.

```sh
pnpm install
go -C apps/api run ./cmd/migrate
pnpm dev
```

The API listens on `127.0.0.1:8787`; the web development server listens on `127.0.0.1:3000`. For local phone registration, set `DEV_MODE=true` and `SMS_PROVIDER=mock`; see [phone authentication](docs/phone-auth.md).

Development assets use `apps/web/.next-dev`, separate from the production/browser-test build in `apps/web/.next`. This lets browser tests build the exported frontend without overwriting a running dev server. If an older dev server has missing JavaScript chunks after a build, stop and restart `pnpm dev`. Open `http://127.0.0.1:3000` specifically; another app can occupy the IPv6 `localhost:3000` address. In development, authentication requests go to `http://127.0.0.1:8787/api/auth/get-session` by default, not the frontend port.

### Guest access

The root page opens the application without requiring login. Guests can choose delivery locations, start real scans, inspect results, and view their temporary scan history. Sign-in is available at `/?page=login`; the login screen also links back to guest browsing. Banners and dismissible notices explain temporary data and prompt sign-in for wishlists, notifications, and saved carts.

Run `pnpm api:migrate` before starting the updated API to install `0023_guest_sessions.sql`. Guest access uses a random HttpOnly, SameSite=Lax cookie, valid for 24 hours; HTTPS uses a Secure, host-bound cookie. Only the cookie hash is stored server-side. Guest locations and scans are isolated by a separate guest identity, never by a public shared account. Guest creation is limited to 10 new sessions per minute per client IP, and scan starts to 10 requests per hour per IP across cookies, in addition to per-session read/start limits. These guest limits remain enabled when ordinary API limits are disabled. The deployed loopback Caddy proxy supplies the client IP through its overwritten `X-Real-IP` header; forwarded headers from non-loopback clients are ignored.

Guest locations (up to 20) are validated and stored in this browser's `localStorage` under `better-buy.guest-locations.v1`. No authentication credentials are stored there. If storage is unavailable, browsing/scanning still works and a notice explains that location recovery is unavailable. A new guest session restores those locations. After sign-in, locations are imported through an authenticated, retry-safe endpoint. Existing account locations at the same coordinates are reused, existing account defaults are preserved, and each browser copy is removed only after the server confirms it. A failed import keeps unconfirmed locations and offers retry. Guest scan results do not migrate into the account; run a new scan after login for account-owned history.

Expired guest sessions immediately lose access. On new guest-session creation, expired guest records, locations, and scans are removed once no scan is queued/running; active work is not deleted mid-flight. Clearing cookies or browser storage can lose guest access. This is temporary service-side processing, not a promise that anonymous scans never touch server storage.

`VPS_DATABASE_PATH` selects the SQLite database. The default is `../../.data/better-buy-vps.sqlite`, relative to the API process working directory. Point it at the existing database when preserving existing accounts and scan history.

## Build and migrate

```sh
pnpm build
go -C apps/api run ./cmd/migrate
```

The frontend build writes static files to `apps/web/out`. The Go server is built as part of `pnpm build`; `pnpm api:build` builds just the backend.

## Configuration

The API requires `BETTER_AUTH_SECRET`, `BOX_KEY`, and the SMS settings described in [phone authentication](docs/phone-auth.md). Configure `APP_ORIGIN`, `BETTER_AUTH_URL`, and `CORS_ORIGIN` for the site. Wishlist scheduling and API rate limits are enabled by default. Browser push requires `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` together.

## Deployment

This workspace is deployed on the VPS. The Go API runs from `apps/api`; `deploy/vps` contains the systemd and Caddy configuration. This repository does not record the live service health or database migration state.

Phone authentication configuration and device testing: see [docs/phone-auth.md](docs/phone-auth.md)
