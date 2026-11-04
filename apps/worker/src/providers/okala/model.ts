import { z } from "zod";
import type { DealRecord } from "@better-buy/shared";
const identifier = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const pagination = {
  pageIndex: z.number().int().nonnegative().optional(),
  pageSize: z.number().int().nonnegative().optional(),
  totalCount: z.number().int().nonnegative().optional(),
  totalPages: z.number().int().nonnegative().optional(),
  hasNextPage: z.boolean().optional(),
};
const store = z.object({
  storeId: identifier,
  isActive: z.boolean(),
  isServes: z.boolean(),
  isExist: z.boolean(),
});
export const nearbyResponse = z.object({
  success: z.boolean(),
  data: z.object({ stores: z.array(store) }),
});
export const campaignsResponse = z.object({
  success: z.boolean(),
  carousels: z.array(
    z.discriminatedUnion("isMulti", [
      z.object({
        isMulti: z.literal(true),
        id: identifier,
        endTime: z.string().optional(),
      }),
      z.object({ isMulti: z.literal(false) }),
    ])
  ),
  ...pagination,
});
const product = z.object({
  id: z.union([z.number(), z.string()]),
  name: z.string(),
  discountPercent: z.number(),
  quantity: z.number(),
  hasQuantity: z.boolean(),
  okPrice: z.number(),
  price: z.number(),
  storeName: z.string(),
  storeId: z.number(),
  imageUrl: z.string().nullable().optional(),
  storeTypeName: z.string().nullable().optional(),
  storeTypeId: z.number().nullable().optional(),
});
const offerEntity = z.object({
  storeId: z.number(),
  storeName: z.string(),
  logoUrl: z.unknown().optional(),
  storeLogoUrl: z.unknown().optional(),
  logo_url: z.unknown().optional(),
  store_logo_url: z.unknown().optional(),
  products: z.array(product),
});
export const offersResponse = z.object({
  carousel: z.object({ id: z.number() }).optional(),
  entities: z.array(offerEntity),
  success: z.boolean().optional(),
  ...pagination,
});

export type OkalaProduct = z.infer<typeof product>;
export function officialOkalaStoreLogo(
  entity: z.infer<typeof offerEntity>
): string | null {
  for (const value of [
    entity.logoUrl,
    entity.storeLogoUrl,
    entity.logo_url,
    entity.store_logo_url,
  ]) {
    if (typeof value !== "string") continue;
    try {
      const url = new URL(value);
      if (url.protocol === "https:" || url.protocol === "http:")
        return url.toString();
    } catch {
      /* Ignore malformed provider metadata. */
    }
  }
  return null;
}
export function normalizeOkalaOffer(
  item: OkalaProduct,
  vendorLogoUrl: string | null = null
): Omit<DealRecord, "scanId" | "state"> {
  const key = `${item.storeId}:${item.id}`;
  return {
    key,
    productVariationId: String(item.id),
    vendorId: String(item.storeId),
    title: item.name,
    image: item.imageUrl ?? null,
    vendorTitle: item.storeName,
    vendorCode: null,
    vendorLogoUrl,
    categoryTitle: item.storeTypeName ?? null,
    priceRials: item.price,
    discountRials: Math.max(0, item.price - item.okPrice),
    finalPriceRials: item.okPrice,
    discountRatio: item.discountPercent,
    stock: item.quantity,
  };
}
