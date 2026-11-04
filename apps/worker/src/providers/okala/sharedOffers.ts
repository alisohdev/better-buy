import { identityDigest } from "@better-buy/shared";
import { z } from "zod";
import { CollectorError, type CollectorCode } from "../../domain/failures";
import { offersResponse } from "./model";

const endpoint = "/carousel/v4/offers/multi-store";
const leaseMs = 10_000;
const maxPayloadBytes = 1024 * 1024;
const maxCoordinationMs = 20_000;
const maxChecksPerLease = 14;
const collectorCodes = new Set<CollectorCode>([
  "NETWORK_ERROR",
  "REQUEST_TIMEOUT",
  "RATE_LIMITED",
  "UPSTREAM_ERROR",
  "UPSTREAM_FORBIDDEN",
  "AUTH_REJECTED",
  "GUEST_AUTH_REJECTED",
  "UPSTREAM_INVALID_JSON",
  "UPSTREAM_CHANGED",
  "INCOMPLETE_PAGINATION",
  "NO_CAMPAIGNS",
  "NO_STORES",
]);
const responseSchema = offersResponse;
export type OkalaCampaignExpiry =
  | { kind: "known"; endTime: string }
  | { kind: "unknown" }
  | { kind: "unshareable" };

export function campaignExpiry(value: string | undefined): OkalaCampaignExpiry {
  if (value === undefined) return { kind: "unknown" };
  if (
    !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    return { kind: "unshareable" };
  return { kind: "known", endTime: value };
}

export type OkalaOfferObservation = {
  collection: z.infer<typeof responseSchema>;
  observedAt: string;
  reusableUntil: string;
  reused: boolean;
};
export type OkalaOfferCollection = z.infer<typeof responseSchema>;

type Loader = (onPhysicalAttempt: () => Promise<void>) => Promise<unknown>;
type Receipt = (observation: OkalaOfferObservation) => Promise<void>;

async function saveReceipt(
  db: D1Database,
  scanId: string | undefined,
  key: string,
  observation: OkalaOfferObservation
) {
  if (!scanId) return;
  await db
    .prepare(
      "INSERT INTO scan_offer_observations(scan_id,request_key,observed_at,reusable_until,reused) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM scans WHERE id=? AND status IN ('queued','running')) ON CONFLICT(scan_id,request_key) DO NOTHING"
    )
    .bind(
      scanId,
      key,
      observation.observedAt,
      observation.reusableUntil,
      observation.reused ? 1 : 0,
      scanId
    )
    .run();
}

type CacheRow = {
  state: "fetching" | "ready" | "failed" | "noncacheable";
  payload_json: string | null;
  observed_at: string | null;
  reusable_until: string | null;
  lease_until: string | null;
  fencing_token: string | null;
  failure_code: string | null;
  failure_message: string | null;
};

function validPayload(
  body: unknown,
  campaignId: number,
  storeIds: readonly number[]
) {
  const envelope = z
    .object({
      success: z.boolean().optional(),
      hasValidationError: z.boolean().optional(),
    })
    .safeParse(body);
  if (
    !envelope.success ||
    envelope.data.success === false ||
    envelope.data.hasValidationError === true
  )
    throw new CollectorError(
      "UPSTREAM_CHANGED",
      "Okala offer response was not successful"
    );
  const parsed = responseSchema.safeParse(body);
  if (!parsed.success || parsed.data.success === false)
    throw new CollectorError(
      "UPSTREAM_CHANGED",
      "Okala offer response changed"
    );
  if (parsed.data.carousel && parsed.data.carousel.id !== campaignId)
    throw new CollectorError(
      "UPSTREAM_CHANGED",
      "Okala campaign did not match"
    );
  if (parsed.data.hasNextPage || (parsed.data.totalPages ?? 1) > 1)
    throw new CollectorError(
      "INCOMPLETE_PAGINATION",
      "Okala offers are incomplete"
    );
  const allowed = new Set(storeIds);
  for (const entity of parsed.data.entities) {
    if (!allowed.has(entity.storeId))
      throw new CollectorError(
        "UPSTREAM_CHANGED",
        "Okala returned an unknown store"
      );
    for (const product of entity.products) {
      if (
        product.storeId !== entity.storeId ||
        !Number.isSafeInteger(product.price) ||
        !Number.isSafeInteger(product.okPrice) ||
        product.price <= 0 ||
        product.okPrice < 0 ||
        !Number.isFinite(product.discountPercent) ||
        Math.abs(
          product.discountPercent -
            (100 * (product.price - product.okPrice)) / product.price
        ) > 1
      )
        throw new CollectorError(
          "UPSTREAM_CHANGED",
          "Okala offer values are inconsistent"
        );
    }
  }
  return parsed.data;
}

function deadline(observedAt: string, expiry: OkalaCampaignExpiry) {
  const observation = Date.parse(observedAt);
  const ageLimit = observation + 120_000;
  if (expiry.kind === "unshareable") return null;
  const campaignLimit =
    expiry.kind === "known" ? Date.parse(expiry.endTime) - 15_000 : Infinity;
  if (!Number.isFinite(observation) || campaignLimit <= observation)
    return null;
  return new Date(Math.min(ageLimit, campaignLimit)).toISOString();
}

async function requestKey(campaignId: number, storeIds: readonly number[]) {
  return identityDigest([
    "okala-offers-contract-v1",
    "GET",
    endpoint,
    {
      accept: "application/json",
      origin: "https://www.okala.com",
      source: "okala",
      uiVersion: "2.0",
    },
    campaignId,
    [...new Set(storeIds)].sort((a, b) => a - b),
  ]);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function readOkalaOffers(input: {
  db: D1Database;
  enabled: boolean;
  campaignId: number;
  storeIds: readonly number[];
  campaignExpiry: OkalaCampaignExpiry;
  load: Loader;
  receipt?: Receipt;
  scanId?: string;
  coordinationDeadlineAt?: number;
}): Promise<OkalaOfferObservation> {
  const key = await requestKey(input.campaignId, input.storeIds);
  const coordinationDb = input.db.withSession?.("first-primary") ?? input.db;
  let latestAttemptAt: string | null = null;
  let physicalAttempts = 0;
  let joined = false;
  const waitStarted = Date.now();
  const loadAndValidate = async (onAttempt: () => void | Promise<void>) => {
    const body = await input.load(async () => {
      await onAttempt();
      latestAttemptAt = new Date().toISOString();
      physicalAttempts++;
    });
    if (!latestAttemptAt) latestAttemptAt = new Date().toISOString();
    return validPayload(body, input.campaignId, input.storeIds);
  };
  const record = async (observation: OkalaOfferObservation) => {
    await saveReceipt(input.db, input.scanId, key, observation).catch(
      () => undefined
    );
    await input.receipt?.(observation).catch(() => undefined);
  };
  const direct = async (
    bypassReason = !input.enabled
      ? "disabled"
      : input.campaignExpiry.kind === "unshareable"
        ? "ambiguous_campaign_expiry"
        : "cache_unavailable"
  ): Promise<OkalaOfferObservation> => {
    console.info("Okala offer cache bypass", {
      reason: bypassReason,
    });
    const collection = await loadAndValidate(() => {});
    const observedAt = latestAttemptAt!;
    const observation = {
      collection,
      observedAt,
      reusableUntil: deadline(observedAt, input.campaignExpiry) ?? observedAt,
      reused: false,
    };
    await record(observation);
    return observation;
  };
  if (!input.enabled || input.campaignExpiry.kind === "unshareable")
    return direct();

  const coordinationDeadlineAt =
    input.coordinationDeadlineAt ?? Date.now() + maxCoordinationMs;
  let takeoverUsed = false;
  let leaseChecks = 0;
  let leaseToken: string | null = null;
  while (Date.now() < coordinationDeadlineAt) {
    let row: CacheRow | null;
    try {
      row = await coordinationDb
        .prepare(
          "SELECT state,payload_json,observed_at,reusable_until,lease_until,fencing_token,failure_code,failure_message FROM okala_offer_cache WHERE request_key=?"
        )
        .bind(key)
        .first<CacheRow>();
    } catch {
      return direct();
    }
    const now = new Date().toISOString();
    if (
      row?.state === "ready" &&
      row.payload_json &&
      row.observed_at &&
      row.reusable_until
    ) {
      const shortened = deadline(row.observed_at, input.campaignExpiry);
      const reusableUntil =
        shortened && shortened < row.reusable_until
          ? shortened
          : row.reusable_until;
      if (Date.parse(now) < Date.parse(reusableUntil)) {
        if (reusableUntil !== row.reusable_until) {
          await coordinationDb
            .prepare(
              "UPDATE okala_offer_cache SET reusable_until=? WHERE request_key=? AND state='ready' AND reusable_until=?"
            )
            .bind(reusableUntil, key, row.reusable_until)
            .run()
            .catch(() => undefined);
        }
        try {
          const collection = validPayload(
            JSON.parse(row.payload_json),
            input.campaignId,
            input.storeIds
          );
          const observation = {
            collection,
            observedAt: row.observed_at,
            reusableUntil,
            reused: true,
          };
          await record(observation);
          console.info("Okala offer cache hit", {
            observationAgeMs: Date.now() - Date.parse(observation.observedAt),
            waitMs: Date.now() - waitStarted,
            physicalAttempts,
            joined,
          });
          return observation;
        } catch {
          await coordinationDb
            .prepare(
              "DELETE FROM okala_offer_cache WHERE request_key=? AND state='ready'"
            )
            .bind(key)
            .run()
            .catch(() => undefined);
        }
      } else {
        console.info("Okala offer cache expiry rejection", {
          observationAgeMs: Date.now() - Date.parse(row.observed_at),
        });
      }
    }
    if (
      row?.state === "failed" &&
      row.lease_until &&
      Date.parse(row.lease_until) > Date.parse(now)
    )
      throw new CollectorError(
        row.failure_code &&
          collectorCodes.has(row.failure_code as CollectorCode)
          ? (row.failure_code as CollectorCode)
          : "UPSTREAM_ERROR",
        row.failure_message ?? "Okala request failed",
        true
      );
    if (
      row?.state === "noncacheable" &&
      row.lease_until &&
      Date.parse(row.lease_until) > Date.parse(now)
    )
      return direct("temporarily_noncacheable");
    const leaseExpired =
      !row ||
      !row.lease_until ||
      Date.parse(row.lease_until) <= Date.parse(now);
    const takeover = row?.state === "fetching" && leaseExpired;
    if (leaseExpired && takeoverUsed)
      throw new CollectorError(
        "UPSTREAM_ERROR",
        "Okala shared request lease expired",
        true
      );
    if (leaseExpired && (!takeoverUsed || !row)) {
      const token = crypto.randomUUID();
      const until = new Date(Date.now() + leaseMs).toISOString();
      try {
        await coordinationDb
          .prepare(
            "INSERT INTO okala_offer_cache(request_key,state,lease_until,fencing_token,updated_at) VALUES(?,'fetching',?,?,?) ON CONFLICT(request_key) DO UPDATE SET state='fetching',payload_json=NULL,observed_at=NULL,reusable_until=NULL,lease_until=excluded.lease_until,fencing_token=excluded.fencing_token,failure_code=NULL,failure_message=NULL,updated_at=excluded.updated_at WHERE okala_offer_cache.lease_until IS NULL OR okala_offer_cache.lease_until<=?"
          )
          .bind(key, until, token, now, now)
          .run();
        const claimed = await coordinationDb
          .prepare(
            "SELECT fencing_token FROM okala_offer_cache WHERE request_key=? AND state='fetching'"
          )
          .bind(key)
          .first<{ fencing_token: string }>();
        if (claimed?.fencing_token === token) {
          takeoverUsed = true;
          console.info("Okala offer cache owner", { takeover });
          latestAttemptAt = null;
          const collection = await loadAndValidate(async () => {
            const lease = new Date(Date.now() + leaseMs).toISOString();
            await coordinationDb
              .prepare(
                "UPDATE okala_offer_cache SET lease_until=?,updated_at=? WHERE request_key=? AND state='fetching' AND fencing_token=?"
              )
              .bind(lease, new Date().toISOString(), key, token)
              .run();
          });
          const observedAt = latestAttemptAt!;
          const reusableUntil = deadline(observedAt, input.campaignExpiry);
          const payloadJson = JSON.stringify(collection);
          const size = new TextEncoder().encode(payloadJson).byteLength;
          const state =
            size <= maxPayloadBytes &&
            reusableUntil &&
            Date.now() < Date.parse(reusableUntil)
              ? "ready"
              : "noncacheable";
          const rowDeadline =
            state === "ready"
              ? reusableUntil!
              : new Date(Date.now() + 10_000).toISOString();
          if (state === "ready") {
            try {
              await coordinationDb
                .prepare(
                  "UPDATE okala_offer_cache SET state='ready',payload_json=?,observed_at=?,reusable_until=?,lease_until=NULL,updated_at=? WHERE request_key=? AND state='fetching' AND fencing_token=?"
                )
                .bind(
                  payloadJson,
                  observedAt,
                  rowDeadline,
                  new Date().toISOString(),
                  key,
                  token
                )
                .run();
            } catch {
              await coordinationDb
                .prepare(
                  "UPDATE okala_offer_cache SET state='noncacheable',payload_json=NULL,observed_at=?,reusable_until=NULL,lease_until=?,updated_at=? WHERE request_key=? AND state='fetching' AND fencing_token=?"
                )
                .bind(
                  observedAt,
                  new Date(Date.now() + 10_000).toISOString(),
                  now,
                  key,
                  token
                )
                .run()
                .catch(() => undefined);
              const observation = {
                collection,
                observedAt,
                reusableUntil: reusableUntil!,
                reused: false,
              };
              await record(observation);
              console.info("Okala offer cache noncacheable", {
                physicalAttempts,
                waitMs: Date.now() - waitStarted,
                reason: "cache_write_failed",
              });
              return observation;
            }
          } else {
            await coordinationDb
              .prepare(
                "UPDATE okala_offer_cache SET state='noncacheable',payload_json=NULL,observed_at=?,reusable_until=NULL,lease_until=?,updated_at=? WHERE request_key=? AND state='fetching' AND fencing_token=?"
              )
              .bind(observedAt, rowDeadline, now, key, token)
              .run()
              .catch(() => undefined);
          }
          const observation = {
            collection,
            observedAt,
            reusableUntil: reusableUntil ?? observedAt,
            reused: false,
          };
          await record(observation);
          console.info(
            state === "ready"
              ? "Okala offer cache published"
              : "Okala offer cache noncacheable",
            {
              physicalAttempts,
              observationAgeMs: Date.now() - Date.parse(observedAt),
              waitMs: Date.now() - waitStarted,
            }
          );
          return observation;
        }
      } catch (error) {
        if (error instanceof CollectorError) {
          await coordinationDb
            .prepare(
              "UPDATE okala_offer_cache SET state='failed',payload_json=NULL,lease_until=?,failure_code=?,failure_message=?,updated_at=? WHERE request_key=? AND state='fetching' AND fencing_token=?"
            )
            .bind(
              new Date(Date.now() + 3_000).toISOString(),
              error.code,
              error.message,
              new Date().toISOString(),
              key,
              token
            )
            .run()
            .catch(() => undefined);
          throw error;
        }
        if (physicalAttempts === 0) return direct();
        throw error;
      }
    }
    if (row?.state === "fetching" && row.lease_until) {
      joined = true;
      if (row.fencing_token !== leaseToken) {
        leaseToken = row.fencing_token;
        leaseChecks = 0;
      }
      if (leaseChecks < maxChecksPerLease) {
        leaseChecks++;
        await sleep(Math.min(1000, 350 + Math.floor(Math.random() * 350)));
      } else {
        await sleep(
          Math.max(
            1,
            Math.min(
              Date.parse(row.lease_until) - Date.now(),
              coordinationDeadlineAt - Date.now()
            )
          )
        );
        leaseToken = null;
        leaseChecks = 0;
      }
      continue;
    }
  }
  throw new CollectorError(
    "UPSTREAM_ERROR",
    "Okala shared request coordination timed out",
    true
  );
}

export async function cleanupOkalaOfferCache(db: D1Database) {
  const now = new Date().toISOString();
  return db
    .prepare(
      "DELETE FROM okala_offer_cache WHERE request_key IN (SELECT request_key FROM okala_offer_cache WHERE (reusable_until IS NOT NULL AND reusable_until<=?) OR (lease_until IS NOT NULL AND lease_until<=?) ORDER BY updated_at LIMIT 100)"
    )
    .bind(now, now)
    .run();
}
