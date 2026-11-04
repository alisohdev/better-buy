# Better Buy

Backend structure, Effect v4 boundaries, service lifetimes, collector changes, and execution limits are documented in [ARCHITECTURE.md](./ARCHITECTURE.md).

## Provider carts

Signed-in users can keep independent SnappMarket and Okala baskets from the compact header button. Its drawer groups editable items by recommended store, keeps unmatched items in a separate section, and holds the observed subtotal and continue-choosing action at the bottom. Add products from current successful provider results, set quantities from 1 to 99, or remove lines. Each provider basket is retained across delivery-location changes; its recommendation is recalculated from the latest successful scan compatible with the selected location's coordinates. The recommendation shows one observed store when it covers the full basket, or assigns available lines across observed stores and marks missing products. It reports when a bounded search could not prove the minimum store count. Prices and availability refer to supported promotional-feed observations; the cart does not place orders. Store logos are shown when provider metadata supplies a usable URL, with an initials fallback otherwise.

Migration `0012_provider_carts.sql` adds tenant-scoped persistence for provider cart lines. Local `pnpm dev` applies pending migrations before starting the Worker; to apply migrations manually to local D1, use the command below. Apply pending migrations to the intended remote D1 database through the configured Wrangler environment before deploying the cart feature.

## Reliability and UX redesign — local validation, 2026-10-08

The application now uses a compact Persian RTL header, visible location/retailer selectors, one primary scan action, and accessible secondary location/help/filter panels. Account controls live in a menu and history clearly identifies its location, provider, threshold, date and outcome, including read-only Jet snapshots. Local IRANSansX and the existing identity mark remain. Both system light/dark themes use coherent tokens; decorative scan animation, large summary tiles, repeated scan actions, connection settings and the unused partial/full choice are retired. Stored mode remains readable. The design source revisions and Before / After / Why audit are in [DESIGN.md](./DESIGN.md).

The transport boundary distinguishes HTTP status/code, unknown transport failure, invalid response and cancellation, including aborted body reads. Application GET queries get at most two retries (1s/2s backoff, Retry-After bounded at 5s); long server guidance declines automatic retry. Permanent 4xx, authentication/permission failures, malformed responses and cancellation do not retry. Reconnect and manual recovery use Query; writes never retry automatically. A lost start acknowledgement remains explicitly uncertain and reconciles through authenticated scan reads before an explicit new-attempt acknowledgement is offered. Known active scans stay visible account-wide while the person views another context. Read errors do not invent a failed scan; result retry reloads the same saved scan and never starts another retailer scan. Same-context cached results stay visible with snapshot time and stale feedback.

Okala preparation now applies its minimum 30% once to reservation, ScanJob and collection. An API request at 20% creates a 30% snapshot, without 20–29% offers. Future comparisons use that effective threshold; historical scans are untouched. Progress and final vendorCount both count distinct eligible stores whose returned entities were inspected (including empty entities), rather than campaign completions or all nearby stores. The collection budget, sequential retailer requests, atomic D1 results, terminal guards, tenant isolation, public provider access and pinned libraries remain intact.

Baseline: typecheck, 135 unit/integration tests (120 Worker / 10 shared / 5 web), production build and 28 browser checks passed. Full formatting had 25 pre-existing failures.

| Check                                                             | Final result                                                                                                                |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`                                                  | PASS                                                                                                                        |
| `pnpm test`                                                       | PASS: 169 tests (125 Worker / 10 shared / 34 web)                                                                           |
| `pnpm build`                                                      | PASS                                                                                                                        |
| `pnpm test:e2e`                                                   | PASS: 70 desktop/mobile browser checks against the production build; 8 affected checks re-passed after extra state captures |
| `pnpm --filter @better-buy/web build:worker`                      | PASS: fresh static export                                                                                                   |
| `pnpm --filter @better-buy/worker exec wrangler deploy --dry-run` | PASS: bundled with 40 files from the fresh static export; no deployment                                                     |
| Changed-file formatting / `git diff --check`                      | PASS                                                                                                                        |
| Frontend effects / custom polling timer source guard              | PASS: no direct `useEffect`/`useLayoutEffect`, `setInterval` or `setTimeout`                                                |
| `pnpm format:check`                                               | PRE-EXISTING FAILURE: 22 untouched files; no new formatting failures                                                        |

Next reports the root page at 82.6 kB and 185 kB first-load JavaScript, compared with 115 kB and 217 kB at baseline. These are build-reported bundle sizes, not production performance or Web Vitals measurements. Effect remains pinned at 4.0.1 and TanStack Query at 5.104.1; no dependencies or lockfile versions changed.

Screenshots and local logs are retained in ignored `.data/design-evidence/`, `.data/final-validation.log`, `.data/static-validation.log` and `.data/worker-dry-run.log`. Before/after screenshots use controlled representative fixtures. Additional captures inspect signed-out/authentication pending/error, no-location/location loading/error/outside-area, ready/submitting/queued/running/failed/unknown status, loading/error/empty/cached results, real retailer images, expanded offers, dialogs, history/Jet and narrow-screen layouts. A self-critique reduced mobile navigation/context spacing so the first offer appears sooner. The optional map now mounts only when opened; failed tiles leave manual coordinates usable. Dialog focus/Escape/restoration, visible control heights and action contrast were checked; local measurements are 5.45:1 in light mode and 8.60:1 in dark mode. Reduced-motion screenshots, reflow at 360/390/768/1280/1440px, 200% text scaling and a reduced-height keyboard viewport are covered. The latter is a simulation, not physical-device keyboard validation or a complete WCAG audit.

A separate read-only live Okala lookup returned three real product-image references; browser captures verified the images load. Scan lifecycle, Google session and network failure cases use fixtures; persistence regressions use real in-memory SQLite through the D1 interface. These checks do not prove external Google OAuth, deployed D1 timing, production scan execution, real TLS negotiation or production Web Vitals. The observed browser-to-Cloudflare TLS negotiation problem is outside frontend route handling: read recovery improves resilience but does not repair TLS. No HTTPS downgrade, insecure proxy or disabled certificate verification was introduced.

No commit, push, deployment, remote migration or production-secret change was made. Generated assets and evidence stay ignored; the implementation remains a reviewable working-tree diff.

## Public Okala scanning — local validation, 2026-10-07

Okala now requires no customer credentials, guest token, settings row, or connection setup. Better Buy's Google/Better Auth sign-in remains required. The Effect collector follows selected location → eligible nearby stores → public HomePage campaigns → every unique multi-store campaign → existing stock/threshold filtering and offer normalization. All Okala requests omit Authorization and Cookie; there is no authenticated BFF or login fallback.

The Persian onboarding, settings, scan actions, and provider indicator reflect public access without claiming current upstream reachability. The authenticated settings GET reports capabilities (`requiresCustomerCredentials: false`, `access: "public"`, `coverage: "campaign-feed"`) instead of credential readiness. OTP/login, manual token submission, refresh helpers, obsolete schemas, and the Okala client-secret configuration requirement are removed. Legacy settings are ignored without decryption or modification. Shared encryption, other provider data, historical migrations, accounts, locations, scans, and deals are retained; this change requires no migration.

| Check                                                    | Result                                                                                                                                                |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`                                         | PASS                                                                                                                                                  |
| `pnpm test`                                              | PASS: 120 Worker, 10 shared, 5 web                                                                                                                    |
| `pnpm build`                                             | PASS                                                                                                                                                  |
| `pnpm test:e2e`                                          | PASS: 28 desktop/mobile checks                                                                                                                        |
| `pnpm --filter @better-buy/web build:worker`             | PASS                                                                                                                                                  |
| Wrangler `deploy --dry-run` with fresh static export     | PASS; no deployment                                                                                                                                   |
| Changed implementation formatting and `git diff --check` | PASS                                                                                                                                                  |
| `pnpm format:check`                                      | PRE-EXISTING FAILURE: 26 files have existing formatting/EOL issues; 25 are untouched, and the legacy API test fixture retains its baseline formatting |

Tests use synthetic retailer responses, mocked Better Auth sessions, and in-memory SQLite through a D1 interface. They cover public request construction, selected coordinates and repeated store IDs, dynamic campaign deduplication, stock/threshold/price rules, legacy credential independence, removed authenticated routes, failed campaign history preservation, tenant isolation, scan exclusivity, Snapp access, and Jet policy/history.

Read-only live validation of the modified collector at a Tehran sample location passed: 76 eligible stores, 16 discovered campaigns, 18 GET requests all HTTP 200, 2,299 product records processed, and 282 unique eligible offers at the 40% threshold. The collector finished in 19.665 seconds under the existing 22-second collection budget; no Authorization or Cookie header was sent. These are observations, not test constants. This local Node run does not prove deployed Worker/D1 timing or the external Google OAuth flow.

Coverage remains the public promotional campaign feed, not the entire Okala catalog. One sampled campaign returned 70 products while reporting `totalCount=1866`, `totalPages=1`, and `hasNextPage=false`; discovery itself returned 16 campaigns with `totalCount=0` and `totalPages=0`. These inconsistent counts do not define additional-page requests or prove exhaustion. The current client has no verified pagination request contract. Indicated additional pages fail with `INCOMPLETE_PAGINATION`; no page parameters are guessed. Valid no-store/no-campaign responses retain explicit `NO_STORES`/`NO_CAMPAIGNS` failures. Feed disappearance means absence from that feed, not stock unavailability everywhere.

No code was deployed and no local or remote database migration was applied. Pre-existing static assets were restored after export/bundling validation. The earlier refactor and deployment notes below are historical evidence.

## Effect v4 refactor — local validation, 2026-10-07

The backend now uses pinned `effect@4.0.1`. The frontend uses pinned TanStack Query `5.104.1` for server state and polling, with a separate cache per authenticated session and no direct `useEffect`/`useLayoutEffect` calls in its source.

| Check                                              | Baseline                                     | Refactor                                |
| -------------------------------------------------- | -------------------------------------------- | --------------------------------------- |
| `pnpm typecheck`                                   | PASS                                         | PASS                                    |
| `pnpm test`                                        | PASS: 69 Worker, 8 shared; no web unit tests | PASS: 96 Worker, 10 shared, 5 web       |
| `pnpm build`                                       | PASS                                         | PASS                                    |
| `pnpm test:e2e`                                    | PASS: 14 desktop/mobile checks               | PASS: 24 desktop/mobile checks          |
| Static Worker web export                           | Existing assets retained                     | PASS: fresh `build:worker` export       |
| Wrangler deployment dry run                        | —                                            | PASS, including the fresh static export |
| Formatting of refactored modules / diff whitespace | —                                            | PASS                                    |

No baseline check failed and no requested check remains blocked. Tests cover credential-free Snapp access, bounded guest renewal (the earlier refactor also tested Okala refresh; public access now replaces it), per-request retry/backoff and cancellation, completeness/stock/deduplication, persistence rollback/progress/terminal state, tenant isolation/exclusivity, session cache isolation, frontend context races, history, and accessible location editing/deletion. Focused behavior fixes reject failed Okala nearby-store envelopes, guard late terminal writes, prevent stale frontend responses, and restore location editor accessibility and selection after deletion.

This refactor was **not deployed** and did not modify a remote database or apply migrations. The pre-existing static output was restored after export validation. Retailer responses and auth sessions in this run were fixtures; D1-interface regressions used in-memory SQLite. Live retailer availability, external Google OAuth, deployed D1 behavior, and production scan timing are separate evidence. Existing live/deployment observations below describe the earlier Snapp implementation, not a release of this refactor.

ابزار پیدا کردن تخفیف‌های اسنپ‌مارکت و اکالا، و مقایسه آن‌ها بین اسکن‌های دستی. تاریخچه دیجی‌کالا جت همچنان قابل مشاهده است؛ اسکن تازه آن فعلاً غیرفعال است.

یک بک‌اند واحد روی Cloudflare Worker اجرا می‌شود (Hono + D1 + Better Auth) و هم محلی و هم در استقرار، همین کد است.

## اجرا

```bash
pnpm install
pnpm dev
```

The Worker development script overrides the compatibility date to `2026-08-08`, the maximum supported by the local workerd bundled with installed Wrangler 4.120.0. The deployment configuration retains `2026-08-10`; this local override does not prove behavior under that newer runtime date. Local Wrangler state and temporary files in `.wrangler/` are ignored.

سپس [http://127.0.0.1:3000](http://127.0.0.1:3000) را باز کنید، با گوگل وارد شوید، یک موقعیت تحویل معتبر در تهران انتخاب کنید و اسکن اسنپ‌مارکت یا اکالا را شروع کنید. برای اسکن اکالا نیازی به ورود یا وارد کردن توکن نیست؛ شماره موبایل، کد پیامک و تنظیم اتصال فروشگاه لازم نیست. API روی `127.0.0.1:8787` با `wrangler dev` اجرا می‌شود و داده‌ها در D1 محلی نگهداری می‌شوند.

`pnpm dev` and `pnpm cf:dev` now apply pending migrations to the local D1 database before starting the Worker. This also runs after pulling changes that add migrations; remote databases are unaffected. To apply local migrations manually:

```bash
pnpm --filter @better-buy/worker run db:migrate:local
```

Migration `0005_remove_snapp_customer_credentials.sql` فقط اطلاعات اتصال قدیمی اسنپ‌مارکت را حذف می‌کند؛ اطلاعات اکالا و جت و تمام حساب‌ها، موقعیت‌ها و تاریخچه حفظ می‌شوند. اسکن اسنپ‌مارکت حتی پیش از اعمال این migration نیز اطلاعات قدیمی را نمی‌خواند.

Migration `0012_provider_carts.sql` creates the per-user, per-provider basket table. It preserves existing account, location, scan and product data; no basket data existed before this feature.

مقادیر محلی لازم (ورود گوگل و کلید نگه‌داری‌شده برای داده‌های قدیمی) را در `apps/worker/.dev.vars` بگذارید — نمونه در `apps/worker/.dev.vars.example`.

## ورود

For `pnpm dev`, set `DEV_MODE=true` in `apps/worker/.dev.vars` and open `http://localhost:3000` or `http://127.0.0.1:3000`. The development sign-in page offers **Continue as local test user**, which uses the existing `/api/auth/test-login` helper and requires no Google credentials or OAuth setup. Next dev proxies `/api` to `DEV_API_ORIGIN` (default `http://127.0.0.1:8787`); leave `NEXT_PUBLIC_API_BASE` and `NEXT_PUBLIC_AUTH_BASE_URL` empty in `.env.development` so the browser keeps session cookies on its own hostname. Restart `pnpm dev` after changing environment files. Production builds keep the existing Google sign-in page, and the helper remains unavailable when Worker `DEV_MODE` is disabled.

For local testing without Google OAuth, set `DEV_MODE=true` in the ignored Worker `.dev.vars`, build with `pnpm --filter @better-buy/worker build:web`, and run `pnpm cf:dev`. When serving both web and API at `http://127.0.0.1:8787`, use that origin for `APP_ORIGIN`, `BETTER_AUTH_URL` and `CORS_ORIGIN`. On that local page, run this in the browser console:

```javascript
const login = await fetch("/api/auth/test-login", {
  method: "POST",
  credentials: "include",
});
if (!login.ok) throw new Error(`Development login failed: ${login.status}`);
location.assign("/");
```

The development helper issues a real Better Auth session for the local test account and seeds its first location. It uses Better Auth's own padded-base64 cookie signature and URL-encodes the value; the former base64url signature passed a shallow cryptographic test but was rejected by the actual session-cookie reader. The endpoint remains HTTP 404 with no account/session writes when `DEV_MODE` is disabled. Verification on 2026-10-08 passed typecheck, 172 unit/integration tests (128 Worker / 10 shared / 34 web), actual local session/protected-route reads, and a Chrome login/reload that displayed the dashboard. The three new integration regressions use the real Better Auth handler and in-memory SQLite through its D1 adapter. This does not verify Google OAuth. Local browser evidence is in `.data/design-evidence/dev-login-local.png`.

- **Google:** ورود اصلی از طریق Better Auth انجام می‌شود؛ در حالت محلی نیز همین جریان کار می‌کند.
- **SnappMarket:** Worker به‌صورت خودکار نشست مهمان PWA را دریافت می‌کند. یک شناسه دستگاه و توکن در طول جمع‌آوری صفحات استفاده می‌شود؛ انقضا رعایت می‌شود و پس از پاسخ 401 فقط یک بار دسترسی تازه و همان صفحه دوباره درخواست می‌شود. توکن مهمان در مرورگر، لاگ یا اطلاعات اتصال کاربر ذخیره نمی‌شود. نسخه PWA در collector تنظیم شده است. آماده بودن دکمه اسکن به معنی تأیید ارتباط با فروشگاه نیست؛ خطای دریافت دسترسی یا پاسخ ناقص، اسکن را ناموفق می‌کند و نتیجه موفق قبلی حفظ می‌شود.
- **اکالا:** فروشگاه‌های نزدیکِ سرویس‌دهنده و کمپین‌های عمومی بر اساس موقعیت انتخابی دریافت می‌شوند؛ پیشنهادهای همه کمپین‌های چندفروشگاهی کشف‌شده با همان فروشگاه‌ها خوانده می‌شوند. هیچ توکن مشتری یا مهمان، کوکی، ورود با پیامک یا تازه‌سازی دسترسی لازم نیست. اطلاعات اتصال قدیمی خوانده یا تغییر داده نمی‌شوند و migration تازه‌ای لازم نیست.

دامنه اکالا، پیشنهادهای کمپین‌های عمومی است و شامل تمام کالاهای اکالا نیست. نبودن کالا در این فهرست به معنی ناموجود بودن آن در همه فروشگاه‌ها نیست. پاسخ زنده با شمار کل بیشتر از کالاهای برگشتی، فقط یک صفحه و نبود صفحه بعد را گزارش می‌کند. قرارداد صفحه‌بندی بیشتری تأیید نشده است؛ اگر پاسخ صفحه‌های بیشتری اعلام کند، اسکن با خطای دریافت ناقص متوقف می‌شود.

## استقرار

```bash
pnpm cf:deploy
```

فایل‌های استاتیک وب (`apps/web/out`) به‌عنوان assets کنار Worker منتشر می‌شوند؛ API و وب هم‌مبدا هستند.

## بررسی

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
```

## Formatting and Git hooks

`pnpm install` installs the Husky hooks through the `prepare` script. Before each
commit, lint-staged formats staged files with Prettier and includes those formatting
changes in the commit, then runs `pnpm typecheck` and `pnpm test`. Unsupported file
types and generated output are skipped; a failed check stops the commit.

Use `pnpm format` to format the repository or `pnpm format:check` to check formatting
without changing files. Formatting rules are in `.prettierrc.json`, with generated
files excluded by `.prettierignore`.

## SnappMarket validation — 2026-10-07

- Exact `/market-party/{latitude}/{longitude}` feed at the existing Tehran sample location: HTTP 401 without authorization. The public PWA guest-token request returned HTTP 200, `data.access_token`, and `expires_in: 259200`; the same feed with that guest returned HTTP 200, `status: true`, and 34 of 34 vendors.
- The modified collector was then run against the live service from the local Node environment: one guest request and one complete feed page, 33 vendors, 330 unique vendor/product records, and 32 eligible in-stock deals at the 40% threshold. These are separate live observations; the feed changes over time.
- `pnpm typecheck`, `pnpm test` (69 Worker and 8 shared tests), `pnpm build`, and `pnpm test:e2e` (14 desktop/mobile checks) passed. No requested check was blocked. Web unit tests use `passWithNoTests`; browser behavior is covered by Playwright.
- API persistence/migration regressions use in-memory SQLite through a D1 interface adapter with mocked auth sessions and upstream responses. Browser tests also use session/API fixtures. Live Snapp feed validation exercised the collector locally; a signed-in scan from the deployed Worker and the external Better Buy Google OAuth flow were not exercised.

## Deployment — 2026-10-07

- Published the Worker and static frontend to [Better Buy](https://better-buy.better-buy-worker.workers.dev), version `b2c460f6-e030-4509-853b-dfc93f1be340`, serving 100% of traffic. The static export build and Wrangler deployment dry run passed; existing remote variables and secrets were retained.
- Applied `0005_remove_snapp_customer_credentials.sql` to the configured remote D1 database after publishing the new code. It removed 14 legacy Snapp settings rows. The 8 Okala settings rows, 26 locations, 162 scans, 15,784 deals, 19 users, and 19 accounts remained present with unchanged counts. No pending migrations remain.
- Recorded a D1 Time Travel recovery bookmark and the prior Worker version locally in `apps/worker/.data/deployment-recovery.json` before release.
- Live smoke checks passed: root page and matching deployed page bundle HTTP 200; `/healthz` HTTP 200; signed-out `/api/me`, Okala settings, and scan submission HTTP 401; dev-only test login HTTP 404. The deployed page bundle matches the local build and contains no Snapp credential-route references. A signed-in production scan remains outside these smoke checks.
