import {
  compareDeals,
  defaultScanContext,
  identityDigest,
  scanContextSchema,
  offerFactsSchema,
} from "@better-buy/shared";
import type {
  DealRecord,
  LocationRecord,
  ScanRecord,
  ScanContext,
} from "@better-buy/shared";

import { Credentials } from "./infrastructure/credentials";
import { ScanValidationError } from "./domain/failures";
import { terminalScanArtifactStatements } from "./scan-artifacts";
const now = () => new Date().toISOString();

// Both scan reads use the same correlated execution projection.
const executionProjection = `(SELECT json_object('kind','workflow','phase',e.phase,'completedUnits',(SELECT COUNT(*) FROM scan_units u WHERE u.scan_id=s.id AND u.terminal=1),'totalUnits',(SELECT COUNT(*) FROM scan_units u WHERE u.scan_id=s.id),'completedPages',(SELECT COUNT(*) FROM scan_pages p WHERE p.scan_id=s.id AND p.complete=1),'observedRows',s.product_count,'eligibleOffers',s.deal_count,'attemptCount',e.attempt_count,'heartbeatAt',e.heartbeat_at,'deadlineAt',NULL,'dispatchState',e.dispatch_state,'cancelRequested',json(CASE WHEN e.cancel_requested=1 THEN 'true' ELSE 'false' END)) FROM scan_execution e WHERE e.scan_id=s.id AND e.execution_kind='workflow') execution_json`;

type LocationRow = {
  coordinate_revision: number;
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  is_default: number;
  created_at: string;
  updated_at: string;
};
type ScanRow = {
  observation_json?: string | null;
  execution_json?: string | null;
  context_json: string | null;
  id: string;
  location_id: string;
  location_name: string;
  threshold: number;
  source: ScanRecord["source"];
  mode: ScanRecord["mode"];
  status: ScanRecord["status"];
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  vendor_count: number;
  product_count: number;
  deal_count: number;
  error_code: string | null;
  error_message: string | null;
};
type DealRow = {
  facts_json: string | null;
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
};

export class Store {
  constructor(
    private db: D1Database,
    private userId: string,
    boxKey: string
  ) {
    this.providerAccess = new Credentials(db, userId, boxKey);
  }
  readonly providerAccess: Credentials;
  async locations(): Promise<LocationRecord[]> {
    const { results } = await this.db
      .prepare(
        "SELECT * FROM locations WHERE user_id=? ORDER BY is_default DESC, created_at"
      )
      .bind(this.userId)
      .all<LocationRow>();
    return results.map(this.mapLocation);
  }
  async location(id: string) {
    const r = await this.db
      .prepare("SELECT * FROM locations WHERE user_id=? AND id=?")
      .bind(this.userId, id)
      .first<LocationRow>();
    return r ? this.mapLocation(r) : null;
  }
  private mapLocation(r: LocationRow): LocationRecord {
    return {
      id: r.id,
      name: r.name,
      latitude: Number(r.latitude),
      longitude: Number(r.longitude),
      isDefault: !!r.is_default,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      coordinateRevision: r.coordinate_revision ?? 1,
    };
  }
  async createLocation(v: {
    name: string;
    latitude: number;
    longitude: number;
    isDefault?: boolean;
  }) {
    const id = crypto.randomUUID(),
      at = now();
    const stmts = [];
    if (v.isDefault)
      stmts.push(
        this.db
          .prepare("UPDATE locations SET is_default=0 WHERE user_id=?")
          .bind(this.userId)
      );
    stmts.push(
      this.db
        .prepare(
          "INSERT INTO locations(id,user_id,name,latitude,longitude,is_default,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)"
        )
        .bind(
          id,
          this.userId,
          v.name,
          v.latitude,
          v.longitude,
          v.isDefault ? 1 : 0,
          at,
          at
        )
    );
    await this.db.batch(stmts);
    return this.location(id);
  }
  async updateLocation(id: string, v: Record<string, unknown>) {
    const current = await this.location(id);
    if (!current) return null;
    const merged = { ...current, ...v };
    const stmts = [];
    if (merged.isDefault)
      stmts.push(
        this.db
          .prepare("UPDATE locations SET is_default=0 WHERE user_id=?")
          .bind(this.userId)
      );
    stmts.push(
      this.db
        .prepare(
          "UPDATE locations SET coordinate_revision=coordinate_revision + CASE WHEN latitude != ? OR longitude != ? THEN 1 ELSE 0 END,name=?,latitude=?,longitude=?,is_default=?,updated_at=? WHERE user_id=? AND id=?"
        )
        .bind(
          Number(merged.latitude),
          Number(merged.longitude),
          String(merged.name),
          Number(merged.latitude),
          Number(merged.longitude),
          merged.isDefault ? 1 : 0,
          now(),
          this.userId,
          id
        )
    );
    await this.db.batch(stmts);
    return this.location(id);
  }
  async deleteLocation(id: string) {
    const existing = await this.db
      .prepare("SELECT id FROM locations WHERE user_id=? AND id=?")
      .bind(this.userId, id)
      .first<{ id: string }>();
    if (!existing) return "missing";

    const count = await this.db
      .prepare("SELECT COUNT(*) AS c FROM locations WHERE user_id=?")
      .bind(this.userId)
      .first<{ c: number }>();
    if (Number(count?.c) <= 1) return "last";
    const active = await this.db
      .prepare(
        "SELECT 1 FROM scans WHERE user_id=? AND location_id=? AND status IN ('queued','running') LIMIT 1"
      )
      .bind(this.userId, id)
      .first();
    if (active) return "active";

    // A location owns its scan history. Delete dependent deals first, then
    // scans, and finally the location in one D1 batch so no history is left
    // behind when a location is removed.
    const result = await this.db.batch([
      this.db
        .prepare(
          "DELETE FROM deals WHERE scan_id IN (SELECT id FROM scans WHERE user_id=? AND location_id=?)"
        )
        .bind(this.userId, id),
      this.db
        .prepare("DELETE FROM scans WHERE user_id=? AND location_id=?")
        .bind(this.userId, id),
      this.db
        .prepare("DELETE FROM locations WHERE user_id=? AND id=?")
        .bind(this.userId, id),
    ]);
    return result[2]?.meta.changes ? "deleted" : "missing";
  }
  provider(provider: string) {
    return this.providerAccess.provider(provider);
  }
  saveProvider(...args: Parameters<Credentials["saveProvider"]>) {
    return this.providerAccess.saveProvider(...args);
  }
  credentials(provider: string) {
    return this.providerAccess.credentials(provider);
  }
  async activeScan() {
    return this.db
      .prepare(
        "SELECT id FROM scans WHERE user_id=? AND status IN ('queued','running') LIMIT 1"
      )
      .bind(this.userId)
      .first<{ id: string }>();
  }
  async reconcileStale() {
    const queuedCutoff = new Date(Date.now() - 2 * 60_000).toISOString();
    const stale = `user_id=? AND status='queued' AND created_at < ? AND NOT EXISTS(SELECT 1 FROM scan_execution e WHERE e.scan_id=scans.id AND e.execution_kind='workflow')`;
    const { results } = await this.db
      .prepare(`SELECT id FROM scans WHERE ${stale}`)
      .bind(this.userId, queuedCutoff)
      .all<{ id: string }>();
    for (const { id } of results)
      await this.db.batch([
        this.db
          .prepare(
            `UPDATE scans SET status='failed',finished_at=?,error_code='INTERRUPTED',error_message='اسکن با توقف برنامه متوقف شد' WHERE id=? AND ${stale}`
          )
          .bind(now(), id, this.userId, queuedCutoff),
        ...terminalScanArtifactStatements(this.db, id, this.userId),
      ]);
  }
  async createScan(
    locationId: string,
    threshold: number,
    source: ScanRecord["source"],
    mode: ScanRecord["mode"],
    snapshot?: LocationRecord,
    requestedThreshold = threshold
  ) {
    const id = crypto.randomUUID();
    const location = snapshot ?? (await this.location(locationId));
    if (!location)
      throw new ScanValidationError(
        "LOCATION_NOT_FOUND",
        "موقعیت تحویل پیدا نشد.",
        404
      );
    const context = await defaultScanContext(
      location,
      source,
      threshold,
      requestedThreshold
    );
    const result = await this.db
      .prepare(
        "INSERT INTO scans(id,user_id,location_id,threshold,source,mode,status,created_at,context_json) SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM locations WHERE id=? AND user_id=? AND latitude=? AND longitude=? AND coordinate_revision=? AND name=?)"
      )
      .bind(
        id,
        this.userId,
        locationId,
        threshold,
        source,
        mode,
        "queued",
        now(),
        JSON.stringify(context),
        locationId,
        this.userId,
        location.latitude,
        location.longitude,
        location.coordinateRevision ?? 1,
        location.name
      )
      .run();
    if (!result.meta.changes)
      throw new ScanValidationError(
        "LOCATION_NOT_FOUND",
        "موقعیت تحویل پیدا نشد.",
        404
      );
    return id;
  }
  async scan(id: string) {
    const r = await this.db
      .prepare(
        `SELECT s.*,l.name location_name,${executionProjection},(SELECT json_object('oldestAt',MIN(observed_at),'newestAt',MAX(observed_at),'reusedRequestCount',SUM(reused),'totalRequestCount',COUNT(*)) FROM scan_offer_observations WHERE scan_id=s.id) observation_json FROM scans s JOIN locations l ON l.id=s.location_id AND l.user_id=s.user_id WHERE s.user_id=? AND s.id=?`
      )
      .bind(this.userId, id)
      .first<ScanRow>();
    return r ? this.mapScan(r) : null;
  }
  private mapScan(r: ScanRow): ScanRecord {
    const context = r.context_json
      ? scanContextSchema.parse(JSON.parse(r.context_json))
      : null;
    return {
      ...(r.observation_json &&
      JSON.parse(r.observation_json).totalRequestCount > 0
        ? { observation: JSON.parse(r.observation_json) }
        : {}),
      ...(r.execution_json ? { execution: JSON.parse(r.execution_json) } : {}),
      context,
      id: r.id,
      locationId: r.location_id,
      locationName: context?.location.name ?? r.location_name,
      threshold: r.threshold,
      source: r.source,
      mode: r.mode,
      status: r.status,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      createdAt: r.created_at,
      vendorCount: r.vendor_count,
      productCount: r.product_count,
      dealCount: r.deal_count,
      errorCode: r.error_code,
      errorMessage: r.error_message,
    };
  }
  async scans(
    options: {
      locationId?: string;
      source?: ScanRecord["source"];
      before?: { createdAt: string; id: string };
      limit?: number;
    } = {}
  ) {
    const clauses = ["s.user_id=?"];
    const parameters: (string | number)[] = [this.userId];
    if (options.locationId) {
      clauses.push("s.location_id=?");
      parameters.push(options.locationId);
    }
    if (options.source) {
      clauses.push("s.source=?");
      parameters.push(options.source);
    }
    if (options.before) {
      clauses.push("(s.created_at < ? OR (s.created_at=? AND s.id<?))");
      parameters.push(
        options.before.createdAt,
        options.before.createdAt,
        options.before.id
      );
    }
    parameters.push(Math.min(101, Math.max(1, options.limit ?? 100)));
    const { results } = await this.db
      .prepare(
        `SELECT s.*,l.name location_name,${executionProjection},(SELECT json_object('oldestAt',MIN(observed_at),'newestAt',MAX(observed_at),'reusedRequestCount',SUM(reused),'totalRequestCount',COUNT(*)) FROM scan_offer_observations WHERE scan_id=s.id) observation_json FROM scans s JOIN locations l ON l.id=s.location_id AND l.user_id=s.user_id WHERE ${clauses.join(" AND ")} ORDER BY s.created_at DESC,s.id DESC LIMIT ?`
      )
      .bind(...parameters)
      .all<ScanRow>();
    return results.map(this.mapScan);
  }
  async markRunning(id: string) {
    await this.db
      .prepare(
        "UPDATE scans SET status='running',started_at=? WHERE user_id=? AND id=? AND status='queued'"
      )
      .bind(now(), this.userId, id)
      .run();
  }
  async freezeOkalaManifest(
    id: string,
    collectionIds: number[],
    storeIds: number[]
  ) {
    const scan = await this.scan(id);
    if (!scan?.context || scan.status !== "running")
      throw new Error("Scan is not active");
    const manifest = {
      ...scan.context.manifest,
      collectionIds: [...new Set(collectionIds)].sort((a, b) => a - b),
      storeIds: [...new Set(storeIds)].sort((a, b) => a - b),
    };
    const context = {
      ...scan.context,
      manifest,
      scopeHash: await identityDigest([
        scan.source,
        manifest,
        scan.threshold,
        scan.context.eligibilityVersion,
        scan.context.offerKeyVersion,
      ]),
    };
    const result = await this.db
      .prepare(
        "UPDATE scans SET context_json=? WHERE user_id=? AND id=? AND status='running' AND json_extract(context_json,'$.manifest.collectionIds') IS NULL"
      )
      .bind(JSON.stringify(context), this.userId, id)
      .run();
    if (!result.meta.changes) throw new Error("Manifest was already frozen");
  }
  async freezeSnappManifest(
    id: string,
    scopes: NonNullable<ScanContext["manifest"]["storeCampaigns"]>
  ) {
    if (!scopes.length) return;
    const scan = await this.scan(id);
    if (
      !scan?.context ||
      scan.status !== "running" ||
      scan.source !== "snappmarket"
    )
      throw new Error("Snapp scan is not active");
    const storeCampaigns = [
      ...new Map(
        scopes.map((scope) => [
          `${scope.source ?? "store_campaign"}:${scope.vendorId}:${scope.collectionId}`,
          scope,
        ])
      ).values(),
    ].sort(
      (a, b) =>
        a.vendorId - b.vendorId ||
        (a.source ?? "store_campaign").localeCompare(
          b.source ?? "store_campaign"
        ) ||
        a.collectionId - b.collectionId
    );
    const manifest = {
      adapter: "snapp-market-party-with-store-campaigns",
      contractVersion: 1,
      feedKinds: [
        "market_party",
        ...new Set(
          storeCampaigns.map((scope) => scope.source ?? "store_campaign")
        ),
      ],
      collectionIds: [
        ...new Set(storeCampaigns.map((scope) => scope.collectionId)),
      ].sort((a, b) => a - b),
      storeIds: [
        ...new Set(storeCampaigns.map((scope) => scope.vendorId)),
      ].sort((a, b) => a - b),
      storeCampaigns,
    };
    const context = scanContextSchema.parse({
      ...scan.context,
      manifest,
      scopeHash: await identityDigest([
        scan.source,
        manifest,
        scan.threshold,
        scan.context.eligibilityVersion,
        scan.context.offerKeyVersion,
      ]),
    });
    const result = await this.db
      .prepare(
        "UPDATE scans SET context_json=? WHERE user_id=? AND id=? AND status='running' AND json_extract(context_json,'$.manifest.storeCampaigns') IS NULL"
      )
      .bind(JSON.stringify(context), this.userId, id)
      .run();
    if (!result.meta.changes) throw new Error("Manifest was already frozen");
  }
  async progress(id: string, c: { vendorCount: number; productCount: number }) {
    await this.db
      .prepare(
        "UPDATE scans SET vendor_count=?,product_count=? WHERE user_id=? AND id=? AND status='running'"
      )
      .bind(c.vendorCount, c.productCount, this.userId, id)
      .run();
  }
  async fail(id: string, code: string, message: string) {
    await this.db.batch([
      this.db
        .prepare(
          "UPDATE scans SET status='failed',finished_at=?,error_code=?,error_message=?,context_json=CASE WHEN context_json IS NULL THEN NULL ELSE json_set(context_json,'$.coverage','incomplete') END WHERE user_id=? AND id=? AND status IN ('queued','running')"
        )
        .bind(now(), code, message, this.userId, id),
      ...terminalScanArtifactStatements(this.db, id, this.userId),
    ]);
  }
  async succeed(
    id: string,
    c: {
      vendorCount: number;
      productCount: number;
      coverage?: "complete" | "incomplete";
    },
    deals: Omit<DealRecord, "scanId" | "state">[]
  ) {
    const stmts = deals.map((d) =>
      this.db
        .prepare(
          "INSERT INTO deals(id,scan_id,deal_key,product_variation_id,vendor_id,title,image,vendor_title,vendor_code,category_title,price_rials,discount_rials,final_price_rials,discount_ratio,stock,facts_json) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM scans WHERE id=? AND user_id=? AND status IN ('queued','running'))"
        )
        .bind(
          crypto.randomUUID(),
          id,
          d.key,
          d.productVariationId,
          d.vendorId,
          d.title,
          d.image,
          d.vendorTitle,
          d.vendorCode,
          d.categoryTitle,
          d.priceRials,
          d.discountRials,
          d.finalPriceRials,
          d.discountRatio,
          d.stock,
          JSON.stringify({
            benefit: d.benefit,
            observedAt: d.observedAt,
            provenance: d.provenance,
            vendorLogoUrl: d.vendorLogoUrl ?? null,
            observationPriority: d.observationPriority,
          }),
          id,
          this.userId
        )
    );
    stmts.push(
      this.db
        .prepare(
          "UPDATE scans SET status='succeeded',finished_at=?,vendor_count=?,product_count=?,deal_count=?,context_json=CASE WHEN context_json IS NULL THEN NULL ELSE json_set(context_json,'$.coverage',?) END WHERE user_id=? AND id=? AND status IN ('queued','running')"
        )
        .bind(
          now(),
          c.vendorCount,
          c.productCount,
          deals.length,
          c.coverage ?? "complete",
          this.userId,
          id
        )
    );
    await this.db.batch(stmts);
  }
  async deals(id: string): Promise<DealRecord[]> {
    const scan = await this.scan(id);
    if (!scan || scan.status !== "succeeded") return [];
    const { results } = await this.db
      .prepare(
        "SELECT * FROM deals WHERE scan_id=? ORDER BY discount_ratio DESC, final_price_rials"
      )
      .bind(id)
      .all<DealRow>();
    const previous =
      scan.status === "succeeded" && scan.context?.coverage === "complete"
        ? await this.db
            .prepare(
              "SELECT s.id FROM scans s WHERE s.user_id=? AND s.location_id=? AND s.threshold=? AND s.source=? AND s.status='succeeded' AND json_extract(s.context_json,'$.coverage')='complete' AND json_extract(s.context_json,'$.scopeHash')=? AND json_extract(s.context_json,'$.location.revision')=? AND json_extract(s.context_json,'$.location.latitude')=? AND json_extract(s.context_json,'$.location.longitude')=? AND json_extract(s.context_json,'$.eligibilityVersion')=? AND json_extract(s.context_json,'$.offerKeyVersion')=? AND (s.created_at < ? OR (s.created_at=? AND s.id<?)) ORDER BY s.created_at DESC,s.id DESC LIMIT 1"
            )
            .bind(
              this.userId,
              scan.locationId,
              scan.threshold,
              scan.source,
              scan.context.scopeHash,
              scan.context.location.revision,
              scan.context.location.latitude,
              scan.context.location.longitude,
              scan.context.eligibilityVersion,
              scan.context.offerKeyVersion,
              scan.createdAt,
              scan.createdAt,
              scan.id
            )
            .first<{ id: string }>()
        : null;
    const priorRows = previous
      ? (
          await this.db
            .prepare("SELECT * FROM deals WHERE scan_id=?")
            .bind(previous.id)
            .all<DealRow>()
        ).results
      : [];
    const mapDeal = (r: DealRow) => ({
      ...(r.facts_json ? offerFactsSchema.parse(JSON.parse(r.facts_json)) : {}),
      title: r.title,
      image: r.image,
      key: r.deal_key,
      productVariationId: r.product_variation_id,
      vendorId: r.vendor_id,
      vendorTitle: r.vendor_title,
      vendorCode: r.vendor_code,
      categoryTitle: r.category_title,
      priceRials: r.price_rials,
      discountRials: r.discount_rials,
      finalPriceRials: r.final_price_rials,
      discountRatio: r.discount_ratio,
      stock: r.stock,
    });
    if (scan.status !== "succeeded") return [];
    return previous
      ? compareDeals(results.map(mapDeal), priorRows.map(mapDeal), id)
      : results.map((row) => ({
          ...mapDeal(row),
          scanId: id,
          state: "current" as const,
        }));
  }
}
