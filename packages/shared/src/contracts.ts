import { z } from "zod";
import { locationInputSchema } from "./validation";
export type LocationInput = z.infer<typeof locationInputSchema>;
export type DealState =
  "current" | "new" | "still_available" | "no_longer_present";
export type ScanStatus =
  "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface LocationRecord extends LocationInput {
  coordinateRevision?: number;
  id: string;
  createdAt: string;
  updatedAt: string;
}
export interface LocationSearchResult {
  latitude: number;
  longitude: number;
  displayName: string;
}
export interface ProviderCapabilities {
  requiresCustomerCredentials: false;
  access: "public";
  coverage: "campaign-feed";
}
export interface ScanRecord {
  observation?: {
    oldestAt: string;
    newestAt: string;
    reusedRequestCount: number;
    totalRequestCount: number;
  };
  execution?: {
    kind: "workflow";
    phase: string;
    completedUnits: number;
    totalUnits: number;
    completedPages: number;
    observedRows: number;
    eligibleOffers: number;
    attemptCount: number;
    heartbeatAt: string | null;
    deadlineAt: string | null;
    dispatchState: string;
    cancelRequested: boolean;
  };
  context?: import("./scanContext").ScanContext | null;
  id: string;
  locationId: string;
  locationName: string;
  threshold: number;
  source: "snappmarket" | "digikalajet" | "okala";
  mode: "partial" | "full";
  status: ScanStatus;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  /** Distinct stores inspected in returned feed entities, including empty entities. */
  vendorCount: number;
  productCount: number;
  dealCount: number;
  errorCode: string | null;
  errorMessage: string | null;
}
export interface DealRecord {
  productDestination?: {
    url: string;
    productVariationId: string;
    vendorId: string;
  } | null;
  benefit?: {
    kind: "standard_discount" | "market_party" | "conditional";
    identity: string;
    applicable: boolean | null;
    terms: string | null;
  };
  observedAt?: string;
  provenance?: string[];
  observationPriority?: number;
  key: string;
  scanId: string;
  productVariationId: string;
  vendorId: string;
  title: string;
  image: string | null;
  vendorTitle: string;
  vendorCode: string | null;
  vendorLogoUrl?: string | null;
  categoryTitle: string | null;
  priceRials: number;
  discountRials: number;
  finalPriceRials: number;
  discountRatio: number;
  stock: number;
  availability?: "available" | "unavailable" | "unknown";
  stockQuantity?: number | null;
  state: DealState;
}
