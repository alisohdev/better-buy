import { z } from "zod";

/** Grocery providers supported by the shared basket. */
export const cartSourceSchema = z.enum(["snappmarket", "okala", "digikalajet"]);
export type CartSource = z.infer<typeof cartSourceSchema>;

export const cartQuantitySchema = z.number().int().min(1).max(99);
export const cartItemKeySchema = z.string().trim().min(1).max(512);
export const cartAddItemSchema = z
  .object({
    scanId: z.string().trim().min(1).max(128),
    quantity: cartQuantitySchema,
  })
  .strict();
export const cartUpdateItemSchema = z
  .object({ quantity: cartQuantitySchema })
  .strict();
export const cartLocationQuerySchema = z.object({
  locationId: z.string().trim().min(1).max(128).optional(),
});

export type CartRecommendationStatus =
  "empty" | "no_scan" | "complete" | "partial" | "search_limit";
export type CartMissingReason = "insufficient_quantity" | "missing_product";

export interface CartLine {
  key: string;
  title: string;
  image: string | null;
  categoryTitle: string | null;
  quantity: number;
}

export interface CartAssignedItem extends CartLine {
  priceRials: number;
  lineTotalRials: number;
  originalPriceRials?: number;
}

export interface CartStoreRecommendation {
  vendorId: string;
  vendorCode: string | null;
  vendorTitle: string;
  /** Actual provider logo URL when persisted metadata contains a valid URL. */
  logoUrl: string | null;
  items: CartAssignedItem[];
  totalRials: number;
}

export interface CartMissingItem extends CartLine {
  reason: CartMissingReason;
}

export interface CartRecommendation {
  status: CartRecommendationStatus;
  optimal: boolean;
  stores: CartStoreRecommendation[];
  missingItems: CartMissingItem[];
  totalRials: number;
  /** Included when the exact search budget was reached before proving optimality. */
  searchLimit?: number;
}

export interface CartResponse {
  source: CartSource;
  locationId: string | null;
  scanId: string | null;
  observedAt: string | null;
  coverage: "supported_discount_feeds" | "legacy_unverified";
  lines: CartLine[];
  recommendation: CartRecommendation;
}

const cartLineSchema = z.object({
  key: cartItemKeySchema,
  title: z.string(),
  image: z.string().nullable(),
  categoryTitle: z.string().nullable(),
  quantity: cartQuantitySchema,
});
const cartAssignedItemSchema = cartLineSchema.extend({
  priceRials: z.number().finite().nonnegative(),
  lineTotalRials: z.number().finite().nonnegative(),
  originalPriceRials: z.number().finite().nonnegative().optional(),
});
export const cartRecommendationSchema = z.object({
  status: z.enum(["empty", "no_scan", "complete", "partial", "search_limit"]),
  optimal: z.boolean(),
  stores: z.array(
    z.object({
      vendorId: z.string(),
      vendorCode: z.string().nullable(),
      vendorTitle: z.string(),
      logoUrl: z
        .string()
        .url()
        .refine((value) => {
          const protocol = new URL(value).protocol;
          return protocol === "http:" || protocol === "https:";
        })
        .nullable(),
      items: z.array(cartAssignedItemSchema),
      totalRials: z.number().finite().nonnegative(),
    })
  ),
  missingItems: z.array(
    cartLineSchema.extend({
      reason: z.enum(["insufficient_quantity", "missing_product"]),
    })
  ),
  totalRials: z.number().finite().nonnegative(),
  searchLimit: z.number().int().positive().optional(),
});
export const cartResponseSchema = z.object({
  source: cartSourceSchema,
  locationId: z.string().nullable(),
  scanId: z.string().nullable(),
  observedAt: z.string().nullable(),
  coverage: z.enum(["supported_discount_feeds", "legacy_unverified"]),
  lines: z.array(cartLineSchema),
  recommendation: cartRecommendationSchema,
});
