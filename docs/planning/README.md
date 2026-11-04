# Better Buy Production Roadmap

This roadmap describes the previous backend and is retained as project history. The current backend plan is [the Go VPS rewrite](./go-vps-backend-rewrite.md); the active release checklist is [Go VPS production readiness](./PRODUCTION_READINESS.md). No item is considered production-shipped until its acceptance criteria and release gate pass.

## Product direction

Better Buy should remain a Persian RTL, manual grocery-deal scanner. The near-term production surface supports SnappMarket and Okala in Tehran. Digikala Jet is temporarily hidden from new scans and connection settings, while its backend code and historical scans remain readable.

The execution order is driven by correctness first:

1. The displayed results must always match the selected location, provider, threshold, and scan time.
2. SnappMarket scans use automatic guest access after location selection. Okala scans use public endpoints without credentials or settings setup.
3. Repeated offers for the same product should become one readable product row without losing vendor-level history.
4. Location creation must be understandable and enforce the Tehran-only rule at the API boundary.
5. Tests, security, observability, migrations, and rollback must become release gates.

## Planning documents

- [FEATURES.md](./FEATURES.md): feature briefs, behavior, data contracts, and acceptance criteria.
- [BUGS.md](./BUGS.md): verified defects and technical risks, prioritized by user impact.
- [UI_UX.md](./UI_UX.md): scan, settings, deal-row, map, accessibility, and responsive UX direction.
- [PRODUCTION_READINESS.md](./PRODUCTION_READINESS.md): Go VPS, SQLite, security, testing, delivery, and operations checklist.

## Phase plan

### Phase 0 — Baseline and decisions

Goal: remove ambiguity before multiple agents change shared behavior.

Owners:

- Product/UX agent: confirm labels, provider visibility, product counts, and public-access behavior.
- Data agent: profile recent D1 scans for grouping collisions and existing out-of-Tehran locations.
- Platform agent: decide the Tehran boundary format and shortlist tile/geocoder providers.
- QA agent: establish test fixtures and the current behavior matrix.

Deliverables:

- Record Jet as `hidden`, not deleted.
- Define whether dashboard counts mean unique products or vendor offers. Recommended: show unique products in the UI and retain raw offer counts in scan audit data.
- Validate whether `product_variation_id` is stable across vendors before relying on it for grouping.
- Choose a versioned Tehran municipality polygon. A documented bounding box may be used only as an explicitly temporary fallback.
- Choose a geocoder and tile provider through a replaceable server-side provider interface.

Exit gate:

- Decisions are recorded, real-data queries have been reviewed, and every Phase 1 acceptance test has an owner.

### Phase 1 — Correctness and immediate UX repair

Goal: make the existing product truthful and unblock the primary scan flow.

Owners:

- Frontend agent: scan-context synchronization, shared scan CTA state, Jet visibility boundary.
- Worker/data agent: provider availability enforcement, Tehran validation, active-scan race protection, location-row cleanup.
- QA agent: component and API regression tests for context switching, provider access, provider visibility, and geofencing.
- Integration agent: review API/UI contract and run the release gate.

Required work:

- Load the latest successful scan for the selected location and provider, or show a clear no-scan state.
- Use one derived provider-access state for desktop, mobile, the scan strip, and empty states. Both SnappMarket and Okala have automatic/public access without customer credentials.
- Okala ignores legacy credentials; a valid location enables scanning and public upstream failures use normal retry feedback.
- Hide Jet from provider selection, settings, new scans, and retry; preserve read-only historical display.
- Enforce Tehran membership in shared validation and again authoritatively in create, update, and scan-start routes.
- Fix the phantom default-location behavior and multi-tenant scan/location joins.

Exit gate:

- No screen can mislabel results with a different location/provider.
- Direct API calls cannot save or scan an outside-Tehran location.
- Desktop and mobile credential states behave identically.
- Typecheck, worker tests, new web tests, build, and targeted E2E pass.

### Phase 2 — Grouped product rows and vendor chips

Goal: reduce duplicate visual rows while retaining every vendor offer as a stored fact.

Owners:

- Domain/data agent: normalization, grouping projection, history semantics, shared contract.
- API agent: backwards-compatible grouped endpoint and summary counts.
- UI agent: grouped deal row, vendor chips, filtering, search, sorting, and responsive behavior.
- QA agent: grouping collision, Persian normalization, mixed vendor state, and large-chip-set tests.

Required work:

- Keep `deals` as one row per vendor offer; never replace the vendor-specific `deal_key` with a group key.
- Add a versioned read model for product groups and vendor members.
- Start with conservative exact grouping; do not introduce fuzzy title matching.
- Keep raw `deal_count`; add or return a separately named grouped-product count.
- Make vendor filtering/search match any member chip.

Exit gate:

- Matching offers render once with unique vendor chips.
- Differing products never merge in the audited test corpus.
- Historical scans remain readable without destructive backfill.
- Group and offer state transitions are covered by unit and E2E tests.

### Phase 3 — Tehran map and address search

Goal: let a user find and confirm a Tehran location without understanding coordinates.

Owners:

- Map UI agent: prominent draggable pin, bounds overlay, address confirmation, failures, responsive interaction.
- Geocoding/API agent: provider abstraction, Tehran filtering, caching, rate limiting, timeouts, and normalized results.
- Accessibility agent: keyboard-only location creation, dialog focus management, announcements, and non-map fallback.
- Privacy/QA agent: data-flow review, provider policy checks, and desktop/mobile E2E.

Required work:

- Search neighborhoods, streets, and landmarks in Persian.
- Revalidate every search result against the shared Tehran boundary.
- Reverse-geocode a chosen point and show its address.
- Move raw coordinates into an advanced disclosure.
- Show tile, search, timeout, no-result, denied-geolocation, and outside-city states.

Exit gate:

- A keyboard-only user can create a Tehran location.
- Outside-Tehran results are not selectable and cannot be saved through the API.
- Provider failure leaves manual selection usable.
- No tokens, addresses, search queries, or exact coordinates enter application logs.

### Phase 4 — Production hardening

Goal: make deployment measurable, recoverable, and safe.

Owners:

- Worker agent: durable scan execution decision, structured errors/logs, D1 indexes/migrations, runtime integration tests.
- Security agent: legacy credential encryption/key rotation, scan abuse controls, privacy/retention, security headers.
- QA agent: CI matrix, migration rehearsal, Playwright desktop/mobile suite, failure injection.
- Release agent: staging deploy, dashboards/alerts, backups, rollback, and runbooks.

Required work:

- Decide whether long scans remain safe in request `waitUntil` after measurement or move them to a durable Cloudflare job primitive.
- Add structured, sanitized operational events and an unauthenticated minimal liveness endpoint.
- Add runtime-backed Worker/D1 integration tests and a migration/rollback rehearsal.
- Add scan/geocoder/auth-expiry dashboards and alerts.
- Require production secrets and reject weak encryption configuration.

Exit gate:

- CI, staging smoke tests, migration checks, monitoring, backup, and rollback all pass from written runbooks.
- A failed provider, rejected public access, interrupted scan, and bad deployment are each detectable and recoverable.

## Implementation loop status

Completed in the current workspace (not deployed):

- Phase 1 correctness: context-safe results, credential-aware scan actions, hidden Jet policy, Tehran API enforcement, tenant-safe joins, and read indexes.
- Phase 2 grouping: versioned conservative grouped read projection, backwards-compatible grouped endpoint, raw offer preservation, and vendor-chip UI.
- Phase 3 map/search foundation: draggable pin, Tehran bounds and boundary feedback, server-owned explicit address search, stale-result protection, and manual-coordinate fallback.
- Phase 4 first hardening slice: partial unique active-scan index, stable scan-conflict response, and unauthenticated `/healthz` liveness.

Still required before a production claim: migration rehearsal/backup, runtime-backed D1 tests, scan-duration measurement and durable-execution decision, rate limits, credential-key rotation, structured dashboards/alerts, security headers, and desktop/mobile E2E coverage.

## Agent working agreement

- One agent owns one bounded workstream and its tests; avoid two agents editing the same large file concurrently.
- Shared contracts and migrations land before dependent UI work.
- Each implementation task begins with acceptance criteria from these documents and ends with evidence: tests, screenshots where visual, and migration output where data changes.
- Agents do not silently broaden scope. New findings go to [BUGS.md](./BUGS.md) or [FEATURES.md](./FEATURES.md) with priority and evidence.
- The integration agent merges only after checking cross-workstream behavior, especially provider/location/scan context.

## Historical verified baseline (2026-08-23)

- `pnpm test`: passes; 8 shared tests and 24 Worker tests; web has no test files and uses `passWithNoTests`.
- `pnpm typecheck`: passes for shared, web, and Worker production/test configs.
- `pnpm build`: passes for the shared package and Next web build.
- Impeccable detector: no findings for the dashboard, map, and stylesheet targets.
- The current dashboard specs now cover automatic Snapp access and public Okala access without setup on desktop and mobile; see the validation note in the root README.
- `/healthz` is now an unauthenticated liveness route; `/api/health` remains authenticated.
- Cloudflare observability is enabled, but structured product events, alerts, backups, and staging smoke tests remain open.
