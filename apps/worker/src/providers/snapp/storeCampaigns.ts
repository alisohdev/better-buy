import { Effect } from "effect";
import { z } from "zod";
import type { DealRecord, ScanContext } from "@better-buy/shared";
import { CollectorError } from "../../domain/failures";
import { isEligibleDeal } from "../../domain/eligibility";

export type SnappRead = (
  url: URL
) => Effect.Effect<
  { status: number; body: unknown; observedAt?: string },
  CollectorError
>;
export type CampaignScope = NonNullable<
  ScanContext["manifest"]["storeCampaigns"]
>[number];
type Offer = Omit<DealRecord, "scanId" | "state">;
// Discovery is location scoped; no store, title or collection allowlist.
const DISCOVERY_PAGE_SIZE = 20;
const owner = z.number().int().positive().safe();
const homeSchema = z.object({
  vendorInfo: z.object({
    id: owner,
    code: z.string().regex(/^[a-zA-Z0-9]+$/),
    title: z.string().min(1),
    isOutOfArea: z.boolean().optional(),
    deliveryData: z.object({
      doesDeliver: z.boolean(),
      id: owner.optional(),
      detail: z.object({ vendorId: owner.optional() }).nullish(),
      isExpress: z.boolean().optional(),
      scheduleOption: z.unknown().optional(),
      deliveryStatus: z.string().optional(),
    }),
  }),
  sections: z
    .array(
      z
        .object({
          type: z.string(),
          value: z.unknown().optional(),
          title: z.string().nullable().optional(),
          collection_type: z.string().nullable().optional(),
          config: z.unknown().optional(),
        })
        .passthrough()
    )
    .default([]),
});
const pageSchema = z.object({
  status: z.literal(true).optional(),
  data: z.object({
    id: owner,
    type: z.literal("default"),
    count: z.number().int().nonnegative(),
    finalResult: z.array(
      z.object({
        type: z.literal("PRODUCT"),
        data: z.record(z.string(), z.unknown()),
      })
    ),
  }),
});
const productSchema = z
  .object({
    id: owner,
    vendor_id: owner,
    document_id: z.string(),
    title: z.string().trim().min(1),
    price: z.number().finite().positive(),
    discount: z.number().finite().nonnegative(),
    discountRatio: z.number().finite().min(0).max(100).nullable(),
    stock: z.number().finite().nonnegative().optional(),
    no_stock: z.boolean().optional(),
    is_out_of_stock: z.boolean().optional(),
    menu_category_title: z.string().nullable().optional(),
    images: z
      .array(z.object({ main: z.string().nullable().optional() }))
      .optional(),
  })
  .passthrough();
type Page = z.infer<typeof pageSchema>["data"];
export type Plan = CampaignScope & {
  title: string;
  first: Page;
  firstObservedAt?: string;
};
export type CampaignReport = CampaignScope & {
  coverage: "complete" | "incomplete";
  partialReason?: "PAGE_LIMIT" | "REQUEST_BUDGET" | "CONFLICTING_DUPLICATES";
  reportedCount: number;
  rawCount: number;
  uniqueCount: number;
  duplicateCount: number;
  pageSizes: number[];
  terminal: boolean;
  qualifying: number;
  overlap: number;
  additional: number;
  excluded: Record<string, number>;
};
export type CampaignDiagnostics = {
  reports: CampaignReport[];
  omitted: {
    vendorCode: string;
    collectionId?: number;
    sectionType?: string;
    reason: string;
  }[];
};
const changed = (field: string) =>
  new CollectorError(
    "UPSTREAM_CHANGED",
    `Snapp campaign contract changed: ${field}`
  );
const incomplete = (field: string) =>
  new CollectorError(
    "INCOMPLETE_PAGINATION",
    `Snapp campaign coverage incomplete: ${field}`
  );

export function collectionUrl(
  scope: CampaignScope,
  page: number,
  location: { latitude: number; longitude: number }
) {
  if (scope.source === "discounted_category") {
    const url = new URL(
      "https://svc.snapp.market/express-search/product-list/vendor"
    );
    Object.entries({
      vendor_code: scope.vendorCode,
      category_id: String(scope.collectionId),
      lat: String(location.latitude),
      long: String(location.longitude),
      filters: '["has_discount"]',
      page: String(page),
      pageSize: "100",
    }).forEach(([key, value]) => url.searchParams.set(key, value));
    return url;
  }
  const url = new URL(
    `https://svc.snapp.market/express-search/product-list/${scope.collectionId}/vendor/${scope.vendorCode}`
  );
  Object.entries({
    variable: String(scope.collectionId),
    secondVariable: scope.vendorCode,
    lat: String(location.latitude),
    long: String(location.longitude),
    filters: "[]",
    page: String(page),
    page_size: "100",
  }).forEach(([key, value]) => url.searchParams.set(key, value));
  return url;
}
export function parsePage(body: unknown, collectionId: number): Page {
  const parsed = pageSchema.safeParse(body);
  if (!parsed.success)
    throw changed("data.count / data.finalResult[].type/data");
  if (parsed.data.data.id !== collectionId) throw changed("data.id ownership");
  return parsed.data.data;
}

const nearbySchema = z.object({
  status: z.literal(true),
  data: z.object({
    count: z.number().int().nonnegative(),
    finalResult: z.array(z.object({ type: z.string(), data: z.unknown() })),
    single_super_mall: z.unknown().optional(),
  }),
});
const nearbyStoreSchema = z.object({
  code: z.string().regex(/^[a-zA-Z0-9]+$/),
  title: z.unknown().optional(),
});
const categorySchema = z.object({
  status: z.literal(true),
  items: z.array(z.object({ id: owner })),
});
const categoryPageSchema = z.object({
  status: z.literal(true),
  vendor_id: z.array(owner).optional(),
  data: z.object({
    count: z.number().int().nonnegative(),
    finalResult: pageSchema.shape.data.shape.finalResult,
  }),
});
// Categories have no collection id/type. Validate any returned owner as well
// as every product's owner in the shared normalizer; never synthesize identity.
export function parseScopePage(
  body: unknown,
  scope: CampaignScope,
  terminalCount?: number
): Page {
  if (scope.source !== "discounted_category")
    return parsePage(body, scope.collectionId);
  // Live category pages return 204 after exhaustion. This is terminal only
  // after a prior count exists; callers still require rawCount === that count.
  if (
    (body === null ||
      z
        .object({ status: z.literal(204) })
        .strict()
        .safeParse(body).success) &&
    terminalCount !== undefined
  )
    return {
      id: scope.collectionId,
      type: "default",
      count: terminalCount,
      finalResult: [],
    };
  const parsed = categoryPageSchema.safeParse(body);
  if (!parsed.success)
    throw changed("discounted category data.count / finalResult");
  if (parsed.data.vendor_id?.some((id) => id !== scope.vendorId))
    throw changed("category vendor_id ownership");
  if (
    parsed.data.data.finalResult.some((row) => !(Number(row.data.discount) > 0))
  )
    throw changed("DISCOUNT_FILTER_NOT_HONORED");
  return { id: scope.collectionId, type: "default", ...parsed.data.data };
}
const conditionalMetadata = (value: Record<string, unknown>) =>
  value.is_pro === true ||
  value.requires_pro === true ||
  value.isPro === true ||
  value.conditions != null ||
  value.terms != null ||
  value.benefit != null;

export function campaignExclusionReason(
  p: Record<string, unknown>,
  threshold: number
): string | null {
  if (p.stock === undefined) return "UNKNOWN_STOCK";
  if (p.no_stock === true || p.is_out_of_stock === true || Number(p.stock) <= 0)
    return "OUT_OF_STOCK";
  if (conditionalMetadata(p)) return "UNVERIFIED_CONDITIONAL_BENEFIT";
  if (
    !isEligibleDeal(
      Number(p.discountRatio ?? 0),
      true,
      Number(p.stock),
      threshold
    )
  )
    return "BELOW_THRESHOLD";
  return null;
}

export function planStoreCampaigns(
  read: SnappRead,
  location: { latitude: number; longitude: number },
  onOmitted?: (omitted: CampaignDiagnostics["omitted"]) => void
) {
  const omitted: CampaignDiagnostics["omitted"] = [];
  return Effect.gen(function* () {
    const plans: Plan[] = [];
    const nearbyUrl = new URL(
      "https://svc.snapp.market/express-vendor/general/vendors-list"
    );
    Object.entries({
      lat: String(location.latitude),
      long: String(location.longitude),
      sort: "lowest_delivery_price",
      page: "0",
      page_size: String(DISCOVERY_PAGE_SIZE),
      is_home: "false",
      page_type: "vendor_list",
      "extra-filter[vendor_collection]": "-1",
    }).forEach(([key, value]) => nearbyUrl.searchParams.set(key, value));
    const nearby = nearbySchema.safeParse(
      (yield* read(nearbyUrl).pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            omitted.push({ vendorCode: "", reason: "NEARBY_DISCOVERY_FAILED" });
          })
        )
      )).body
    );
    if (!nearby.success) {
      omitted.push({ vendorCode: "", reason: "NEARBY_SCHEMA" });
      return yield* Effect.fail(
        changed("nearby data.count / data.finalResult")
      );
    }
    const entries = [...nearby.data.data.finalResult];
    let discovered = entries.filter((entry) => entry.type === "VENDOR").length;
    const fingerprints = new Set([JSON.stringify(entries)]);
    for (let page = 1; discovered < nearby.data.data.count; page++) {
      nearbyUrl.searchParams.set("page", String(page));
      const next = nearbySchema.safeParse((yield* read(nearbyUrl)).body);
      if (!next.success || next.data.data.count !== nearby.data.data.count)
        return yield* Effect.fail(incomplete("nearby count drift"));
      const rows = next.data.data.finalResult;
      const fingerprint = JSON.stringify(rows);
      if (!rows.length || fingerprints.has(fingerprint))
        return yield* Effect.fail(
          incomplete("nearby pagination did not advance")
        );
      fingerprints.add(fingerprint);
      entries.push(...rows);
      discovered += rows.filter((entry) => entry.type === "VENDOR").length;
    }
    const codes = new Set<string>();
    const discoveredCandidates = new Map<
      string,
      { vendorCode: string; sources: string[]; hintTitle?: string }
    >();
    // Resolve the separate hint as well as the ordinary nearby stores.
    // It often isn't present in finalResult and has no numeric identity yet.
    const hint = nearbyStoreSchema.safeParse(
      nearby.data.data.single_super_mall
    );
    if (hint.success) {
      codes.add(hint.data.code);
      discoveredCandidates.set(hint.data.code, {
        vendorCode: hint.data.code,
        sources: ["single_super_mall"],
        ...(typeof hint.data.title === "string"
          ? { hintTitle: hint.data.title }
          : {}),
      });
    } else if (nearby.data.data.single_super_mall != null)
      omitted.push({ vendorCode: "", reason: "INVALID_SUPER_MALL_HINT" });
    for (const entry of entries) {
      if (entry.type !== "VENDOR") {
        omitted.push({
          vendorCode: "",
          sectionType: entry.type,
          reason: "UNSUPPORTED_NEARBY_ENTRY",
        });
        continue;
      }
      const store = nearbyStoreSchema.safeParse(entry.data);
      if (!store.success) {
        omitted.push({ vendorCode: "", reason: "INVALID_NEARBY_VENDOR_CODE" });
        continue;
      }
      codes.add(store.data.code);
      const candidate = discoveredCandidates.get(store.data.code) ?? {
        vendorCode: store.data.code,
        sources: [],
      };
      if (!candidate.sources.includes("finalResult"))
        candidate.sources.push("finalResult");
      discoveredCandidates.set(store.data.code, candidate);
    }
    const resolvedOwners = new Map<number, string>();
    const stores: {
      info: z.infer<typeof homeSchema>["vendorInfo"];
      candidates: Set<number>;
    }[] = [];
    const isHint = (code: string) => hint.success && hint.data.code === code;
    const planScopes = (
      info: z.infer<typeof homeSchema>["vendorInfo"],
      candidates: Set<number>
    ) =>
      Effect.gen(function* () {
        const vendorCode = info.code;
        const hinted = isHint(vendorCode);
        const scopes: CampaignScope[] = [...candidates]
          .sort((a, b) => a - b)
          .map((collectionId) => ({
            vendorId: info.id,
            vendorCode,
            collectionId,
          }));
        // Only the corroborated super-mall gets category supplements. Campaigns
        // precede categories so ordinary catalog traversal cannot hide campaigns.
        if (hinted) {
          const url = new URL(
            "https://svc.snapp.market/mobile/search/categories"
          );
          Object.entries({
            vendorCode,
            lat: String(location.latitude),
            long: String(location.longitude),
          }).forEach(([k, v]) => url.searchParams.set(k, v));
          const response = yield* read(url).pipe(
            Effect.catch((error) =>
              [
                "UPSTREAM_CHANGED",
                "UPSTREAM_INVALID_JSON",
                "UPSTREAM_ERROR",
              ].includes(error.code)
                ? Effect.succeed({ status: 0, body: null })
                : Effect.fail(error)
            )
          );
          const categories = categorySchema.safeParse(response.body);
          if (!categories.success)
            omitted.push({
              vendorCode,
              reason: "CATEGORY_DISCOVERY_UNKNOWN",
            });
          else {
            const categoryScopes: CampaignScope[] = [
              ...new Set(categories.data.items.map((item) => item.id)),
            ]
              .sort((a, b) => a - b)
              .map((collectionId) => ({
                vendorId: info.id,
                vendorCode,
                collectionId,
                source: "discounted_category",
              }));
            scopes.push(...categoryScopes);
          }
        }
        for (const scope of scopes) {
          const { collectionId } = scope;
          // Count is absent from home. Cache one planning page, then freeze all
          // admitted units before baseline collection and remaining enumeration.
          const probe = yield* read(collectionUrl(scope, 0, location)).pipe(
            Effect.flatMap((response) =>
              Effect.try({
                try: () => ({
                  first: parseScopePage(response.body, scope),
                  firstObservedAt:
                    response.observedAt ?? new Date().toISOString(),
                  error: null as CollectorError | null,
                }),
                catch: (error) =>
                  error instanceof CollectorError ? error : changed("page"),
              })
            ),
            Effect.catch((error) =>
              [
                "UPSTREAM_CHANGED",
                "UPSTREAM_INVALID_JSON",
                "UPSTREAM_ERROR",
              ].includes(error.code)
                ? Effect.succeed({
                    first: null,
                    firstObservedAt: undefined,
                    error,
                  })
                : Effect.fail(error)
            )
          );
          if (!probe.first) {
            omitted.push({
              vendorCode,
              collectionId,
              reason: "UNSUPPORTED_PLANNING_RESPONSE: " + probe.error?.message,
            });
            continue;
          }
          const first = probe.first;
          if (
            first.finalResult.length > 100 ||
            (first.count > first.finalResult.length &&
              (first.finalResult.length === 0 ||
                (scope.source !== "discounted_category" &&
                  first.finalResult.length !== 100))) ||
            (first.count === 0 && first.finalResult.length !== 0) ||
            first.finalResult.length > first.count
          ) {
            omitted.push({
              vendorCode,
              collectionId,
              reason:
                "UNVERIFIED_OR_OVERSIZED_PAGINATION: invalid count or page size",
            });
            continue;
          }
          const expectedPageSize =
            scope.source === "discounted_category"
              ? first.finalResult.length || 100
              : 100;
          plans.push({
            ...scope,
            ...(scope.source === "discounted_category"
              ? { expectedPageSize }
              : {}),
            title: info.title,
            first,
            firstObservedAt: probe.firstObservedAt,
          });
        }
      });
    for (const vendorCode of codes) {
      const homeUrl = new URL(
        `https://svc.snapp.market/express-home/vendor/${vendorCode}`
      );
      Object.entries({
        variable: vendorCode,
        lat: String(location.latitude),
        long: String(location.longitude),
      }).forEach(([key, value]) => homeUrl.searchParams.set(key, value));
      const home = homeSchema.safeParse(
        (yield* read(homeUrl).pipe(
          Effect.tapError(() =>
            Effect.sync(() => {
              omitted.push({ vendorCode, reason: "HOME_DISCOVERY_FAILED" });
            })
          )
        )).body
      );
      if (!home.success) {
        omitted.push({
          vendorCode,
          reason:
            "HOME_SCHEMA: " +
            home.error.issues.map((issue) => issue.path.join(".")).join(","),
        });
        continue;
      }
      const info = home.data.vendorInfo;
      if (info.code !== vendorCode) {
        omitted.push({ vendorCode, reason: "HOME_VENDOR_CODE_MISMATCH" });
        continue;
      }
      if (
        (info.deliveryData.id !== undefined &&
          info.deliveryData.id !== info.id) ||
        (info.deliveryData.detail?.vendorId !== undefined &&
          info.deliveryData.detail.vendorId !== info.id)
      ) {
        omitted.push({ vendorCode, reason: "HOME_DELIVERY_OWNER_MISMATCH" });
        continue;
      }
      if (info.isOutOfArea === true || !info.deliveryData.doesDeliver) {
        omitted.push({
          vendorCode,
          reason:
            info.isOutOfArea === true ? "OUT_OF_AREA" : "DOES_NOT_DELIVER",
        });
        continue;
      }
      if (
        info.deliveryData.deliveryStatus === "NOT_OPEN" ||
        (info.deliveryData.isExpress === false &&
          info.deliveryData.scheduleOption === null)
      ) {
        omitted.push({ vendorCode, reason: "NO_AVAILABLE_DELIVERY_SLOT" });
        continue;
      }
      const priorCode = resolvedOwners.get(info.id);
      if (priorCode && priorCode !== vendorCode) {
        omitted.push({
          vendorCode,
          reason: "CONFLICTING_NUMERIC_VENDOR_IDENTITY",
        });
        return yield* Effect.fail(
          changed("two store codes resolve to the same vendorInfo.id")
        );
      }
      resolvedOwners.set(info.id, vendorCode);
      const candidates = new Set<number>();
      for (const section of home.data.sections) {
        const sectionId = owner.safeParse(section.value);
        const diagnostic = {
          vendorCode,
          sectionType: section.type,
          ...(sectionId.success ? { collectionId: sectionId.data } : {}),
        };
        let reason: string | undefined;
        if (section.type !== "product-list")
          reason = "UNSUPPORTED_SECTION_TYPE";
        else if (conditionalMetadata(section) || section.config != null)
          reason = "CONDITIONAL_OR_UNVERIFIED_SECTION_CONFIG";
        else if (section.collection_type !== "default")
          reason = "UNSUPPORTED_COLLECTION_TYPE";
        else if (!sectionId.success) reason = "INVALID_COLLECTION_ID";
        if (reason) omitted.push({ ...diagnostic, reason });
        else candidates.add(sectionId.data!);
      }
      if (!candidates.size)
        omitted.push({
          vendorCode,
          reason: "NO_SUPPORTED_ORDINARY_COLLECTION",
        });
      if (isHint(vendorCode)) stores.push({ info, candidates });
      else yield* planScopes(info, candidates);
    }
    // Resolve all campaign and category scopes after store discovery.
    for (const { info, candidates } of stores)
      yield* planScopes(info, candidates);
    return {
      plans,
      omitted,
      discoveredCandidates: [...discoveredCandidates.values()],
    };
  }).pipe(
    Effect.tap(() => Effect.sync(() => onOmitted?.(omitted))),
    Effect.tapError(() => Effect.sync(() => onOmitted?.(omitted)))
  );
}

export function enrichStoreCampaigns(
  read: SnappRead,
  location: { latitude: number; longitude: number; threshold: number },
  plans: Plan[],
  baseline: { vendorCount: number; productCount: number; deals: Offer[] },
  baselineProductKeys: Set<string>,
  baselineVendorIds: Set<string>,
  omitted: CampaignDiagnostics["omitted"]
) {
  return Effect.gen(function* () {
    const offers = new Map<string, Offer>(
      baseline.deals.map((deal) => [
        deal.key,
        {
          ...deal,
          provenance: deal.provenance ?? ["snapp:market_party"],
          observedAt: deal.observedAt ?? new Date().toISOString(),
          observationPriority: 100,
        },
      ])
    );
    const selectedFeeds = new Map(
      baseline.deals.map((deal) => [deal.key, "snapp:market_party"])
    );
    const productKeys = new Set(baselineProductKeys);
    const vendorIds = new Set(baselineVendorIds);
    const reports: CampaignReport[] = [];
    const conflictingOffers = new Set<string>();
    for (const plan of plans) {
      const report: CampaignReport = {
        vendorId: plan.vendorId,
        vendorCode: plan.vendorCode,
        collectionId: plan.collectionId,
        ...(plan.source ? { source: plan.source } : {}),
        reportedCount: plan.first.count,
        rawCount: 0,
        uniqueCount: 0,
        duplicateCount: 0,
        pageSizes: [],
        terminal: false,
        coverage: "incomplete",
        qualifying: 0,
        overlap: 0,
        additional: 0,
        excluded: {},
      };
      const rows = new Map<
        string,
        | { state: "accepted"; signature: string; offer: Offer | null }
        | { state: "quarantined" }
      >();
      const conflictingIdentities = new Set<string>();
      const fingerprints = new Set<string>();
      for (let page = 0; ; page++) {
        let observedAt = plan.firstObservedAt ?? new Date().toISOString();
        const data =
          page === 0
            ? plan.first
            : yield* read(collectionUrl(plan, page, location)).pipe(
                Effect.flatMap((response) => {
                  observedAt = response.observedAt ?? new Date().toISOString();
                  return Effect.try({
                    try: () =>
                      parseScopePage(response.body, plan, plan.first.count),
                    catch: (error) =>
                      error instanceof CollectorError ? error : changed("page"),
                  });
                })
              );
        if (data.count !== report.reportedCount)
          return yield* Effect.fail(incomplete("data.count drift"));
        const count = data.finalResult.length;
        report.pageSizes.push(count);
        if (count === 0) {
          if (report.rawCount !== report.reportedCount)
            return yield* Effect.fail(
              incomplete("empty terminal before reported count")
            );
          report.terminal = true;
          if (conflictingIdentities.size === 0) report.coverage = "complete";
          break;
        }
        if (count > 100)
          return yield* Effect.fail(incomplete("page_size=100 not honored"));
        if (plan.expectedPageSize && count > plan.expectedPageSize)
          return yield* Effect.fail(incomplete("category page size changed"));
        const fingerprint = JSON.stringify(
          data.finalResult
            .map((row) => [row.data.id, row.data.vendor_id])
            .sort()
        );
        if (fingerprints.has(fingerprint))
          return yield* Effect.fail(incomplete("replayed page"));
        fingerprints.add(fingerprint);
        report.rawCount += count;
        if (report.rawCount > report.reportedCount)
          return yield* Effect.fail(incomplete("rows exceed reported count"));
        for (const entry of data.finalResult) {
          const parsed = productSchema.safeParse(entry.data);
          if (!parsed.success)
            return yield* Effect.fail(
              changed(
                "product: " +
                  parsed.error.issues
                    .map((issue) => issue.path.join("."))
                    .join(",")
              )
            );
          // This route uses null for undiscounted rows. A zero discount amount
          // establishes zero percent; a missing ratio on a positive benefit is
          // unknown and must never be promoted into threshold coverage.
          if (parsed.data.discountRatio === null && parsed.data.discount > 0)
            return yield* Effect.fail(
              changed("discountRatio is null for a positive discount")
            );
          const p: z.infer<typeof productSchema> & { discountRatio: number } = {
            ...parsed.data,
            discountRatio: parsed.data.discountRatio ?? 0,
          };
          if (p.vendor_id !== plan.vendorId)
            return yield* Effect.fail(changed("vendor_id ownership"));
          if (p.document_id !== `${p.id}-${plan.vendorId}`)
            return yield* Effect.fail(changed("document_id ownership"));
          if (p.vendor_code !== undefined && p.vendor_code !== plan.vendorCode)
            return yield* Effect.fail(changed("vendor_code ownership"));
          if (p.vendorCode !== undefined && p.vendorCode !== plan.vendorCode)
            return yield* Effect.fail(changed("vendorCode ownership"));
          // If a future response also carries nested ownership, never trust two
          // conflicting identities just because the route was store-specific.
          const nested = p.vendor as
            { id?: unknown; code?: unknown } | undefined;
          if (
            nested &&
            ((nested.id !== undefined && nested.id !== plan.vendorId) ||
              (nested.code !== undefined && nested.code !== plan.vendorCode))
          )
            return yield* Effect.fail(
              changed("vendor.id / vendor.code ownership")
            );
          if (
            plan.source === "discounted_category" &&
            p.root_category_id !== undefined &&
            p.root_category_id !== plan.collectionId
          )
            return yield* Effect.fail(changed("category product ownership"));
          if (p.sub_vendor_id != null)
            return yield* Effect.fail(
              changed("sub_vendor_id ownership is unverified")
            );
          if (
            p.discount > p.price ||
            Math.abs(p.discountRatio - (p.discount / p.price) * 100) > 1
          )
            return yield* Effect.fail(
              changed("price / discount / discountRatio agreement")
            );
          const key = `${plan.vendorId}:${p.id}`;
          const signature = JSON.stringify([
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
          const prior = rows.get(key);
          if (prior) {
            if (prior.state === "quarantined") continue;
            if (prior.signature !== signature) {
              rows.set(key, { state: "quarantined" });
              conflictingIdentities.add(key);
              report.coverage = "incomplete";
              report.partialReason = "CONFLICTING_DUPLICATES";
              report.excluded.CONFLICTING_DUPLICATE =
                conflictingIdentities.size;
              continue;
            }
            report.duplicateCount++;
            continue;
          }
          const reason = campaignExclusionReason(p, location.threshold);
          const offer: Offer | null = reason
            ? null
            : {
                key,
                productVariationId: String(p.id),
                vendorId: String(plan.vendorId),
                title: p.title,
                image: p.images?.[0]?.main ?? null,
                vendorTitle: plan.title,
                vendorCode: plan.vendorCode,
                categoryTitle: p.menu_category_title ?? null,
                priceRials: p.price,
                discountRials: p.discount,
                finalPriceRials: p.price - p.discount,
                discountRatio: p.discountRatio,
                stock: p.stock!,
                benefit: {
                  kind: "standard_discount",
                  identity: "ordinary",
                  applicable: true,
                  terms: null,
                },
                observedAt,
                observationPriority: 50,
                provenance: [
                  `snapp:${plan.source ?? "store_campaign"}:${plan.vendorId}:${plan.collectionId}`,
                ],
              };
          if (reason)
            report.excluded[reason] = (report.excluded[reason] ?? 0) + 1;
          rows.set(key, { state: "accepted", signature, offer });
          productKeys.add(key);
        }
      }
      report.uniqueCount = rows.size;
      const baselineKeys = new Set(baseline.deals.map((offer) => offer.key));
      for (const [key, row] of rows) {
        if (row.state !== "accepted") continue;
        const { offer } = row;
        if (!offer) continue;
        report.qualifying++;
        if (baselineKeys.has(key)) report.overlap++;
        else if (!offers.has(key)) report.additional++;
        const prior = offers.get(key);
        if (
          prior &&
          (prior.priceRials !== offer.priceRials ||
            prior.discountRials !== offer.discountRials ||
            prior.finalPriceRials !== offer.finalPriceRials ||
            prior.discountRatio !== offer.discountRatio)
        )
          conflictingOffers.add(key);
        const sources = [
          ...new Set([...(prior?.provenance ?? []), ...offer.provenance!]),
        ].sort();
        const order = prior
          ? Date.parse(offer.observedAt!) -
              (prior.observedAt ? Date.parse(prior.observedAt) : 0) ||
            (offer.observationPriority ?? 0) -
              (prior.observationPriority ?? 0) ||
            ((selectedFeeds.get(key) ?? "") < offer.provenance![0]!
              ? -1
              : (selectedFeeds.get(key) ?? "") > offer.provenance![0]!
                ? 1
                : 0)
          : 1;
        if (order > 0) selectedFeeds.set(key, offer.provenance![0]!);
        // All money/stock fields come from one latest observation; ties are
        // settled by stable priority/feed identity, never stage iteration order.
        offers.set(
          key,
          prior
            ? {
                ...(order > 0 ? offer : prior),
                provenance: sources,
              }
            : {
                ...offer,
                provenance: offer.provenance!,
                observedAt: offer.observedAt!,
              }
        );
      }
      vendorIds.add(String(plan.vendorId));
      reports.push(report);
    }
    return {
      vendorCount: vendorIds.size,
      productCount: productKeys.size,
      deals: [...offers.values()],
      coverage: reports.some((report) => report.coverage === "incomplete")
        ? ("incomplete" as const)
        : ("complete" as const),
      campaignResearch: {
        baselineEligible: baseline.deals.length,
        enrichedEligible: offers.size,
        reports,
        omitted,
        conflictingOfferCount: conflictingOffers.size,
        conflictingOfferIdentities: [...conflictingOffers].sort().slice(0, 100),
      },
    };
  });
}
