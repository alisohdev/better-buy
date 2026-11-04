import { Effect } from "effect";
import { identityDigest } from "@better-buy/shared";
import { responseSchema, normalizeSnappDeals } from "../providers/snapp/model";
import {
  planStoreCampaigns,
  campaignExclusionReason,
  enrichStoreCampaigns,
  collectionUrl,
  parseScopePage,
  type CampaignScope,
  type Plan,
  type CampaignDiagnostics,
} from "../providers/snapp/storeCampaigns";
import {
  campaignsResponse,
  nearbyResponse,
  offersResponse,
  normalizeOkalaOffer,
} from "../providers/okala/model";
import {
  campaignExpiry,
  type OkalaOfferCollection,
} from "../providers/okala/sharedOffers";
import { isEligibleDeal } from "../domain/eligibility";
import { CollectorError } from "../domain/failures";
import {
  DurableError,
  type Job,
  type Page,
  type PageCheckpoint,
  type Unit,
} from "./types";
import { effectValue } from "./provider";
import type { DurableRepository } from "./repository";

type Read = ((url: URL, key: string) => Promise<unknown>) & {
  observedAt?: (key: string) => Promise<string | null>;
  okalaOffers?: (input: {
    url: URL;
    key: string;
    campaignId: number;
    storeIds: number[];
    campaignExpiry: ReturnType<typeof campaignExpiry>;
  }) => Promise<{
    collection: OkalaOfferCollection;
    observedAt: string;
    reusableUntil: string;
    reused: boolean;
  }>;
};
const invalid = () =>
  new DurableError(
    "UPSTREAM_CHANGED",
    "Provider response no longer matches the verified contract"
  );
const incomplete = (reason: string) =>
  new DurableError("INCOMPLETE_PAGINATION", reason);
function okalaTerminal(value: { hasNextPage?: boolean; totalPages?: number }) {
  if (value.hasNextPage || (value.totalPages ?? 1) > 1)
    throw incomplete("Okala next-page request contract is not verified");
}
const okalaUrl = (path: string, query: URLSearchParams) =>
  new URL(`https://apigateway.okala.com/api${path}?${query}`);
export async function planUnits(repo: DurableRepository, job: Job, read: Read) {
  const id = job.scan.id,
    loc = {
      latitude: job.context.location.latitude,
      longitude: job.context.location.longitude,
    };
  if (job.runtime.manifest_frozen) return repo.units(id);
  if (job.scan.source === "snappmarket") {
    const units: Unit[] = [{ id: "market-party", kind: "market_party" }];
    let scopes: CampaignScope[] = [];
    if (job.runtime.enrichment_enabled) {
      // Each actual discovery GET is its own persisted Workflow request checkpoint.

      let omissions: CampaignDiagnostics["omitted"] = [];
      const plans = await effectValue(
        planStoreCampaigns(
          (url) =>
            Effect.tryPromise({
              try: async () => {
                const key = `plan-${await identityDigest(url.toString())}`;
                const body = await read(url, key);
                return {
                  status: 200,
                  body,
                  observedAt:
                    (await read.observedAt?.(key)) ??
                    job.scan.startedAt ??
                    job.scan.createdAt,
                };
              },
              catch: (error) =>
                error instanceof CollectorError
                  ? error
                  : new CollectorError("UPSTREAM_CHANGED", "Discovery failed"),
            }),
          loc,
          (rows) => {
            omissions = rows;
          }
        )
      ).catch(async (error: unknown) => {
        const code =
          error instanceof CollectorError || error instanceof DurableError
            ? error.code
            : "UNKNOWN_DISCOVERY_FAILURE";
        await repo.savePlanningAudit(id, omissions, code);
        throw error;
      });
      await repo.savePlanningAudit(id, plans.omitted);
      for (const plan of plans.plans) {
        const { first, firstObservedAt, title, ...scope } = plan;
        const firstRequest = `plan-${await identityDigest(collectionUrl(plan, 0, loc).toString())}`;
        units.push({
          id: `${plan.source ?? "campaign"}-${plan.vendorId}-${plan.collectionId}`,
          kind: "store_campaign",
          ...scope,
          title: plan.title,
          firstRequest,
        });
      }
      scopes = plans.plans.map(
        ({ first, firstObservedAt, title, ...scope }) => scope
      );
    }
    const manifest = {
      ...job.context.manifest,
      adapter: scopes.length
        ? "snapp-market-party+store-campaigns"
        : "snapp-market-party",
      feedKinds: scopes.length
        ? [
            "market_party",
            ...new Set(scopes.map((scope) => scope.source ?? "store_campaign")),
          ]
        : ["market_party"],
      ...(job.runtime.enrichment_enabled ? { storeCampaigns: scopes } : {}),
    };
    await repo.freeze(id, units, manifest);
    return units;
  }
  const coordinates = {
    latitude: String(loc.latitude),
    longitude: String(loc.longitude),
  };
  const nearby = nearbyResponse.safeParse(
    await read(
      okalaUrl("/opex/v4/stores/nearby", new URLSearchParams(coordinates)),
      "okala-nearby"
    )
  );
  if (!nearby.success || !nearby.data.success) throw invalid();
  const storeIds = [
    ...new Set(
      nearby.data.data.stores
        .filter((s) => s.isActive && s.isExist && s.isServes)
        .map((s) => s.storeId)
    ),
  ].sort((a, b) => a - b);
  if (!storeIds.length)
    throw new DurableError("NO_STORES", "No supported stores found");
  const query = new URLSearchParams({ ...coordinates, pageType: "HomePage" });
  storeIds.forEach((v) => query.append("StoreIds", String(v)));
  const campaigns = campaignsResponse.safeParse(
    await read(okalaUrl("/carousel/v4/offers", query), "okala-campaigns")
  );
  if (!campaigns.success || !campaigns.data.success) throw invalid();
  okalaTerminal(campaigns.data);
  const campaignExpiries = new Map(
    campaigns.data.carousels.flatMap((campaign) =>
      campaign.isMulti
        ? [[campaign.id, campaignExpiry(campaign.endTime)] as const]
        : []
    )
  );
  const ids = [...campaignExpiries.keys()]
    .filter((id) => {
      const expiry = campaignExpiries.get(id)!;
      return expiry.kind !== "known" || Date.parse(expiry.endTime) > Date.now();
    })
    .sort((a, b) => a - b);
  if (!ids.length)
    throw new DurableError("NO_CAMPAIGNS", "No supported campaigns found");
  const units: Unit[] = ids.map((collectionId) => ({
    id: `okala-${collectionId}`,
    kind: "okala_campaign",
    collectionId,
    storeIds,
    campaignExpiry: campaignExpiries.get(collectionId)!,
  }));
  await repo.freeze(id, units, {
    ...job.context.manifest,
    collectionIds: ids,
    storeIds,
  });
  return units;
}
export async function collectPage(
  job: Job,
  unit: Unit,
  page: number,
  previous: PageCheckpoint[],
  read: Read
): Promise<Page> {
  const loc = {
    latitude: job.context.location.latitude,
    longitude: job.context.location.longitude,
    threshold: job.scan.threshold,
  };
  if (unit.kind === "market_party") {
    const url = new URL(
      `https://svc.snapp.market/market-party/${loc.latitude}/${loc.longitude}`
    );
    Object.entries({
      deal_type: "supermarket",
      user_id: "0",
      isPro: "false",
      page: String(page),
      page_size: "100",
    }).forEach(([k, v]) => url.searchParams.set(k, v));
    const parsed = responseSchema.safeParse(
      await read(url, `${unit.id}-${page}`)
    );
    if (!parsed.success || !parsed.data.status) throw invalid();
    const data = parsed.data.data;
    const vendors = data.vendors.map((v) => String(v.vendor_id));
    const productIds: string[] = [];
    for (const vendor of data.vendors)
      for (const p of vendor.products) {
        if (String(p.vendorId) !== String(vendor.vendor_id)) throw invalid();
        if (
          !Number.isSafeInteger(p.price) ||
          !Number.isSafeInteger(p.discount) ||
          p.price <= 0 ||
          p.discount > p.price ||
          Math.abs(p.discountRatio - (100 * p.discount) / p.price) > 1
        )
          throw invalid();
        productIds.push(`${p.vendorId}:${p.productVariationId}`);
      }
    const seen = new Set(previous.flatMap((p) => p.identities));
    vendors.forEach((v) => seen.add(v));
    const first = previous[0];
    if (first && first.reportedTotal !== data.total_count)
      throw incomplete("Baseline count changed during pagination");
    if (data.vendors.length === 0 && seen.size < data.total_count)
      throw incomplete("Baseline ended before total vendor count");
    if (seen.size > data.total_count)
      throw incomplete("Baseline vendor count exceeds total");
    const observedAt =
      (await read.observedAt?.(`${unit.id}-${page}`)) ??
      job.scan.startedAt ??
      job.scan.createdAt;
    const deals = normalizeSnappDeals(
      data.vendors,
      vendors.length,
      job.scan.threshold
    ).deals.map((offer) => ({
      ...offer,
      observedAt,
      provenance: ["snapp:market_party"],
      observationPriority: 100,
    }));
    const terminal = seen.size === data.total_count;
    return {
      offers: deals,
      eligibility: Object.fromEntries(
        deals.map((d) => [d.key, { eligible: true, excludedReason: null }])
      ),
      products: productIds,
      vendors,
      identities: vendors,
      reportedTotal: data.total_count,
      rowCount: vendors.length,
      terminal,
      terminalEvidence: terminal
        ? vendors.length === 0
          ? "empty_total_boundary"
          : "verified_vendor_total"
        : null,
      fingerprint: await identityDigest([...vendors].sort()),
    };
  }
  if (unit.kind === "store_campaign") {
    const scope = {
      vendorId: unit.vendorId!,
      vendorCode: unit.vendorCode!,
      collectionId: unit.collectionId!,
      ...(unit.source ? { source: unit.source } : {}),
      ...(unit.expectedPageSize
        ? { expectedPageSize: unit.expectedPageSize }
        : {}),
    };
    const data = parseScopePage(
      await read(
        collectionUrl(scope, page, loc),
        page === 0 && unit.firstRequest
          ? unit.firstRequest
          : `${unit.id}-${page}`
      ),
      scope,
      previous[0]?.reportedTotal
    );
    const first = previous[0];
    if (first && first.reportedTotal !== data.count)
      throw incomplete("Campaign count drift");
    if (data.finalResult.length > 100)
      throw incomplete("Campaign page size changed");
    if (
      scope.expectedPageSize &&
      data.finalResult.length > scope.expectedPageSize
    )
      throw incomplete("Category page size changed");
    const raw =
      previous.reduce((n, p) => n + p.rowCount, 0) + data.finalResult.length;
    const identities = data.finalResult.map(
      (r) => `${r.data.vendor_id}:${r.data.id}`
    );
    if (raw > data.count) throw incomplete("Campaign rows exceed total");
    const signatures: Record<string, string> = {};
    const priorSignatures = Object.assign(
      {},
      ...previous.map((p) => p.signatures ?? {})
    ) as Record<string, string>;
    const conflictingIdentities = new Set(
      previous.flatMap((p) => p.conflictingIdentities ?? [])
    );
    for (const entry of data.finalResult) {
      const p = entry.data,
        key = `${p.vendor_id}:${p.id}`;
      if (conflictingIdentities.has(key)) continue;
      const signature = await identityDigest([
        p.price,
        p.discount,
        p.discountRatio,
        p.stock,
        p.no_stock,
        p.is_out_of_stock,
        p.title,
        p.is_pro,
        p.requires_pro,
        p.isPro,
        p.conditions,
        p.terms,
        p.benefit,
      ]);
      if (
        (priorSignatures[key] && priorSignatures[key] !== signature) ||
        (signatures[key] && signatures[key] !== signature)
      ) {
        if (job.runtime.campaign_contribution_version < 1)
          throw incomplete(
            "Conflicting repeated campaign price/stock/benefit identity"
          );
        conflictingIdentities.add(key);
      }
      signatures[key] = signature;
    }
    const acceptedEntries = data.finalResult.filter(
      ({ data: product }) =>
        !conflictingIdentities.has(`${product.vendor_id}:${product.id}`)
    );
    const emptyTerminal = data.finalResult.length === 0;
    if (emptyTerminal && raw !== data.count)
      throw incomplete(
        "Campaign terminal did not cover reported raw row count"
      );
    const terminal = emptyTerminal;
    // Reuse the shipped ownership/money/benefit normalizer with an in-memory
    // synthetic terminal; no extra provider call and no whole-collector step.
    const products = new Set<string>(),
      vendors = new Set<string>();
    const plan: Plan = {
      ...scope,
      title: unit.title!,
      first: {
        ...data,
        count: acceptedEntries.length,
        finalResult: acceptedEntries,
      },
      firstObservedAt:
        (await read.observedAt?.(
          page === 0 && unit.firstRequest
            ? unit.firstRequest
            : `${unit.id}-${page}`
        )) ??
        job.scan.startedAt ??
        job.scan.createdAt,
    };
    const normalized = await effectValue(
      enrichStoreCampaigns(
        () =>
          Effect.succeed({
            status: 200,
            body: {
              status: true,
              data: {
                id: scope.collectionId,
                type: "default",
                count: acceptedEntries.length,
                finalResult: [],
              },
            },
          }),
        loc,
        [plan],
        { vendorCount: 0, productCount: 0, deals: [] },
        products,
        vendors,
        []
      )
    );
    return {
      offers: normalized.deals,
      products: [...new Set(identities)],
      vendors: [String(scope.vendorId)],
      identities,
      signatures,
      ...(conflictingIdentities.size
        ? { conflictingIdentities: [...conflictingIdentities].sort() }
        : {}),
      eligibility: Object.fromEntries(
        data.finalResult.map(({ data: p }) => {
          const excludedReason = conflictingIdentities.has(
            `${p.vendor_id}:${p.id}`
          )
            ? "CONFLICTING_DUPLICATE"
            : campaignExclusionReason(p, job.scan.threshold);
          return [
            `${p.vendor_id}:${p.id}`,
            { eligible: excludedReason === null, excludedReason },
          ];
        })
      ),
      reportedTotal: data.count,
      rowCount: data.finalResult.length,
      terminal,
      terminalEvidence: emptyTerminal
        ? conflictingIdentities.size
          ? "conflicting_campaign_rows"
          : "verified_empty_campaign_page"
        : null,
      fingerprint: await identityDigest([...identities].sort()),
    };
  }
  if (page !== 0) throw incomplete("Okala multi-page contract remains gated");
  const query = new URLSearchParams({ carouselId: String(unit.collectionId) });
  unit.storeIds!.forEach((v) => query.append("StoreIds", String(v)));
  const requestUrl = okalaUrl("/carousel/v4/offers/multi-store", query);
  const requestKey = `${unit.id}-${page}`;
  const offerResult = read.okalaOffers
    ? await read.okalaOffers({
        url: requestUrl,
        key: requestKey,
        campaignId: unit.collectionId!,
        storeIds: unit.storeIds!,
        campaignExpiry: unit.campaignExpiry ?? { kind: "unknown" },
      })
    : {
        collection: await read(requestUrl, requestKey),
        observedAt:
          (await read.observedAt?.(requestKey)) ??
          job.scan.startedAt ??
          job.scan.createdAt,
        reusableUntil: new Date(
          Date.parse(
            (await read.observedAt?.(requestKey)) ??
              job.scan.startedAt ??
              job.scan.createdAt
          ) + 120_000
        ).toISOString(),
        reused: false,
      };
  const payload = offersResponse.safeParse(offerResult.collection);
  if (!payload.success || payload.data.success === false) throw invalid();
  okalaTerminal(payload.data);
  if (payload.data.carousel && payload.data.carousel.id !== unit.collectionId)
    throw invalid();
  const allowed = new Set(unit.storeIds),
    offers: Page["offers"] = [],
    products: string[] = [],
    vendors: string[] = [];
  for (const entity of payload.data.entities) {
    if (!allowed.has(entity.storeId)) throw invalid();
    vendors.push(String(entity.storeId));
    for (const p of entity.products) {
      if (p.storeId !== entity.storeId || !allowed.has(p.storeId))
        throw invalid();
      if (
        !Number.isSafeInteger(p.price) ||
        !Number.isSafeInteger(p.okPrice) ||
        p.price <= 0 ||
        p.okPrice < 0 ||
        Math.abs(p.discountPercent - (100 * (p.price - p.okPrice)) / p.price) >
          1
      )
        throw invalid();
      products.push(`${p.storeId}:${p.id}`);
      if (
        isEligibleDeal(
          p.discountPercent,
          p.hasQuantity,
          p.quantity,
          Math.max(30, job.scan.threshold)
        )
      )
        offers.push({
          ...normalizeOkalaOffer(p),
          observedAt: offerResult.observedAt,
          provenance: [`okala:campaign:${unit.collectionId}`],
          observationPriority: 50,
        });
    }
  }
  return {
    offers,
    observations: [
      {
        observedAt: offerResult.observedAt,
        reusableUntil: offerResult.reusableUntil,
        reused: offerResult.reused,
      },
    ],
    products,
    vendors,
    identities: products,
    reportedTotal: payload.data.totalCount ?? products.length,
    rowCount: products.length,
    terminal: true,
    terminalEvidence: "verified_single_page_okala_contract",
    fingerprint: await identityDigest([...products].sort()),
  };
}
