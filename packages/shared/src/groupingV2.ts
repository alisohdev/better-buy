import type { DealRecord, DealState } from "./contracts";
import {
  normalizeDealGroupText,
  type DealGroupRecord,
  type VendorOfferRecord,
} from "./grouping";
import { displayToman } from "./prices";
import { identityDigest } from "./scanContext";
import type { ScanRecord } from "./contracts";

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
export const compareOfferPrice = (a: VendorOfferRecord, b: VendorOfferRecord) =>
  a.finalPriceRials - b.finalPriceRials ||
  compareText(a.vendorId, b.vendorId) ||
  compareText(a.offerKey, b.offerKey);

export function compareProductDiscount(
  a: DealGroupRecord,
  b: DealGroupRecord
): number {
  const left = a.bestCurrentOffer;
  const right = b.bestCurrentOffer;
  if (!left || !right)
    return Number(!left) - Number(!right) || compareText(a.key, b.key);
  return (
    right.discountRatio - left.discountRatio ||
    right.discountRials - left.discountRials ||
    left.finalPriceRials - right.finalPriceRials ||
    compareText(a.key, b.key)
  );
}

// Existing feeds round ratios to whole points. Allow one percentage point;
// retain supplied precision for eligibility and ranking, rounding only in UI.
const validPrice = (row: DealRecord) =>
  [
    row.priceRials,
    row.discountRials,
    row.finalPriceRials,
    row.discountRatio,
  ].every(Number.isFinite) &&
  row.priceRials > 0 &&
  row.discountRials >= 0 &&
  row.discountRials <= row.priceRials &&
  row.finalPriceRials === row.priceRials - row.discountRials &&
  Math.abs(row.discountRatio - (row.discountRials / row.priceRials) * 100) <= 1;

export async function groupDealsV2(
  provider: ScanRecord["source"],
  deals: readonly DealRecord[]
): Promise<DealGroupRecord[]> {
  const buckets = new Map<string, DealRecord[]>();
  const variants = new Map<string, Set<string>>();
  for (const row of deals) {
    const title = normalizeDealGroupText(row.title) ?? "";
    const identity = JSON.stringify([
      provider,
      row.productVariationId.trim(),
      title,
    ]);
    const signatures =
      variants.get(row.productVariationId.trim()) ?? new Set<string>();
    signatures.add(title);
    variants.set(row.productVariationId.trim(), signatures);
    const bucket = buckets.get(identity) ?? [];
    bucket.push(row);
    buckets.set(identity, bucket);
  }
  const groups = await Promise.all(
    [...buckets].map(async ([identity, rows]) => {
      const observations = new Map<string, DealRecord>();
      const provenance = new Map<string, Set<string>>();
      const diagnostics = new Set<string>();
      for (const row of rows) {
        if (!validPrice(row)) {
          diagnostics.add("PRICE_ANOMALY");
          continue;
        }
        const offerId = JSON.stringify([
          provider,
          row.vendorId,
          row.productVariationId,
          row.benefit?.kind ??
            (provider === "snappmarket" ? "market_party" : "standard_discount"),
          row.benefit?.identity ?? "ordinary",
        ]);
        const prior = observations.get(offerId);
        const sources = provenance.get(offerId) ?? new Set<string>();
        row.provenance?.forEach((source) => sources.add(source));
        provenance.set(offerId, sources);
        if (
          prior &&
          (prior.finalPriceRials !== row.finalPriceRials ||
            prior.priceRials !== row.priceRials)
        )
          diagnostics.add("OBSERVATION_CONFLICT");
        // Current observations win over historical rows. Latest complete tuple
        // wins; deterministic adapter priority and identity settle equal-time ties.
        const order = prior
          ? Number(prior.state === "no_longer_present") -
              Number(row.state === "no_longer_present") ||
            (row.observedAt ? Date.parse(row.observedAt) : 0) -
              (prior.observedAt ? Date.parse(prior.observedAt) : 0) ||
            (prior.observationPriority ?? 0) - (row.observationPriority ?? 0) ||
            compareText(
              [...(prior.provenance ?? [])].sort().join("|"),
              [...(row.provenance ?? [])].sort().join("|")
            ) ||
            compareText(prior.key, row.key) ||
            compareText(
              JSON.stringify([
                prior.priceRials,
                prior.discountRials,
                prior.finalPriceRials,
                prior.discountRatio,
              ]),
              JSON.stringify([
                row.priceRials,
                row.discountRials,
                row.finalPriceRials,
                row.discountRatio,
              ])
            )
          : 1;
        if (order > 0) observations.set(offerId, row);
      }
      const offers = [...observations].map(([id, row]): VendorOfferRecord => ({
        logoUrl: row.vendorLogoUrl ?? null,
        offerKey: row.key,
        productVariationId: row.productVariationId,
        productDestination: null,
        vendorId: row.vendorId,
        vendorTitle: row.vendorTitle,
        vendorCode: row.vendorCode,
        priceRials: row.priceRials,
        discountRials: row.discountRials,
        finalPriceRials: row.finalPriceRials,
        discountRatio: row.discountRatio,
        stock: row.stock,
        availability: row.availability,
        stockQuantity: row.stockQuantity,
        state: row.state,
        benefit: row.benefit ?? {
          kind:
            provider === "snappmarket" ? "market_party" : "standard_discount",
          identity: "ordinary",
          applicable: true,
          terms: null,
        },
        observedAt: row.observedAt,
        provenance: [...(provenance.get(id) ?? [])].sort(),
        sourceMoneyUnit: provider === "snappmarket" ? "toman" : "rial",
        originalAmountToman: displayToman(row.priceRials, provider),
        discountAmountToman: displayToman(row.discountRials, provider),
        finalAmountToman: displayToman(row.finalPriceRials, provider),
      }));
      const conditionalOffers = offers
        .filter(
          (offer) =>
            (offer.state === "no_longer_present" ||
              offer.availability === "available" ||
              offer.stock > 0) &&
            (offer.benefit?.kind === "conditional" ||
              offer.benefit?.applicable !== true)
        )
        .sort(compareOfferPrice);
      const vendors = offers
        .filter(
          (offer) =>
            !conditionalOffers.includes(offer) &&
            (offer.state === "no_longer_present" ||
              offer.availability === "available" ||
              offer.stock > 0)
        )
        .sort(compareOfferPrice);
      const current = vendors.filter(
        (offer) => offer.state !== "no_longer_present"
      );
      const bestCurrentOffer = current[0] ?? null;
      const representative =
        rows.find(
          (row) => row.key === (bestCurrentOffer ?? vendors[0])?.offerKey
        ) ?? rows[0]!;
      if (
        (variants.get(representative.productVariationId.trim())?.size ?? 0) > 1
      )
        diagnostics.add("VARIANT_ID_CONFLICT");
      const present = current.length
        ? current
        : conditionalOffers.filter(
            (offer) => offer.state !== "no_longer_present"
          );
      const state: DealState = present.length
        ? present.some((v) => v.state === "still_available")
          ? "still_available"
          : present.some((v) => v.state === "current")
            ? "current"
            : "new"
        : "no_longer_present";
      return {
        key: `v2:${await identityDigest(JSON.parse(identity))}`,
        groupKeyVersion: 2,
        scanId: representative.scanId,
        title: representative.title,
        image: representative.image,
        categoryTitle: representative.categoryTitle,
        priceRials: bestCurrentOffer?.priceRials ?? representative.priceRials,
        discountRials:
          bestCurrentOffer?.discountRials ?? representative.discountRials,
        finalPriceRials:
          bestCurrentOffer?.finalPriceRials ?? representative.finalPriceRials,
        discountRatio:
          bestCurrentOffer?.discountRatio ?? representative.discountRatio,
        state,
        vendors,
        bestCurrentOffer,
        currentStoreOfferCount: new Set(current.map((v) => v.vendorId)).size,
        conditionalOffers,
        diagnostics: [...diagnostics].sort(),
      } satisfies DealGroupRecord;
    })
  );
  return groups
    .filter((group) => group.vendors.length || group.conditionalOffers.length)
    .sort(compareProductDiscount);
}
