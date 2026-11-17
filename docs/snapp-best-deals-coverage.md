# Snapp best-deals coverage correction

Evidence: four user-provided HAR captures from 2026-11-17. Raw HARs are not copied into the repository: they contain account/session/address data. Test fixtures contain only public product rows and campaign section descriptors.

## Confirmed requests

- Store: `0wqkoz`, vendor ID `117172`.
- Best-deals ordinary collection: `/express-search/product-list/2192/vendor/0wqkoz`, page 0, page_size 10. The response reports count 2318 and includes ten product rows with store ownership, stock and prices. This is not evidence that every row meets our minimum discount or availability rules.
- `/express-home/vendor/0wqkoz` puts campaign descriptors in root `sections`, not `vendorInfo.sections`.
- The best-deals collection 2192 is absent from the captured home section list, so homepage discovery alone cannot find it.
- Orange Market Party reports capacityPerOrder 2. Bundles are a separate `/bundles/0wqkoz` response with count 49; they cannot be flattened into ordinary per-product savings without modeling the bundle terms.

## Implementation

Read root campaign sections with support for the legacy nested shape. Include observed best-deals collection 2192 as a candidate for every eligible store. Validate every candidate response and identity before freezing it into the manifest; do not assume a shared collection ID exists for every store. Ordinary collections with conditional metadata, nondefault collection type or special config remain excluded from ordinary discounts.

Discover discounted categories for every eligible store rather than only `single_super_mall`. Retain per-store delivery checks, 15% scan threshold, stock checks, identity validation, deduplication and existing pagination termination guards. Existing saved scans keep their frozen feed list; start a new scan to use expanded discovery.

## Validation

Captured-page parsing confirms 2318 reported rows and ten captured rows. Sanitized root-section fixtures exercise campaign discovery and exclusion of hot_deals. A mocked collector test exercises two nearby stores, discovers categories for both, freezes the new manifest and collects all 105 qualifying best-deals offers across two product pages plus the terminal empty page.

Full live pagination of the 2318-row collection has not been exercised by these offline tests. No user credentials are used for live requests. This change does not add bundle collection or change Digikala. Snapp campaign pages after the first are prefetched in batches of up to 24 workers per scan, using the discovery journal cache; parsing and checkpoint writes remain ordered. Store discovery and the baseline Market Party feed remain sequential. Backend and Snapp race tests pass. No live speedup benchmark is claimed.
