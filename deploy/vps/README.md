# Go VPS runtime

The VPS runs one Go API process. That process serves HTTP, drains the SQLite scan queue, runs wishlist scheduling, and performs maintenance. It replaces both `better-buy-http.service` and `better-buy-worker.service`; there is no separate scan-worker service. Caddy serves the static frontend and proxies API requests to `127.0.0.1:8787`.

## Build the Linux binaries

Build on Linux, or cross-compile from a compatible Go toolchain:

```sh
cd apps/api
mkdir -p dist
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o dist/better-buy-api ./cmd/server
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o dist/better-buy-migrate ./cmd/migrate
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o dist/better-buy-backup ./cmd/backup
```

Install the API and backup binaries as `/usr/local/bin/better-buy-api` and `/usr/local/bin/better-buy-backup`. The migration binary is run once before starting the API.

## Environment and files

Create `/etc/better-buy/better-buy.env` with mode `0640`, owned by `root:better-buy`. Set the auth, Google OAuth, origin, and database values described in the root `.env.example`. On the VPS, set:

```dotenv
VPS_HTTP_HOST=127.0.0.1
VPS_HTTP_PORT=8787
VPS_DATABASE_PATH=/var/lib/better-buy/better-buy.sqlite
WISHLIST_SCHEDULE_ENABLED=true
API_RATE_LIMITS_ENABLED=true
SNAPP_STORE_CAMPAIGNS_ENABLED=true
```

Keep secrets out of Git and logs. Create `/var/lib/better-buy` and `/var/backups/better-buy`, owned by `better-buy:better-buy` with mode `0750`.

Install `better-buy-api.service`, `better-buy-backup.service`, and `better-buy-backup.timer` into `/etc/systemd/system/`. Install `Caddyfile` in the Caddy configuration. The API unit can write only to `/var/lib/better-buy`; the backup unit can also write to `/var/backups/better-buy`.

Run `better-buy-migrate` as the `better-buy` account with `VPS_DATABASE_PATH` set to the production database path before enabling the API unit. Enable `better-buy-api.service` and `better-buy-backup.timer`; the backup timer retains 14 daily SQLite backups by default.

After an authorized rollout, confirm only one `better-buy-api` process is running, then record its RSS after the server has been idle. Compare that single-process reading with the earlier two-process backend baseline; host-level used memory also includes Caddy, the kernel, and filesystem cache.

## Cutover

Install the new release and run the Go migration before switching services. Stop the old HTTP and scan-worker units together when performing an authorized rollout, then start the single Go API unit. Verify the health route, sign-in, a queued scan, and the Caddy-served frontend before considering the rollout complete. This repository change does not perform the rollout or write to the production database.
