import {
  compareDeals,
  groupDealsV2,
  normalizeDealGroupText,
  identityDigest,
  offerFactsSchema,
  productSummarySchema,
  productGroupSchema,
  type DealRecord,
  type DealGroupRecord,
  type ProductPage,
  type OfferPage,
  type ProductSummary,
  type ScanRecord,
} from "@better-buy/shared";
import { z } from "zod";
import { Store } from "./store";
import { wishlistMatchSql } from "./wishlist-matching";

export class SavedProductsError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 404 | 409 | 503
  ) {
    super(code);
  }
}
type Baseline = { scanId: string | null; reason: string };
type Projection = {
  ready: number;
  cursor_product_id: string;
  baseline_scan_id: string | null;
  baseline_reason: string;
  observed_at: string;
};
type RawOffer = {
  deal_key: string;
  product_variation_id: string;
  vendor_id: string;
  title: string;
  image: string | null;
  vendor_title: string;
  vendor_code: string | null;
  category_title: string | null;
  price_rials: number;
  discount_rials: number;
  final_price_rials: number;
  discount_ratio: number;
  stock: number;
  facts_json: string | null;
  scan_id: string;
};
const CHUNK_PRODUCTS = 100;
const MAX_CHUNK_OFFERS = 5000;
export const normalizeProductSearch = (text: string) =>
  (normalizeDealGroupText(text) ?? "")
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 1776))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 1632))
    .toLocaleLowerCase("en");
const rawOffer = (r: RawOffer): Omit<DealRecord, "scanId" | "state"> => ({
  ...(r.facts_json ? offerFactsSchema.parse(JSON.parse(r.facts_json)) : {}),
  key: r.deal_key,
  productVariationId: r.product_variation_id,
  vendorId: r.vendor_id,
  title: r.title,
  image: r.image,
  vendorTitle: r.vendor_title,
  vendorCode: r.vendor_code,
  categoryTitle: r.category_title,
  priceRials: r.price_rials,
  discountRials: r.discount_rials,
  finalPriceRials: r.final_price_rials,
  discountRatio: r.discount_ratio,
  stock: r.stock,
});
async function baselineFor(
  db: D1Database,
  userId: string,
  scan: ScanRecord
): Promise<Baseline> {
  if (!scan.context) return { scanId: null, reason: "legacy_unverified" };
  if (scan.status === "succeeded" && scan.context.coverage !== "complete")
    return { scanId: null, reason: "incomplete_coverage" };
  const { context: c } = scan;
  const previous = await db
    .prepare(
      `SELECT s.id FROM scans s WHERE s.user_id=? AND s.location_id=? AND s.threshold=? AND s.source=? AND s.status='succeeded'
    AND json_extract(s.context_json,'$.coverage')='complete' AND json_extract(s.context_json,'$.scopeHash')=?
    AND json_extract(s.context_json,'$.location.revision')=? AND json_extract(s.context_json,'$.location.latitude')=?
    AND json_extract(s.context_json,'$.location.longitude')=? AND json_extract(s.context_json,'$.eligibilityVersion')=?
    AND json_extract(s.context_json,'$.offerKeyVersion')=? AND (s.created_at<? OR (s.created_at=? AND s.id<?))
    ORDER BY s.created_at DESC,s.id DESC LIMIT 1`
    )
    .bind(
      userId,
      scan.locationId,
      scan.threshold,
      scan.source,
      c.scopeHash,
      c.location.revision,
      c.location.latitude,
      c.location.longitude,
      c.eligibilityVersion,
      c.offerKeyVersion,
      scan.createdAt,
      scan.createdAt,
      scan.id
    )
    .first<{ id: string }>();
  return {
    scanId: previous?.id ?? null,
    reason: previous ? "comparable" : "no_comparable_baseline",
  };
}
async function projection(db: D1Database, userId: string, scanId: string) {
  return db
    .prepare(
      "SELECT * FROM product_projection_scans WHERE user_id=? AND scan_id=? AND version=2"
    )
    .bind(userId, scanId)
    .first<Projection>();
}
async function initialize(db: D1Database, userId: string, scan: ScanRecord) {
  const existing = await projection(db, userId, scan.id);
  if (existing) return existing;
  const baseline = await baselineFor(db, userId, scan);
  await db
    .prepare(
      `INSERT OR IGNORE INTO product_projection_scans(user_id,scan_id,baseline_scan_id,baseline_reason,observed_at)
    SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM scans WHERE user_id=? AND id=? AND status IN ('queued','running','succeeded'))`
    )
    .bind(
      userId,
      scan.id,
      baseline.scanId,
      baseline.reason,
      scan.status === "succeeded"
        ? (scan.finishedAt ?? scan.createdAt)
        : new Date().toISOString(),
      userId,
      scan.id
    )
    .run();
  const created = await projection(db, userId, scan.id);
  if (!created) throw new SavedProductsError("SCAN_NOT_PUBLISHED", 409);
  return created;
}
function summaryOf(group: DealGroupRecord): ProductSummary {
  const { vendors, conditionalOffers, ...summary } = group;
  return productSummarySchema.parse({
    ...summary,
    conditionalOfferCount: conditionalOffers?.length ?? 0,
  });
}
function chunkJson<T>(rows: T[]): string[] {
  // Keep one D1 JSON bind bounded, including pathological provider text.
  const parts: string[] = [];
  let part: T[] = [],
    bytes = 2;
  for (const row of rows) {
    const size = new TextEncoder().encode(JSON.stringify(row)).length + 1;
    if (size > 500_000)
      throw new SavedProductsError("PROJECTION_ROW_TOO_LARGE", 503);
    if (part.length && (part.length >= 100 || bytes + size > 500_000)) {
      parts.push(JSON.stringify(part));
      part = [];
      bytes = 2;
    }
    part.push(row);
    bytes += size;
  }
  if (part.length) parts.push(JSON.stringify(part));
  return parts;
}
async function projectChunk(
  db: D1Database,
  userId: string,
  scan: ScanRecord
): Promise<boolean> {
  const p = await initialize(db, userId, scan);
  if (p.ready) return true;
  const sources = [
    scan.id,
    ...(p.baseline_scan_id ? [p.baseline_scan_id] : []),
  ];
  const ids = (
    await db
      .prepare(
        `SELECT DISTINCT product_variation_id FROM deals
    WHERE scan_id IN (SELECT value FROM json_each(?)) AND product_variation_id>? ORDER BY product_variation_id LIMIT ?`
      )
      .bind(JSON.stringify(sources), p.cursor_product_id, CHUNK_PRODUCTS + 1)
      .all<{ product_variation_id: string }>()
  ).results;
  const selected = ids
    .slice(0, CHUNK_PRODUCTS)
    .map((r) => r.product_variation_id);
  const rows = selected.length
    ? (
        await db
          .prepare(
            `SELECT * FROM deals WHERE scan_id IN (SELECT value FROM json_each(?))
    AND product_variation_id IN (SELECT value FROM json_each(?)) ORDER BY product_variation_id,deal_key LIMIT ?`
          )
          .bind(
            JSON.stringify(sources),
            JSON.stringify(selected),
            MAX_CHUNK_OFFERS + 1
          )
          .all<RawOffer>()
      ).results
    : [];
  if (rows.length > MAX_CHUNK_OFFERS)
    throw new SavedProductsError("PROJECTION_SCOPE_TOO_LARGE", 503);
  const current = rows.filter((r) => r.scan_id === scan.id).map(rawOffer);
  const prior = rows
    .filter((r) => r.scan_id === p.baseline_scan_id)
    .map(rawOffer);
  const deals = p.baseline_scan_id
    ? compareDeals(current, prior, scan.id)
    : current.map((r) => ({
        ...r,
        scanId: scan.id,
        state: "current" as const,
      }));
  const groups = await groupDealsV2(scan.source, deals);
  const summaries = groups.map((g) => {
    const best = g.bestCurrentOffer;
    return {
      key: g.key,
      search: normalizeProductSearch(
        [g.title, g.categoryTitle, ...g.vendors.map((v) => v.vendorTitle)].join(
          " "
        )
      ),
      title: normalizeProductSearch(g.title),
      presence: best ? 0 : 1,
      ratio: -(best?.discountRatio ?? 0),
      discount: -(best?.discountRials ?? 0),
      price: best?.finalPriceRials ?? g.finalPriceRials,
      priceDesc: -(best?.finalPriceRials ?? g.finalPriceRials),
      summary: summaryOf(g),
    };
  });
  const offers = groups.flatMap((g) => [
    ...g.vendors.map((o) => ({ group: g.key, conditional: 0, offer: o })),
    ...(g.conditionalOffers ?? []).map((o) => ({
      group: g.key,
      conditional: 1,
      offer: o,
    })),
  ]);
  const statements: D1PreparedStatement[] = [];
  for (const json of chunkJson(summaries))
    statements.push(
      db
        .prepare(
          `INSERT OR REPLACE INTO saved_products
    SELECT ?,?,json_extract(value,'$.key'),json_extract(value,'$.search'),json_extract(value,'$.title'),json_extract(value,'$.presence'),
    json_extract(value,'$.ratio'),json_extract(value,'$.discount'),json_extract(value,'$.price'),json_extract(value,'$.priceDesc'),json_extract(value,'$.summary')
    FROM json_each(?) WHERE EXISTS(SELECT 1 FROM product_projection_scans p JOIN scans s ON s.id=p.scan_id AND s.user_id=p.user_id
    WHERE p.user_id=? AND p.scan_id=? AND p.ready=0 AND p.cursor_product_id=? AND s.status IN ('queued','running','succeeded'))`
        )
        .bind(userId, scan.id, json, userId, scan.id, p.cursor_product_id)
    );
  for (const json of chunkJson(offers))
    statements.push(
      db
        .prepare(
          `INSERT OR REPLACE INTO saved_product_offers
    SELECT ?,?,json_extract(value,'$.group'),json_extract(value,'$.offer.offerKey'),json_extract(value,'$.conditional'),
    CASE WHEN json_extract(value,'$.offer.state')='no_longer_present' THEN 1 ELSE 0 END,json_extract(value,'$.offer.finalPriceRials'),
    json_extract(value,'$.offer.vendorId'),json_extract(value,'$.offer') FROM json_each(?)
    WHERE EXISTS(SELECT 1 FROM product_projection_scans p JOIN scans s ON s.id=p.scan_id AND s.user_id=p.user_id
    WHERE p.user_id=? AND p.scan_id=? AND p.ready=0 AND p.cursor_product_id=? AND s.status IN ('queued','running','succeeded'))`
        )
        .bind(userId, scan.id, json, userId, scan.id, p.cursor_product_id)
    );
  statements.push(
    db
      .prepare(
        `UPDATE product_projection_scans SET cursor_product_id=?,ready=? WHERE user_id=? AND scan_id=? AND ready=0 AND cursor_product_id=?
    AND EXISTS(SELECT 1 FROM scans s WHERE s.id=product_projection_scans.scan_id AND s.user_id=product_projection_scans.user_id AND s.status IN ('queued','running','succeeded'))`
      )
      .bind(
        selected.at(-1) ?? p.cursor_product_id,
        Number(ids.length <= CHUNK_PRODUCTS),
        userId,
        scan.id,
        p.cursor_product_id
      )
  );
  await db.batch(statements);
  return !!(await projection(db, userId, scan.id))?.ready;
}
/** Called after all durable units have staged their final offers, before publish. */
export async function materializeProducts(
  db: D1Database,
  userId: string,
  scanId: string
): Promise<void> {
  for (;;) {
    const scan = await new Store(db, userId, "").scan(scanId);
    if (!scan) throw new SavedProductsError("NOT_FOUND", 404);
    if (!["queued", "running", "succeeded"].includes(scan.status))
      throw new SavedProductsError("SCAN_NOT_PUBLISHED", 409);
    if (await projectChunk(db, userId, scan)) return;
  }
}
export async function projectionReady(
  db: D1Database,
  userId: string,
  scanId: string
): Promise<boolean> {
  return !!(await projection(db, userId, scanId))?.ready;
}
const sortColumns = {
  wishlist: [
    "presence",
    "rank_ratio",
    "rank_discount",
    "rank_price",
    "group_key",
  ],
  discount: [
    "presence",
    "rank_ratio",
    "rank_discount",
    "rank_price",
    "group_key",
  ],
  price: ["presence", "rank_price", "group_key"],
  price_asc: ["presence", "rank_price", "group_key"],
  price_desc: ["presence", "rank_price_desc", "group_key"],
  title: ["presence", "title_sort", "group_key"],
} as const;
const querySchema = z.object({
  q: z.string().max(200).default(""),
  sort: z
    .enum(["wishlist", "discount", "price", "price_asc", "price_desc", "title"])
    .default("discount"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(2000).optional(),
});
const cursorSchema = z
  .object({
    v: z.literal(1),
    user: z.string(),
    scan: z.string(),
    kind: z.enum(["products", "offers"]),
    q: z.string(),
    sort: z.string(),
    group: z.string().optional(),
    wishlist: z.string().optional(),
    position: z.array(z.union([z.number().finite(), z.string()])).max(6),
  })
  .strict();
type Cursor = z.infer<typeof cursorSchema>;
function encodeCursor(c: Cursor) {
  const bytes = new TextEncoder().encode(JSON.stringify(c));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
function decodeCursor(text: string, context: Omit<Cursor, "v" | "position">) {
  try {
    const bytes = Uint8Array.from(
      atob(text.replace(/-/g, "+").replace(/_/g, "/")),
      (c) => c.charCodeAt(0)
    );
    const c = cursorSchema.parse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
          bytes
        )
      )
    );
    for (const k of [
      "user",
      "scan",
      "kind",
      "q",
      "sort",
      "group",
      "wishlist",
    ] as const)
      if (c[k] !== context[k]) throw new Error("context");
    return c.position;
  } catch {
    throw new SavedProductsError("INVALID_CURSOR", 400);
  }
}
const positionWhere = (columns: readonly string[]) =>
  `(${columns.join(",")}) > (${columns.map(() => "?").join(",")})`;
export async function publishedProjection(
  db: D1Database,
  userId: string,
  scanId: string
) {
  const scan = await new Store(db, userId, "").scan(scanId);
  if (!scan) throw new SavedProductsError("NOT_FOUND", 404);
  if (scan.status !== "succeeded")
    throw new SavedProductsError("SCAN_NOT_PUBLISHED", 409);
  for (let n = 0; n < 4; n++)
    if (await projectChunk(db, userId, scan))
      return { scan, p: (await projection(db, userId, scanId))! };
  throw new SavedProductsError("PROJECTION_PENDING", 409);
}
export async function readProductPage(
  db: D1Database,
  userId: string,
  scanId: string,
  query: Record<string, string | undefined>
): Promise<ProductPage> {
  const parsed = querySchema.safeParse(query);
  if (!parsed.success) throw new SavedProductsError("INVALID_INPUT", 400);
  const { sort, limit, cursor } = parsed.data,
    q = normalizeProductSearch(parsed.data.q);
  const wishlist = (
    await db
      .prepare(
        "SELECT id, normalized_phrase FROM wishlist_items WHERE user_id=? ORDER BY id"
      )
      .bind(userId)
      .all<{ id: string; normalized_phrase: string }>()
  ).results;
  const revision = wishlist.length ? await identityDigest(wishlist) : undefined;
  const context = {
    user: userId,
    scan: scanId,
    kind: "products" as const,
    q,
    sort,
    wishlist: revision,
  };
  const position = cursor ? decodeCursor(cursor, context) : null;
  const { scan, p } = await publishedProjection(db, userId, scanId);
  const columns =
    sort === "wishlist" && wishlist.length
      ? ["wishlist_rank", ...sortColumns[sort]]
      : [...sortColumns[sort]];
  if (
    position &&
    (position.length !== columns.length ||
      columns.some(
        (column, i) =>
          typeof position[i] !==
          (column === "group_key" || column === "title_sort"
            ? "string"
            : "number")
      ))
  )
    throw new SavedProductsError("INVALID_CURSOR", 400);
  const tokens = q.split(" ").filter(Boolean);
  const rows = (
    await db
      .prepare(
        `WITH ranked AS (SELECT *, CASE WHEN presence=0 AND ${wishlistMatchSql("title_sort")} THEN 0 ELSE 1 END wishlist_rank
    FROM saved_products WHERE user_id=? AND scan_id=?) SELECT * FROM ranked WHERE 1=1
    ${tokens.map(() => "AND instr(search_text,?)>0").join(" ")} ${position ? "AND " + positionWhere(columns) : ""}
    ORDER BY ${columns.join(",")} LIMIT ?`
      )
      .bind(userId, userId, scanId, ...tokens, ...(position ?? []), limit + 1)
      .all<Record<string, string | number>>()
  ).results;
  const page = rows.slice(0, limit),
    last = page.at(-1);
  return {
    items: page.map((r) =>
      productSummarySchema.parse(JSON.parse(String(r.summary_json)))
    ),
    nextCursor:
      rows.length > limit && last
        ? encodeCursor({
            v: 1,
            ...context,
            position: columns.map((k) => last[k]!),
          })
        : null,
    observedAt: p.observed_at,
    coverageSummary:
      scan.context?.coverage === "complete"
        ? "supported_discount_feeds"
        : "legacy_unverified",
    baseline: { scanId: p.baseline_scan_id, reason: p.baseline_reason },
  };
}
export async function readOfferPage(
  db: D1Database,
  userId: string,
  scanId: string,
  groupKey: string,
  query: Record<string, string | undefined>
): Promise<OfferPage> {
  const parsed = querySchema
    .extend({ limit: z.coerce.number().int().min(1).max(50).default(20) })
    .safeParse(query);
  if (!parsed.success) throw new SavedProductsError("INVALID_INPUT", 400);
  const { sort, limit, cursor } = parsed.data,
    q = normalizeProductSearch(parsed.data.q);
  const context = {
    user: userId,
    scan: scanId,
    kind: "offers" as const,
    q,
    sort,
    group: groupKey,
  };
  const position = cursor ? decodeCursor(cursor, context) : null;
  await publishedProjection(db, userId, scanId);
  const group = await db
    .prepare(
      "SELECT group_key FROM saved_products WHERE user_id=? AND scan_id=? AND group_key=?"
    )
    .bind(userId, scanId, groupKey)
    .first();
  if (!group) throw new SavedProductsError("NOT_FOUND", 404);
  const columns = [
    "conditional",
    "presence",
    "final_price",
    "vendor_id",
    "offer_key",
  ];
  if (
    position &&
    (position.length !== 5 ||
      position.slice(0, 3).some((v) => typeof v !== "number") ||
      position.slice(3).some((v) => typeof v !== "string"))
  )
    throw new SavedProductsError("INVALID_CURSOR", 400);
  const rows = (
    await db
      .prepare(
        `SELECT * FROM saved_product_offers WHERE user_id=? AND scan_id=? AND group_key=?
    ${position ? "AND " + positionWhere(columns) : ""} ORDER BY ${columns.join(",")} LIMIT ?`
      )
      .bind(userId, scanId, groupKey, ...(position ?? []), limit + 1)
      .all<Record<string, string | number>>()
  ).results;
  const page = rows.slice(0, limit),
    last = page.at(-1);
  return {
    items: page.map((r) =>
      productGroupSchema.shape.vendors.element.parse(
        JSON.parse(String(r.offer_json))
      )
    ),
    nextCursor:
      rows.length > limit && last
        ? encodeCursor({
            v: 1,
            ...context,
            position: columns.map((k) => last[k]!),
          })
        : null,
  };
}
