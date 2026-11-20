# M0 frontend migration report

**Status: implementation in review; M0 is not complete.** The frontend now builds as a Vite SPA, but cross-journey browser coverage, production Caddy validation, React DevTools profiling, Lighthouse, and PWA transition checks remain outstanding. No production deployment was performed.

## Framework and compiler

- Replaced Next.js scripts/configuration and runtime imports with Vite, React 19, file-based TanStack Router, and static output in `apps/web/out`.
- Added distinct route files for login, scan, deals, favorites, cart, history, notifications, and settings. They preserve the existing query-driven app through small route adapters.
- Integrated React Compiler using `@vitejs/plugin-react` with its `reactCompilerPreset({ target: "19" })` through `@rolldown/plugin-babel`, enabled in Vite development and production. Compiled output contains `react/compiler-runtime` memo cache calls. No compiler exclusions were configured.
- Production Vite build took 11.05 seconds (the shared package prebuild is additional). Babel transform callbacks accounted for 9.3 seconds of overlapping plugin time. The old Next build took about 46.5 seconds including shared build and Next trace generation; build timing is not a browser performance metric.
- The migration did not remove existing `useMemo`, `useCallback`, or `React.memo` calls. React DevTools before/after profiles were not captured, so rendering improvement is unverified.

## Bundle comparison

The old `.next` production assets and `app-build-manifest.json` were still present after the initial baseline build. The comparison below sums the old `/layout` and `/page` manifest assets and gzip-compresses each file. It compares the corresponding Vite-loaded authenticated root route, with CSS included separately.

| Metric                       | Next.js baseline | Vite output | Change |
| ---------------------------- | ---------------: | ----------: | -----: |
| Initial route JS, gzip       |         305.5 kB |    232.4 kB | -23.9% |
| Initial route CSS, gzip      |          37.0 kB |     36.9 kB |  -0.3% |
| Initial route JS + CSS, gzip |         342.5 kB |    269.3 kB | -21.4% |
| Initial route JS, raw bytes  |       1,008.5 kB |    730.7 kB | -27.5% |

The Vite values are the script response bodies and both emitted global and dashboard CSS. The comparison excludes fonts and API payloads on both sides. This proves smaller frontend route assets for this captured build, not a Lighthouse score improvement.

### Mobile fixture run

`apps/web/scripts/benchmark.mjs` loads the built output on a Pixel 7 profile with 150 ms RTT, 1.6 Mbps down, 750 Kbps up, and deterministic same-origin API responses. The captured authenticated root run requested 31 resources, transferred 730,684 decoded JS bytes (232,436 bytes gzip-compressed per JS file), and reported LCP 6,268 ms and DOMContentLoaded 2,506 ms. This is one local run with synthetic API fixtures; it does not establish a production LCP or device result. The old route cannot be replayed for LCP because its exported HTML was overwritten by the Vite output, so a before/after LCP comparison and Lighthouse audit are unavailable.

The initial route still loads a 273.8 kB raw shared JS chunk and a 288.8 kB raw dashboard chunk (90.5 kB gzip). The 6.3 second fixture LCP is too high to claim a good mobile experience. Investigate request waterfalls and font/CSS loading in a follow-up before M0 acceptance; the bundle-size reduction alone is insufficient evidence.

## Verification

### Stabilization evidence

- Focused Playwright reproduction confirmed test drift in the product link, scan setup, discount filter, notifications, responsive menu, and cart assertions. The pre-migration view code already moved provider selection to scan setup, required an offer-bound retailer destination, and presented notifications as a page. The provider build currently includes Digikala, so the two-provider scenario explicitly deselects it. Combined-feed and paged-feed now pin the browser clock while allowing timers to advance.
- Three identical mobile fixture runs recorded LCP of 6,180, 6,196, and 6,460 ms, with median TTFB of 168 ms. The LCP element was the tutorial paragraph about saving a delivery address. In the median run the entry JS finished at 2,442 ms, the session request began at 3,307 ms, and the dashboard chunk finished at 5,782 ms. Regular font loading finished at 4,026 ms. The later bold font requests began at about 5,893 ms. The fixture session response itself took 5 ms.
- Eagerly importing the shared app shell increased observed LCP beyond 7 seconds in the same throttling harness. The import change was reverted. A disabled developer wishlist hook no longer makes a second session request. The retained fix still needs its own repeated performance run.
- Caddy validated the repository file. A loopback instance using the same handlers and a fixture upstream returned SPA HTML with `no-cache` for all nine entry paths and served `/sw.js` with `no-cache`. A missing asset initially carried the immutable header. After the fix Caddy returned `404` with `no-store` for the missing asset and kept the immutable header on an existing asset. It forwarded the fixture auth cookie in both directions and proxied `/healthz`. Real HTTPS session behavior and installed PWA upgrade remain unverified.

- `pnpm --filter @better-buy/web typecheck`: passed.
- `pnpm --filter @better-buy/web test`: 14 files and 90 tests passed.
- `pnpm --filter @better-buy/web build`: passed; 857 modules transformed and route chunks emitted.
- Compiler evidence: emitted JS includes React Compiler runtime calls. The production bundler reports the compiler transform; no diagnostic exclusions are present.
- `pnpm --filter @better-buy/web test:e2e`: started but did not pass. Early failures included saved-feed expectations and scan deep links. A focused `combined-feed.spec.ts` run failed all four tests: the fixture’s historical dates first opened scan setup, and after adjusting dates to the current day the tests expected provider checkboxes in a screen that now presents saved deals. These test assumptions must be reconciled with current intended behavior before claiming migration parity. The full suite was interrupted after widespread failures; no all-suite pass is claimed.
- Caddy config was updated but `caddy validate` could not be run because Caddy is not installed in this Windows environment. Direct deep-route refresh, missing asset 404, worker cache behavior, and API proxy behavior against Caddy remain unverified.
- The existing `sw.js`, manifest, icons, and service-worker scope were kept in place. Push unit tests pass, but installed-PWA upgrade, persisted-session, notification deep-link, and physical push behavior were not verified.
- No Go API contract or SQLite schema changes were made.

## Remaining M0 acceptance work

1. Resolve E2E failures against current product behavior and pass all relevant desktop and mobile journeys, including auth/OTP, scan recovery, feed, cart/favorites, maps, notifications, and route deep links.
2. Run Caddy syntax validation and exercise direct SPA navigation, asset 404s, cookies/API proxying, service worker headers, and installed-PWA update behavior on a staging-like host.
3. Capture React DevTools profiles for product lists, discount filtering, cart updates, and scan progress with and without compiler optimization, and record any compiler diagnostics.
4. Investigate the 6.3 second local LCP, optimize the actual bottleneck, and repeat the controlled run. Lighthouse and a valid old-build browser LCP baseline are still needed for a complete comparison.
5. Complete and review this gate before beginning M1 logging or later monitoring work.
