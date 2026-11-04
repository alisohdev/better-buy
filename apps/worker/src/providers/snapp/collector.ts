import { z } from "zod";
import { Effect } from "effect";
import { CollectorError, type PersistenceError } from "../../domain/failures";
import { requestJson, type Fetcher } from "../../infrastructure/http";
import { vendorSchema, responseSchema, normalizeSnappDeals } from "./model";
import {
  planStoreCampaigns,
  enrichStoreCampaigns,
  type CampaignScope,
} from "./storeCampaigns";

export interface CollectInput {
  latitude: number;
  longitude: number;
  threshold: number;
  fetcher?: Fetcher;
  storeCampaigns?: boolean;
  onManifest?: (
    scopes: CampaignScope[]
  ) => Effect.Effect<void, PersistenceError>;
  onProgress?: (counts: {
    vendorCount: number;
    productCount: number;
  }) => Effect.Effect<void, PersistenceError>;
}

// Public PWA configuration, owned by the provider adapter, never by a customer.
const SNAPP_PWA = {
  client: "PWA",
  deviceType: "PWA",
  appVersion: "1.403.1",
} as const;
const snappHeaders = {
  accept: "application/json, text/plain, */*",
  "accept-language": "fa-IR, fa;q=0.9,en;q=0.8",
  origin: "https://snapp.market",
  referer: "https://snapp.market/",
  "user-agent": "Mozilla/5.0 BetterBuy/1.0",
};
const guestSchema = z.object({
  status: z.literal(true),
  data: z.object({
    access_token: z.string().trim().min(1),
    expires_in: z.number().positive(),
  }),
});

export function collectDeals(input: CollectInput) {
  const collection = Effect.gen(function* () {
    const startedAt = Date.now();
    const upstream = input.fetcher ?? fetch;
    let attempts = 0;
    // Physical requests include guest acquisition, renewal and HTTP retries.
    const fetcher: Fetcher = input.storeCampaigns
      ? (url, init) => {
          attempts++;
          return upstream(url, init);
        }
      : upstream;
    const vendors = new Map<string, z.infer<typeof vendorSchema>>(),
      vendorObservedAt = new Map<string, string>(),
      pageFingerprints = new Set<string>();
    // A scan owns its guest session. Worker restarts simply acquire a new one.
    const deviceId = crypto.randomUUID();
    let guest: { token: string; expiresAt: number } | undefined;
    let renewedAfter401 = false;
    const acquireGuest = () =>
      Effect.gen(function* () {
        const url = new URL("https://svc.snapp.market/oauth2/default/token");
        Object.entries({ ...SNAPP_PWA, UDID: deviceId }).forEach(([k, v]) =>
          url.searchParams.set(k, v)
        );
        const requestedAt = Date.now();
        const response = yield* requestJson(
          url,
          {
            method: "POST",
            headers: { ...snappHeaders, "content-type": "application/json" },
            body: JSON.stringify({
              data: {
                device_uid: deviceId,
                client_id: "snappfood_pwa",
                client_secret: "snappfood_pwa_secret",
                grant_type: "client_credentials",
                scope: "mobile_v2 mobile_v1 webview",
              },
            }),
          },
          {
            fetcher,
            provider: "اسنپ‌مارکت",
            allow401: true,
            forbiddenCode: "UPSTREAM_FORBIDDEN",
            invalidJsonCode: "UPSTREAM_INVALID_JSON",
          }
        );
        if (response.status === 401)
          return yield* Effect.fail(
            new CollectorError(
              "GUEST_AUTH_REJECTED",
              "دسترسی خودکار اسنپ‌مارکت برقرار نشد؛ بعداً دوباره اسکن کنید"
            )
          );
        const parsed = guestSchema.safeParse(response.body);
        if (!parsed.success)
          return yield* Effect.fail(
            new CollectorError(
              "UPSTREAM_CHANGED",
              "ساختار پاسخ دسترسی خودکار اسنپ‌مارکت تغییر کرده است"
            )
          );
        const access = {
          token: parsed.data.data.access_token,
          expiresAt: requestedAt + parsed.data.data.expires_in * 1000,
        };
        if (access.expiresAt <= Date.now())
          return yield* Effect.fail(
            new CollectorError(
              "GUEST_AUTH_REJECTED",
              "دسترسی خودکار اسنپ‌مارکت اعتبار کافی برای اسکن ندارد"
            )
          );
        return access;
      });
    const read = (url: URL) =>
      Effect.gen(function* () {
        Object.entries({ ...SNAPP_PWA, UDID: deviceId }).forEach(([k, v]) =>
          url.searchParams.set(k, v)
        );
        if (!guest || guest.expiresAt <= Date.now())
          guest = yield* acquireGuest();
        const access = guest;
        const requestPage = (token = access.token) =>
          requestJson(
            url,
            {
              headers: { ...snappHeaders, authorization: `Bearer ${token}` },
            },
            {
              fetcher,
              provider: "اسنپ‌مارکت",
              allow401: true,
              forbiddenCode: "UPSTREAM_FORBIDDEN",
              invalidJsonCode: "UPSTREAM_INVALID_JSON",
              allowNoContent:
                url.pathname === "/express-search/product-list/vendor",
            }
          );
        let response = yield* requestPage();
        if (response.status === 401 && !renewedAfter401) {
          renewedAfter401 = true;
          guest = yield* acquireGuest();
          response = yield* requestPage(guest.token);
        }
        if (response.status === 401)
          return yield* Effect.fail(
            new CollectorError(
              "GUEST_AUTH_REJECTED",
              "اسنپ‌مارکت دسترسی خودکار اسکن را نپذیرفت؛ بعداً دوباره تلاش کنید"
            )
          );
        return { ...response, observedAt: new Date().toISOString() };
      });
    const planned = input.storeCampaigns
      ? yield* planStoreCampaigns(read, input)
      : undefined;
    if (planned && input.onManifest)
      yield* input.onManifest(
        planned.plans.map(
          ({ first, firstObservedAt, title, ...scope }) => scope
        )
      );
    let totalCount = Infinity;
    for (let page = 0; vendors.size < totalCount; page++) {
      const url = new URL(
        `https://svc.snapp.market/market-party/${input.latitude}/${input.longitude}`
      );
      Object.entries({
        deal_type: "supermarket",
        user_id: "0",
        isPro: "false",
        page: String(page),
        page_size: "100",
      }).forEach(([k, v]) => url.searchParams.set(k, v));
      const response = yield* read(url);
      const parsed = responseSchema.safeParse(response.body);
      if (!parsed.success || !parsed.data.status)
        return yield* Effect.fail(
          new CollectorError(
            "UPSTREAM_CHANGED",
            "ساختار پاسخ اسنپ‌مارکت تغییر کرده است"
          )
        );
      totalCount = parsed.data.data.total_count;
      const pageVendors = parsed.data.data.vendors,
        fingerprint = pageVendors
          .map((v) => String(v.vendor_id))
          .sort()
          .join(",");
      if (pageVendors.length === 0) {
        if (vendors.size < totalCount)
          return yield* Effect.fail(
            new CollectorError(
              "INCOMPLETE_PAGINATION",
              "همه فروشگاه‌ها دریافت نشدند"
            )
          );
        break;
      }
      if (pageFingerprints.has(fingerprint))
        return yield* Effect.fail(
          new CollectorError(
            "INCOMPLETE_PAGINATION",
            "صفحه تکراری از اسنپ‌مارکت دریافت شد"
          )
        );
      pageFingerprints.add(fingerprint);
      for (const vendor of pageVendors) {
        vendors.set(String(vendor.vendor_id), vendor);
        vendorObservedAt.set(String(vendor.vendor_id), response.observedAt);
      }
      const productKeys = new Set<string>();
      for (const vendor of vendors.values())
        for (const p of vendor.products)
          productKeys.add(`${p.vendorId}:${p.productVariationId}`);
      if (input.onProgress)
        yield* input.onProgress({
          vendorCount: vendors.size,
          productCount: productKeys.size,
        });
    }
    if (vendors.size < totalCount)
      return yield* Effect.fail(
        new CollectorError(
          "INCOMPLETE_PAGINATION",
          `تنها ${vendors.size} از ${totalCount} فروشگاه دریافت شد`
        )
      );
    const baseline = normalizeSnappDeals(
      vendors.values(),
      vendors.size,
      input.threshold
    );
    baseline.deals = baseline.deals.map((deal) => ({
      ...deal,
      observedAt: vendorObservedAt.get(deal.vendorId),
      provenance: ["snapp:market_party"],
      observationPriority: 100,
    }));
    if (!planned) return baseline;
    const productKeys = new Set<string>();
    const vendorIds = new Set<string>();
    for (const vendor of vendors.values()) {
      const ownerId = Number(vendor.vendor_id);
      if (!Number.isSafeInteger(ownerId) || ownerId <= 0)
        return yield* Effect.fail(
          new CollectorError(
            "UPSTREAM_CHANGED",
            "Market Party vendor_id is not a positive numeric identity"
          )
        );
      vendorIds.add(String(ownerId));
      for (const product of vendor.products) {
        if (Number(product.vendorId) !== ownerId)
          return yield* Effect.fail(
            new CollectorError(
              "UPSTREAM_CHANGED",
              "Market Party product.vendorId conflicts with vendor_id"
            )
          );
        productKeys.add(`${ownerId}:${product.productVariationId}`);
      }
    }
    baseline.deals = baseline.deals.map((deal) => ({
      ...deal,
      vendorId: String(Number(deal.vendorId)),
      key: `${Number(deal.vendorId)}:${deal.productVariationId}`,
    }));
    const result = yield* enrichStoreCampaigns(
      read,
      input,
      planned.plans,
      baseline,
      productKeys,
      vendorIds,
      planned.omitted
    );
    if (input.onProgress)
      yield* input.onProgress({
        vendorCount: result.vendorCount,
        productCount: result.productCount,
      });
    return {
      ...result,
      campaignResearch: {
        ...result.campaignResearch,
        discoveredCandidates: planned.discoveredCandidates,
        requests: attempts,
        elapsedMs: Date.now() - startedAt,
        requestBudget: null,
      },
    };
  });
  return collection;
}
