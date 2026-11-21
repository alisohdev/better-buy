# M0 Frontend Migration Plan

## Scope and invariants

Replace only the Next.js frontend build/runtime with a static React 19 + Vite SPA using TanStack Router. Keep the Go API, SQLite database, API contracts, Caddy host, same-origin cookies, Persian RTL design, query behavior, manifest identity, and root-scoped `/sw.js`. Do not deploy or begin M1 logging/monitoring.

## Baseline captured before edits (2026-11-18)

- `pnpm --filter @better-buy/web build` completed successfully in approximately 46.5 seconds, including shared build, Next compilation, static export, and trace generation.
- Next build reports `/` at 200 kB and **303 kB First Load JS** (103 kB shared + 200 kB route). The retained Next build manifest and assets also allow a gzip comparison against the same route; see the M0 report.
- Existing app is a single client page (`src/app/page.tsx`) selecting dashboard, login, notifications, and product details through query parameters. Dashboard sections use internal state.
- Root `public/sw.js`, manifest and icons are static and the worker has no fetch handler or authenticated response cache.
- Caddy serves `apps/web/out`, proxies `/api/*` and `/healthz`, and only overrides caching for `/_next/static/*` and `/sw.js`.
- Before-migration mobile-throttled request count, LCP, and Lighthouse were not captured. The old `.next` assets remain available for a reproducible route-bundle comparison, but a full browser LCP delta cannot be reconstructed from those assets.

## Work sequence

1. Preserve the current user journeys as explicit route adapters and map existing query deep links (`page`, `scan`, `product`, `notification`, `inbox`) to typed router state.
2. Replace Next scripts/configuration and `next/image`/`next/dynamic`/`process.env` with Vite/browser equivalents. Keep route modules dynamically imported and lazy-load the map and authentication/dashboard views.
3. Configure React Compiler through the official Babel plugin integration in `@vitejs/plugin-react`, enabled in dev and production. Check compiler diagnostics and retain existing memoization until profiling justifies changes.
4. Keep shared package and pnpm workspace boundaries. Configure Vite aliases and Tailwind/PostCSS processing, typecheck and test scripts, fixture browser tests, and static export to `out`.
5. Update Caddy for `/assets/*` immutable cache, revalidated HTML and worker, strict missing-asset 404 handling, and SPA fallback for deep links while preserving API/health proxying.
6. Run typecheck, unit/integration/browser tests, production build, inspect emitted chunks for route splitting/compiler output, and repeat the baseline measurements under the documented fixture profile.
7. Document atomic static artifact replacement and rollback. No production deployment is included.

## Risks and mitigations

- Deep links currently use query parameters and can arrive from installed-PWA notifications: retain those routes and translate legacy query URLs before rendering.
- Existing login view is conditionally gated after session loading, but the root page statically imports dashboard/admin/map transitively: route chunks must keep private features out of the login entry chunk.
- Root service-worker scope and install identity must remain unchanged; do not add offline caching or change manifest `id`, `scope`, or `start_url`.
- Router history fallback can return HTML for missing hashed assets if configured broadly: explicitly serve `/assets/*` with file_server and no SPA fallback.
- React Compiler may report existing Rules of React violations or increase build time: collect diagnostics, use narrow documented exclusions only when required, and compare profiling evidence.
- Existing pnpm scripts, generated Next artifacts, and web tests may depend on Next conventions; migrate or remove those tests only after equivalent Vite config behavior is covered.

## Completion evidence

Record build duration and production asset totals, initial JS transfer and route chunk requests, mobile LCP under fixed conditions, test outcomes, compiler evidence, PWA/deep-link behavior, and remaining limitations in `M0-frontend-migration-report.md`.
