import {
  nearbyResponse,
  campaignsResponse,
  offersResponse,
  normalizeOkalaOffer,
  officialOkalaStoreLogo,
} from "./model";
import { isEligibleDeal } from "../../domain/eligibility";
import type { DealRecord } from "@better-buy/shared";
import { Effect } from "effect";
import { z } from "zod";
import { CollectorError, type PersistenceError } from "../../domain/failures";
import { requestJson } from "../../infrastructure/http";
import { campaignExpiry, readOkalaOffers } from "./sharedOffers";

const baseUrl = "https://apigateway.okala.com/api";
const headers = {
  accept: "application/json",
  origin: "https://www.okala.com",
  source: "okala",
  "ui-version": "2.0",
};

function decode<A>(schema: z.ZodType<A>, body: unknown) {
  const envelope = z
    .object({
      success: z.boolean().optional(),
      hasValidationError: z.boolean().optional(),
    })
    .safeParse(body);
  if (
    envelope.success &&
    (envelope.data.success === false ||
      envelope.data.hasValidationError === true)
  )
    return Effect.fail(
      new CollectorError(
        "UPSTREAM_ERROR",
        "اکالا درخواست دریافت پیشنهادها را نپذیرفت؛ دوباره تلاش کنید."
      )
    );
  const parsed = schema.safeParse(body);
  return parsed.success
    ? Effect.succeed(parsed.data)
    : Effect.fail(
        new CollectorError(
          "UPSTREAM_CHANGED",
          "ساختار پاسخ اکالا تغییر کرده است؛ دوباره تلاش کنید."
        )
      );
}

function checkPagination(value: {
  hasNextPage?: boolean;
  totalPages?: number;
}) {
  // No verified next-page request contract. Do not guess parameters or certify a partial feed.
  return value.hasNextPage || (value.totalPages ?? 1) > 1
    ? Effect.fail(
        new CollectorError(
          "INCOMPLETE_PAGINATION",
          "پیشنهادهای اکالا صفحه‌های بیشتری دارند که دریافت نشدند؛ دوباره تلاش کنید."
        )
      )
    : Effect.void;
}

export function collectOkala(input: {
  latitude: number;
  longitude: number;
  threshold: number;
  db?: D1Database;
  scanId?: string;
  sharedOffersEnabled?: boolean;
  fetcher?: typeof fetch;
  onManifest?: (
    collectionIds: number[],
    storeIds: number[]
  ) => Effect.Effect<void, PersistenceError>;
  onProgress?: (counts: {
    vendorCount: number;
    productCount: number;
  }) => Effect.Effect<void, PersistenceError>;
}) {
  return Effect.gen(function* () {
    const get = (path: string, query: URLSearchParams) =>
      requestJson(
        `${baseUrl}${path}?${query.toString()}`,
        { headers },
        {
          fetcher: input.fetcher,
          provider: "اکالا",
          forbiddenCode: "UPSTREAM_FORBIDDEN",
          unauthorizedCode: "UPSTREAM_FORBIDDEN",
          invalidJsonCode: "UPSTREAM_INVALID_JSON",
        }
      ).pipe(Effect.map((response) => response.body));
    const coordinates = {
      latitude: String(input.latitude),
      longitude: String(input.longitude),
    };
    const nearby = yield* decode(
      nearbyResponse,
      yield* get("/opex/v4/stores/nearby", new URLSearchParams(coordinates))
    );
    const storeIds = [
      ...new Set(
        nearby.data.stores
          .filter((s) => s.isActive && s.isServes && s.isExist)
          .map((s) => s.storeId)
      ),
    ];
    if (!storeIds.length)
      return yield* Effect.fail(
        new CollectorError(
          "NO_STORES",
          "فروشگاه سرویس‌دهنده‌ای در این مکان اکالا پیدا نشد"
        )
      );
    const campaignsQuery = new URLSearchParams({
      pageType: "HomePage",
      ...coordinates,
    });
    storeIds.forEach((id) => campaignsQuery.append("StoreIds", String(id)));
    const campaigns = yield* decode(
      campaignsResponse,
      yield* get("/carousel/v4/offers", campaignsQuery)
    );
    yield* checkPagination(campaigns);
    const campaignExpiries = new Map(
      campaigns.carousels.flatMap((campaign) =>
        campaign.isMulti
          ? [[campaign.id, campaignExpiry(campaign.endTime)] as const]
          : []
      )
    );
    const campaignIds = [...campaignExpiries.keys()].filter((id) => {
      const expiry = campaignExpiries.get(id)!;
      return expiry.kind !== "known" || Date.parse(expiry.endTime) > Date.now();
    });
    if (!campaignIds.length)
      return yield* Effect.fail(
        new CollectorError(
          "NO_CAMPAIGNS",
          "کمپین چندفروشگاهی فعالی در اکالا پیدا نشد"
        )
      );
    if (input.onManifest) yield* input.onManifest(campaignIds, storeIds);
    const rows = new Map<string, Omit<DealRecord, "scanId" | "state">>();
    const eligibleStores = new Set(storeIds);
    const inspectedStores = new Set<number>();
    let products = 0;
    for (const carouselId of campaignIds) {
      const query = new URLSearchParams({ carouselId: String(carouselId) });
      storeIds.forEach((id) => query.append("StoreIds", String(id)));
      const load = (onPhysicalAttempt: () => void) =>
        requestJson(
          `${baseUrl}/carousel/v4/offers/multi-store?${query.toString()}`,
          { headers },
          {
            fetcher: input.fetcher,
            provider: "اکالا",
            forbiddenCode: "UPSTREAM_FORBIDDEN",
            unauthorizedCode: "UPSTREAM_FORBIDDEN",
            invalidJsonCode: "UPSTREAM_INVALID_JSON",
            onPhysicalAttempt,
          }
        ).pipe(Effect.map((response) => response.body));
      const observation = input.db
        ? yield* Effect.tryPromise({
            try: () =>
              readOkalaOffers({
                db: input.db!,
                enabled: input.sharedOffersEnabled === true,
                scanId: input.scanId,
                campaignId: carouselId,
                storeIds,
                campaignExpiry: campaignExpiries.get(carouselId)!,
                load: (onAttempt) => Effect.runPromise(load(onAttempt)),
              }),
            catch: (error) =>
              error instanceof CollectorError
                ? error
                : new CollectorError(
                    "UPSTREAM_ERROR",
                    "Okala offers could not be read"
                  ),
          })
        : {
            collection: yield* decode(
              offersResponse,
              yield* get("/carousel/v4/offers/multi-store", query)
            ),
            observedAt: new Date().toISOString(),
            reusableUntil: new Date().toISOString(),
            reused: false,
          };
      const payload = observation.collection;
      yield* checkPagination(payload);
      for (const entity of payload.entities) {
        const vendorLogoUrl = officialOkalaStoreLogo(entity);
        // Empty returned entities count; repeated campaign appearances do not.
        if (eligibleStores.has(entity.storeId))
          inspectedStores.add(entity.storeId);
        for (const item of entity.products) {
          products++;
          if (
            isEligibleDeal(
              item.discountPercent,
              item.hasQuantity,
              item.quantity,
              input.threshold
            )
          )
            rows.set(`${item.storeId}:${item.id}`, {
              ...normalizeOkalaOffer(item, vendorLogoUrl),
              observedAt: observation.observedAt,
            });
        }
      }
      if (input.onProgress)
        yield* input.onProgress({
          vendorCount: inspectedStores.size,
          productCount: products,
        });
    }
    return {
      vendorCount: inspectedStores.size,
      productCount: products,
      deals: [...rows.values()],
    };
  });
}
