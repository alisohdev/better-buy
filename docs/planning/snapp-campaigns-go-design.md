# Go Snapp campaign collection design

## Problem

The Go collector currently scans Snapp Market Party offers but does not run the Snapp store campaign enrichment enabled by the VPS configuration. The existing SQLite schema already has `enrichment_enabled`, `manifest_frozen`, `scan_campaign_contributions`, and the page tables. The Go queue does not yet use those campaign fields.

Keep HTTP, queued scans, and maintenance in one Go process. Preserve the scan queue's ownership of claims, cancellation, retries, heartbeats, and final offer publication. Keep provider request parsing and campaign completion rules private to the provider package. Do not add another process or backend runtime.

## Synthesis decision

Use Candidate B's provider-owned collection journal. The collector owns provider response replay, campaign planning, page validation, contribution staging, and durable assembly. The scan queue owns job lifecycle and the transaction that makes completed offers visible.

The independent judge scored Candidate A 23 of 25 and Candidate B 24 of 25. Candidate B gives the queue one collection call and one completed result. Candidate A keeps the current package direction and reduces code movement, but it exposes a larger journal protocol to the provider caller.

Keep the existing `scans.Deal`, `scans.Context`, and `scans.Manifest` names as aliases when moving their definitions to `providers`. The queue passes a durable claim with scan ID, user ID, instance ID, and boot owner. The provider returns an opaque completed value. The queue verifies the claim and publishes its offers and summary in the existing transaction.

## Data ownership

| Data                                                                         | Owner            |
| ---------------------------------------------------------------------------- | ---------------- |
| Enqueue-time location snapshot and enrichment flag                           | Scan queue       |
| Claim, cancellation, retry scheduling, heartbeat, and final visibility       | Scan queue       |
| Frozen provider units, manifest, and scope hash                              | Provider journal |
| Provider request attempts, response bodies, and observation times            | Provider journal |
| Page signatures, terminal evidence, observations, and campaign contributions | Provider journal |
| Published deals and terminal scan status                                     | Scan queue       |

Move the existing queue callbacks for request reservation, discovery loading and saving, guest refresh claims, and page records into one private provider journal. Remove the old callback path in the same change. The provider journal must bind writes to scan ID, user ID, instance ID, and boot owner. It must check cancellation and active status inside each write transaction.

## Durable rules

1. Snapshot the Snapp enrichment setting when the queue creates a scan. A later configuration change does not change an existing scan.
2. Read the saved location and threshold from `scans.context_json` when the provider claims a scan. Never replace them with the current location row.
3. Derive the manifest and scope hash from one ordered unit list. Freeze them before campaign collection. If no campaign scopes exist, preserve the reference behavior and omit `storeCampaigns` from the JSON manifest.
4. Use a stable request key that includes provider, method, endpoint, and canonical query. Keep bearer tokens out of keys and persisted data. Scope guest-access reservations to the logical provider read.
5. Save the first successful response and its observation time. Return the saved value on replay. Persist HTTP 204 as the reference JSON status marker for category requests.
6. Version page evidence and the frozen collection contract. Reject unknown versions. Replay older baseline response bodies only after checking their saved digest. Do not treat legacy bounded page records as proof of complete campaign coverage.
7. Commit each validated page, its signatures, distinct observations, contribution changes, and terminal evidence in one transaction. Replaying the same digest is a no-op. A different digest or descriptor fails closed.
8. Contributions move from absent to accepted or quarantined, then from accepted to quarantined. Quarantine never heals. Keep it scoped to its campaign unit.
9. A campaign unit is publishable only after verified terminal evidence and complete page history. Conflicting identities can make coverage incomplete while non-conflicting offers from a terminal unit remain eligible. Malformed or truncated pagination prevents publication.
10. Merge complete observations deterministically by saved observation time, feed priority, and stable feed identity. Preserve provenance and never mix price or stock fields from separate observations.
11. Publish the completed result, counts, coverage, successful scan status, and stopped queue job in one transaction. A failed or cancelled scan exposes no partial campaign offers.

## Observation timestamps

Keep `scan_discovery.observed_at` nullable for legacy rows and preserve the existing `savedResponse` contract. `loadScanJob` parses and validates `COALESCE(started_at, created_at)` once; malformed or zero saved starts stop collection. `stableObservedAt` returns nonempty saved observations unchanged, uses the validated scan start only for a missing observation, and errors if that fallback is unavailable. This keeps timestamp precedence in one small helper without changing discovery reads, and prevents replay from sampling a new wall-clock time. SQLite replay tests cover NULL and empty observations, insert conflicts, retained response bodies, and the resulting campaign offer fact.

## Alternatives

Candidate A keeps the journal and campaign types in `scans`. It preserves the current import direction and requires less package movement. Its exported journal operations make provider orchestration depend on the scan persistence protocol, so it was not selected.

Candidate B moves the shared offer and context types into `providers` and keeps aliases in `scans`. It moves more code, but it keeps provider completion rules and their evidence behind one collector call. That boundary is easier to change without teaching the queue about campaign pagination.

The judge suggested Candidate A's custom encoding for an enabled but empty campaign list. Source inspection found that the reference `freezeSnappManifest` returns without writing a manifest when the scope list is empty. The implementation will preserve that behavior instead of emitting an empty list.

## Implementation steps

- [x] Move shared scan context and offer types to `providers`, keep compatibility aliases in `scans`, and make the provider constructor take the database.
- [x] Replace queue persistence callbacks with a private provider journal and a durable claim.
- [x] Freeze and resume provider units with immutable, versioned page evidence and per-unit campaign contributions.
- [x] Port Snapp vendor discovery, campaign planning, offer validation, conflict quarantine, and deterministic merge.
- [x] Add the Snapp campaign configuration snapshot to scan enqueue and the VPS deployment instructions.
- [x] Build the Go packages and audit backend files and deployment manifests for old runtimes.

Go package tests and local auth/queue smoke checks pass. No live provider collection or production database migration has been run. VPS rollout is pending SSH access, and idle memory remains unmeasured.

The provider boundary now accepts a claim and returns an opaque completed result. The queue verifies the claim, saved scope hash, terminal units, and complete pages before publishing offers and terminal status in one SQLite transaction. The Snapp campaign feature flag is snapshotted when a scan is enqueued; the VPS deployment instructions enable it. Legacy baseline page replay is accepted only when the saved page digest matches.
