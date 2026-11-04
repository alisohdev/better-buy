# VPS deployment

The VPS runs the existing Hono API on Bun with Bun's built-in SQLite driver, and serves the existing static React export through Caddy. A separate scan process uses a persistent SQLite queue. The scan worker must always run under the systemd unit in this directory so the kernel lock is held before recovery or dispatch.

## Environment file

Create `/etc/better-buy/better-buy.env` with mode `0640`, owned by `root:better-buy`. Copy the generated `BETTER_AUTH_SECRET` and `BOX_KEY` from the private local deployment file, then add the production Google OAuth pair:

```dotenv
BETTER_AUTH_SECRET=<generated value>
BOX_KEY=<64-character hex value>
GOOGLE_CLIENT_ID=<production client id>
GOOGLE_CLIENT_SECRET=<production client secret>
BETTER_AUTH_URL=https://better-buy.ir
APP_ORIGIN=https://better-buy.ir
CORS_ORIGIN=https://better-buy.ir
VPS_DATABASE_PATH=/var/lib/better-buy/better-buy.sqlite
SNAPP_STORE_CAMPAIGNS_ENABLED=true
OKALA_SHARED_OFFERS_ENABLED=false
API_RATE_LIMITS_ENABLED=true
WISHLIST_SCHEDULE_ENABLED=true
```

Keep provider secrets out of Git and logs. The VPS database is intentionally new and empty; do not import the old D1 export.

## Files and runtime

- Install Bun as root, then copy its executable to the system path used by the units:

  ```sh
  curl -fsSL https://bun.sh/install | bash
  install -m 0755 /root/.bun/bin/bun /usr/local/bin/bun
  /usr/local/bin/bun --version
  ```

- Install the repository's production dependencies with the existing pnpm workspace before starting the services.
- Install `better-buy-http.service` and `better-buy-worker.service` into `/etc/systemd/system/`.
- Install `Caddyfile` into the Caddy configuration and reload Caddy.
- Install the backup service and timer. The timer writes daily, consistent SQLite backups under `/var/backups/better-buy` and retains 14 days.
- Create `/var/lib/better-buy` and `/var/backups/better-buy`, owned by `better-buy:better-buy` with mode `0750`.
- The worker lock is `/var/lib/better-buy/scan-worker.lock`. Keep that path stable; never unlink or replace it while the worker service may be alive.
- Both Bun processes bind or proxy only to loopback. Caddy serves `apps/web/out` and proxies `/api/*` and `/healthz` to `127.0.0.1:8787`.

Run `/usr/local/bin/bun run --no-env-file vps/migrate.ts` from `apps/worker` after the release and environment file are installed, before starting either application service. It applies the app migrations and the VPS engine schema to the empty SQLite file.

## DNS and rollback

Before cutover, remove the apex custom-domain Worker binding and point the apex A record to the VPS. Use DNS-only mode so Caddy's client-IP header replacement receives the real client address. Caddy obtains HTTPS certificates automatically.

Before the VPS accepts writes, DNS can return to the existing Worker. After VPS writes begin, the old D1 database does not contain them; switching back requires reconciling that new data first.
