import type { LocationRecord, ScanRecord } from "./contracts";

export interface ScanContext {
  location: {
    name: string;
    latitude: number;
    longitude: number;
    revision: number;
  };
  requestedThreshold: number;
  effectiveThreshold: number;
  policyVersion: "automatic-v1" | "grocery-consumables-v1";
  manifest: {
    adapter: string;
    contractVersion: number;
    feedKinds: string[];
    collectionIds?: number[];
    storeIds?: number[];
    storeCampaigns?: {
      vendorId: number;
      vendorCode: string;
      collectionId: number;
      source?: "discounted_category";
      expectedPageSize?: number;
      maxPages?: number;
      bounded?: boolean;
    }[];
    digikalaFeeds?: { id: string; kind: string }[];
    digikala?: {
      surface: string;
      channel: string;
      shipmentType: string;
      shopId: string;
      coordinatesHash: string;
      categoryPolicy: string;
    };
  };
  scopeHash: string;
  eligibilityVersion: 1;
  offerKeyVersion: 1;
  coverage: "pending" | "complete" | "incomplete";
}

export async function identityDigest(identity: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(identity));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

// Only the existing supported collectors are admitted. Additional adapters need
// the spec's research gates; no browser selector can expand this manifest.
export async function defaultScanContext(
  location: LocationRecord,
  source: ScanRecord["source"],
  effectiveThreshold: number,
  requestedThreshold = effectiveThreshold
): Promise<ScanContext> {
  const manifest =
    source === "snappmarket"
      ? {
          adapter: "snapp-market-party",
          contractVersion: 1,
          feedKinds: ["market_party"],
        }
      : source === "okala"
        ? {
            adapter: "okala-public-campaigns",
            contractVersion: 1,
            feedKinds: ["public_campaign_feed"],
          }
        : {
            adapter: "digikalajet-pending",
            contractVersion: 1,
            feedKinds: ["fresh_supermarket"],
          };
  return {
    location: {
      name: location.name,
      latitude: location.latitude,
      longitude: location.longitude,
      revision: location.coordinateRevision ?? 1,
    },
    requestedThreshold,
    effectiveThreshold,
    policyVersion: "automatic-v1",
    manifest,
    scopeHash: await identityDigest([
      source,
      manifest,
      effectiveThreshold,
      1,
      1,
    ]),
    eligibilityVersion: 1,
    offerKeyVersion: 1,
    coverage: "pending",
  };
}
