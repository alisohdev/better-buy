# Okala scan performance verification

Verified on 2026-11-16. Full catalogue coverage and the 15% minimum are retained.

The collector runs up to twenty-four requests across all scans in this API process. A single coordinator merges observations by their original timestamp and category identity, writes checkpoints, and publishes isolated provisional offers. Public store/category responses are coordinated through SQLite with renewable, fenced leases and a three-minute reuse window. Nearby-store eligibility is fetched per scan. Provisional results are tenant checked, explicitly incomplete, and removed on terminal scan status; completed-history endpoints remain unchanged.

If Okala returns a valid HTTP response with `success:false` for an individual store or category, that feed is skipped while the collector finishes the remaining feeds. The saved scan is marked with incomplete coverage, disables baseline comparisons, and shows a warning in scan history. Malformed successful responses and truncated leaf catalogues still fail safely.

## Live upstream measurement

Public store 2223 was collected on the production VPS using disposable test databases and no production user records. Its one-vCPU quota was confirmed before testing. The latest 12-versus-24 run returned 3,207 observed products and 669 offers at 15% or above for both cold runs, with 81 upstream requests each.

| Configuration       | Complete scan | First provisional offers | Upstream requests |
| ------------------- | ------------: | -----------------------: | ----------------: |
| 12 requests         |       1.172 s |                  0.334 s |                81 |
| 24 requests         |       0.981 s |                  0.151 s |                81 |
| Warm cache after 12 |       0.686 s |                        — |                 0 |
| Warm cache after 24 |       0.666 s |                        — |                 0 |

24 requests were 16% faster than 12 for this sample, with the same catalogue and qualifying-offer counts. The one-vCPU host can run this workload, but the benchmark process reached 100% of that core; 24 requests leave little CPU headroom during a cold scan. Warm-cache runs are CPU-light and had similar elapsed time.

This is a single-store sample, not a guarantee for an entire delivery location or slower upstream conditions. No production user history was used or modified for the benchmark.

## Checks

- Two simultaneous scans reached twenty-four total concurrent requests and retained all offers; repeated stress tests and the Go race detector passed.
- Cancellation drains workers and removes active cache ownership.
- Cache coalescing, expiry, original observation times, fencing against stale owners, and HTTP 429 backoff are tested.
- Older observations cannot revive a newer unavailable product.
- Live offers are readable while remaining categories are blocked.
- Owner access, other-visitor rejection, anonymous rejection, pagination, minimum discount, completed-history separation, and terminal cleanup are tested through the real API handler.
- Desktop and mobile Playwright checks cover progressive growth, pagination, retention during refresh errors, cancellation, and avoiding premature 100% progress.

## Reproduction

```powershell
go -C apps/api test ./...
$env:CGO_ENABLED='1'; $env:CC='clang'
go -C apps/api test -race ./internal/providers -run 'TestOkala|TestSharedOkala|TestLiveOffer' -count=3
pnpm test
pnpm typecheck
pnpm --filter @better-buy/web exec playwright test --config playwright.export.config.ts dashboard.spec.ts -g 'live Okala results|enhanced scan feedback'
```

The optional `TestOkalaLiveTiming` requires `OKALA_LIVE_TIMING=1` and working network access to Okala. It creates disposable SQLite databases. Production rollout must apply migration `0024_scan_live_offers.sql` before starting the new API.

## Production rollout

Deployed to https://better-buy.ir with a production database backup and the additive live-offer migration. Public frontend assets and API health passed. A temporary guest session confirmed live offers during collection, cross-visitor/anonymous rejection, and cancellation with removal of the temporary scan/location.

The final cancellation audit exposed an interrupted-cache-save path that left a lease until expiry. A regression test was added, cleanup was fixed, the full backend suite and race checks were rerun, and the correction was deployed. Repeated production verification ended with zero test offers and zero unexpired cache owners.

The follow-up release corrected the live card to distinguish catalogue products checked from products meeting the discount filter, and handled store-specific HTTP-200 responses with `success:false` by finishing other stores and marking coverage incomplete. The current release enables verified Okala store-bound product links and raises the shared concurrency limit from twelve to twenty-four. Before rollout, the live-offer migration was confirmed present, a current SQLite backup passed `quick_check`, and there were no active scans. Production serves `/srv/better-buy/releases/okala-directlinks-24-20261116`; API health returned `{"ok":true}`, the homepage and all ten static assets returned 200, and there are no active scans or leftover live offers after verification.

Final API SHA-256: `75db398e4151e3630a89347c431d46cc709bdff3088900706dcf14d4fc8a8636`.

![Single-store benchmark](../.data/design-evidence/okala-performance.svg)
