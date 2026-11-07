import { z } from "zod";
import { locationInputSchema } from "./validation";
const count = z.number().int().nonnegative();
const date = z.string().refine((value) => Number.isFinite(Date.parse(value)));
const state = z.enum([
  "current",
  "new",
  "still_available",
  "no_longer_present",
]);
export const scanContextSchema = z.object({
  location: z.object({
    name: z.string(),
    latitude: z.number().finite(),
    longitude: z.number().finite(),
    revision: count.positive(),
  }),
  requestedThreshold: z.number(),
  effectiveThreshold: z.number(),
  policyVersion: z.literal("automatic-v1"),
  manifest: z.object({
    adapter: z.string(),
    contractVersion: count.positive(),
    feedKinds: z.array(z.string()),
    collectionIds: z.array(count).optional(),
    storeIds: z.array(count).optional(),
    storeCampaigns: z
      .array(
        z.object({
          vendorId: count.positive(),
          vendorCode: z.string().min(1),
          collectionId: count.positive(),
          source: z.literal("discounted_category").optional(),
          expectedPageSize: count.positive().max(100).optional(),
          maxPages: count.positive().max(40).optional(),
          bounded: z.boolean().optional(),
        })
      )
      .optional(),
  }),
  scopeHash: z.string(),
  eligibilityVersion: z.literal(1),
  offerKeyVersion: z.literal(1),
  coverage: z.enum(["pending", "complete", "incomplete"]),
});
const prices = {
  priceRials: z.number().nonnegative(),
  discountRials: z.number().nonnegative(),
  finalPriceRials: z.number().nonnegative(),
  discountRatio: z.number(),
};
export const locationRecordSchema = locationInputSchema.extend({
  id: z.string().min(1),
  createdAt: date,
  updatedAt: date,
  coordinateRevision: count.positive().optional(),
});
export const scanRecordSchema = z.object({
  observation: z
    .object({
      oldestAt: date,
      newestAt: date,
      reusedRequestCount: count,
      totalRequestCount: count,
    })
    .optional(),
  execution: z
    .object({
      kind: z.literal("workflow"),
      phase: z.string(),
      completedUnits: count,
      totalUnits: count,
      completedPages: count,
      observedRows: count,
      eligibleOffers: count,
      attemptCount: count,
      heartbeatAt: date.nullable(),
      deadlineAt: date.nullable(),
      dispatchState: z.string(),
      cancelRequested: z.boolean(),
    })
    .optional(),
  context: scanContextSchema.nullable().optional(),
  id: z.string().min(1),
  locationId: z.string().min(1),
  locationName: z.string(),
  threshold: z.number(),
  source: z.enum(["snappmarket", "okala", "digikalajet"]),
  mode: z.enum(["partial", "full"]),
  status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
  createdAt: date,
  startedAt: date.nullable(),
  finishedAt: date.nullable(),
  vendorCount: count,
  productCount: count,
  dealCount: count,
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
});
export const vendorOfferSchema = z.object({
  productDestination: z
    .object({
      url: z
        .string()
        .url()
        .refine((value) => {
          const url = new URL(value);
          return (
            url.protocol === "https:" &&
            !url.username &&
            !url.password &&
            !url.port &&
            !url.search &&
            !url.hash &&
            url.pathname !== "/" &&
            !url.pathname.includes("%") &&
            !value.includes("\\") &&
            [
              "snapp.market",
              "www.snapp.market",
              "okala.com",
              "www.okala.com",
            ].includes(url.hostname)
          );
        }),
      productVariationId: z.string().min(1),
      vendorId: z.string().min(1),
    })
    .nullable()
    .default(null),
  logoUrl: z
    .string()
    .url()
    .refine((value) => {
      const protocol = new URL(value).protocol;
      return protocol === "http:" || protocol === "https:";
    })
    .nullable()
    .optional(),
  vendorLogoUrl: z
    .string()
    .url()
    .refine((value) => {
      const protocol = new URL(value).protocol;
      return protocol === "http:" || protocol === "https:";
    })
    .nullable()
    .optional(),
  benefit: z
    .object({
      kind: z.enum(["standard_discount", "market_party", "conditional"]),
      identity: z.string(),
      applicable: z.boolean().nullable(),
      terms: z.string().nullable(),
    })
    .optional(),
  observedAt: date.optional(),
  provenance: z.array(z.string()).optional(),
  sourceMoneyUnit: z.enum(["toman", "rial"]).optional(),
  originalAmountToman: z.number().nonnegative().optional(),
  discountAmountToman: z.number().nonnegative().optional(),
  finalAmountToman: z.number().nonnegative().optional(),
  offerKey: z.string(),
  productVariationId: z.string(),
  vendorId: z.string(),
  vendorTitle: z.string(),
  vendorCode: z.string().nullable(),
  ...prices,
  stock: z.number(),
  state,
});
export const dealRecordSchema = vendorOfferSchema
  .omit({ offerKey: true })
  .extend({
    key: z.string(),
    scanId: z.string(),
    title: z.string(),
    image: z.string().nullable(),
    categoryTitle: z.string().nullable(),
  });
export const offerFactsSchema = vendorOfferSchema
  .pick({
    benefit: true,
    observedAt: true,
    provenance: true,
    vendorLogoUrl: true,
  })
  .extend({ observationPriority: z.number().int().optional() });
export const dealGroupSchema = z.object({
  key: z.string(),
  groupKeyVersion: z.literal(1),
  scanId: z.string(),
  title: z.string(),
  image: z.string().nullable(),
  categoryTitle: z.string().nullable(),
  ...prices,
  state,
  vendors: z.array(vendorOfferSchema).min(1),
});
export const locationsReadSchema = z.array(locationRecordSchema);
export const scansReadSchema = z.array(scanRecordSchema);
export const dealsReadSchema = z.array(dealRecordSchema);
export const groupsReadSchema = z.array(dealGroupSchema);
export const productGroupSchema = dealGroupSchema.extend({
  groupKeyVersion: z.literal(2),
  vendors: z.array(vendorOfferSchema),
  bestCurrentOffer: vendorOfferSchema.nullable(),
  currentStoreOfferCount: count,
  conditionalOffers: z.array(vendorOfferSchema),
  diagnostics: z.array(z.string()),
});
export const productsReadSchema = z.array(productGroupSchema);
export const productSummarySchema = productGroupSchema
  .omit({ vendors: true, conditionalOffers: true })
  .extend({
    conditionalOfferCount: count,
    wishlistMatch: z.boolean().default(false),
    cartQuantity: count.default(0),
  });
export const productPageSchema = z.object({
  items: z.array(productSummarySchema).max(100),
  nextCursor: z.string().min(1).max(8192).nullable(),
  observedAt: date,
  coverageSummary: z.string(),
  baseline: z.object({ scanId: z.string().nullable(), reason: z.string() }),
});
export const offerPageSchema = z.object({
  items: z.array(vendorOfferSchema).max(50),
  nextCursor: z.string().min(1).max(8192).nullable(),
});
export type ProductSummary = z.infer<typeof productSummarySchema>;
export type ProductPage = z.infer<typeof productPageSchema>;
export type OfferPage = z.infer<typeof offerPageSchema>;
export const scanStartedSchema = scanRecordSchema;
export const locationSearchReadSchema = z.array(
  z.object({
    latitude: z.number().finite(),
    longitude: z.number().finite(),
    displayName: z.string(),
  })
);
