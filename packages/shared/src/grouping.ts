import type { DealRecord, DealState } from "./contracts";
/**
 * Read-model contract for the grouped product shelf.
 *
 * Raw DealRecord rows remain the source of truth. This version is intentionally
 * conservative: the grouping key contains every product and price fact that
 * must match before vendor offers can share one visual row.
 */
export const DEAL_GROUP_KEY_VERSION = 1 as const;
export interface VendorOfferRecord {
  productDestination?: {
    url: string;
    productVariationId: string;
    vendorId: string;
  } | null;
  logoUrl?: string | null;
  benefit?: DealRecord["benefit"];
  observedAt?: string;
  provenance?: string[];
  sourceMoneyUnit?: "toman" | "rial";
  originalAmountToman?: number;
  discountAmountToman?: number;
  finalAmountToman?: number;
  offerKey: string;
  productVariationId: string;
  vendorId: string;
  vendorTitle: string;
  vendorCode: string | null;
  priceRials: number;
  discountRials: number;
  finalPriceRials: number;
  discountRatio: number;
  stock: number;
  availability?: "available" | "unavailable" | "unknown";
  stockQuantity?: number | null;
  state: DealState;
}
export interface DealGroupRecord {
  key: string;
  groupKeyVersion: 1 | 2;
  bestCurrentOffer?: VendorOfferRecord | null;
  currentStoreOfferCount?: number;
  conditionalOffers?: VendorOfferRecord[];
  diagnostics?: string[];
  scanId: string;
  title: string;
  image: string | null;
  categoryTitle: string | null;
  priceRials: number;
  discountRials: number;
  finalPriceRials: number;
  discountRatio: number;
  state: DealState;
  vendors: VendorOfferRecord[];
}

/**
 * Normalize only presentation variants that are safe for exact grouping.
 * ZWNJ is treated as a word separator because feeds commonly mix it with a
 * normal space in Persian product titles; fuzzy matching is deliberately not
 * performed here.
 */
export function normalizeDealGroupText(
  value: string | null | undefined
): string | null {
  if (value == null) return null;
  const normalized = value
    .normalize("NFKC")
    .replace(/[يى]/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/\u200c/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || null;
}

/**
 * Canonicalize harmless URL spelling differences while preserving path,
 * query, and meaningful image transformations. Invalid/relative values are
 * compared as normalized strings rather than rejected.
 */
export function canonicalizeDealGroupImage(
  value: string | null | undefined
): string | null {
  const normalized = normalizeDealGroupText(value);
  if (!normalized) return null;
  try {
    const url = new URL(normalized);
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    if (
      (url.protocol === "https:" && url.port === "443") ||
      (url.protocol === "http:" && url.port === "80")
    )
      url.port = "";
    // Fragments are client-only and do not identify a different image.
    url.hash = "";
    return url.toString();
  } catch {
    return normalized;
  }
}

const dealStateRank = (state: DealState) =>
  state === "still_available" ? 2 : state === "new" ? 1 : 0;

const preferredDeal = (a: DealRecord, b: DealRecord) => {
  const stateRank = dealStateRank(a.state) - dealStateRank(b.state);
  if (stateRank) return stateRank > 0 ? a : b;
  return a.key <= b.key ? a : b;
};

/**
 * Build the v1 grouped read projection for one provider/scan.
 *
 * `deals` can contain current rows and prior rows marked
 * `no_longer_present`, as returned by Store.deals(). Vendor identity and
 * stock are excluded from the product key, but vendor rows are retained as
 * unique chips with their individual history state.
 */
export function groupDeals(
  provider: string,
  deals: readonly DealRecord[]
): DealGroupRecord[] {
  const buckets = new Map<string, DealRecord[]>();
  for (const deal of deals) {
    const key = `v${DEAL_GROUP_KEY_VERSION}:${JSON.stringify([
      normalizeDealGroupText(provider) ?? "",
      deal.productVariationId.trim(),
      normalizeDealGroupText(deal.title) ?? "",
      canonicalizeDealGroupImage(deal.image),
      normalizeDealGroupText(deal.categoryTitle),
      deal.priceRials,
      deal.discountRials,
      deal.finalPriceRials,
      deal.discountRatio,
    ])}`;
    const rows = buckets.get(key);
    if (rows) rows.push(deal);
    else buckets.set(key, [deal]);
  }

  return [...buckets.entries()]
    .map(([key, rows]) => {
      const current = rows.filter((row) => row.state !== "no_longer_present");
      const representative = rows.reduce(preferredDeal);
      const vendorRows = new Map<string, DealRecord>();
      for (const row of rows) {
        const previous = vendorRows.get(row.vendorId);
        if (!previous) vendorRows.set(row.vendorId, row);
        else vendorRows.set(row.vendorId, preferredDeal(row, previous));
      }
      const vendors = [...vendorRows.values()]
        .map((row): VendorOfferRecord => ({
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
          state: row.state,
        }))
        .sort((a, b) => {
          const aTitle = normalizeDealGroupText(a.vendorTitle) ?? "";
          const bTitle = normalizeDealGroupText(b.vendorTitle) ?? "";
          return aTitle < bTitle
            ? -1
            : aTitle > bTitle
              ? 1
              : a.vendorId < b.vendorId
                ? -1
                : a.vendorId > b.vendorId
                  ? 1
                  : 0;
        });
      const state: DealState = current.length
        ? current.some((row) => row.state === "still_available")
          ? "still_available"
          : "new"
        : "no_longer_present";
      return {
        key,
        groupKeyVersion: DEAL_GROUP_KEY_VERSION,
        scanId: representative.scanId,
        title: representative.title,
        image: representative.image,
        categoryTitle: representative.categoryTitle,
        priceRials: representative.priceRials,
        discountRials: representative.discountRials,
        finalPriceRials: representative.finalPriceRials,
        discountRatio: representative.discountRatio,
        state,
        vendors,
      } satisfies DealGroupRecord;
    })
    .sort((a, b) =>
      a.discountRatio !== b.discountRatio
        ? b.discountRatio - a.discountRatio
        : a.key < b.key
          ? -1
          : a.key > b.key
            ? 1
            : 0
    );
}
