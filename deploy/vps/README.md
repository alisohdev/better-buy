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
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o dist/better-buy-push-test ./cmd/push-test
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o dist/better-buy-vapid-keygen ./cmd/vapid-keygen
```

Install the API and backup binaries as `/usr/local/bin/better-buy-api` and `/usr/local/bin/better-buy-backup`. The migration binary is run once before starting the API.

Install the push test and key generator binaries in `/usr/local/bin` as well.
Install `scripts/push-test.sh` as `/usr/local/bin/better-buy-push`.
When push is not yet configured, run `better-buy-vapid-keygen` in a private
terminal and put its two output values in the protected environment file,
along with `VAPID_SUBJECT=mailto:YOUR-CONTACT-EMAIL`. Do not rotate existing
keys: a new pair requires users to resubscribe. Restart the API after changing
the environment file. Do not put private keys in Git or share terminal output.

On the Android phone, open the installed app, sign in, open the wishlist, tap
«فعال‌سازی اعلان مرورگر» and allow notifications. If a subscription already
exists, tap «همگام‌سازی اعلان با حساب». Then run from the VPS checkout:

```sh
sudo better-buy-push --email you@example.com
```

The test targets all subscriptions for that account. An accepted result means
the push service accepted the request, not that Android displayed it. Check the
phone with the app closed and tap the notification. If no subscription is
found, enable and synchronize push on the phone. If permission is blocked,
enable notifications for the site/app in Chrome and Android settings. For an
expired subscription, enable push again; rejected or timed-out sends require
checking the VAPID configuration and VPS connectivity. The command can also
select an account with `--user-id` instead of `--email`.

## Environment and files

Create `/etc/better-buy/better-buy.env` with mode `0640`, owned by `root:better-buy`. Set the phone authentication, SMS, origin, and database values described in the root `.env.example`. On the VPS, set:

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

See [phone authentication](../../docs/phone-auth.md) for required SMS secrets, template approval, HTTPS, migration, and device acceptance tests. Admin remains denied until step-up assurance is implemented.
