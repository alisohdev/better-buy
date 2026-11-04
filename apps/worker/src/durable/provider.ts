import { Effect, Cause, Exit, Option } from "effect";
import { z } from "zod";
import { requestJson, type Fetcher } from "../infrastructure/http";
import { CollectorError } from "../domain/failures";
import { DurableError, type Steps, type Job } from "./types";
import type { DurableRepository } from "./repository";
import { readOkalaOffers } from "../providers/okala/sharedOffers";

const pwa = { client: "PWA", deviceType: "PWA", appVersion: "1.403.1" };
const headers = {
  accept: "application/json, text/plain, */*",
  origin: "https://snapp.market",
  referer: "https://snapp.market/",
  "user-agent": "Mozilla/5.0 BetterBuy/1.0",
};
const guestSchema = z.object({
  status: z.literal(true),
  data: z.object({
    access_token: z.string().min(1),
    expires_in: z.number().positive(),
  }),
});
export async function effectValue<A>(
  effect: Effect.Effect<A, CollectorError>
): Promise<A> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  const error = Cause.findErrorOption(exit.cause);
  throw Option.isSome(error)
    ? error.value
    : new DurableError("UPSTREAM_CHANGED", "Provider processing failed");
}

/** One scan-owned access session. Never returned from a Workflow step or persisted. */
export function providerReader(
  repo: DurableRepository,
  id: string,
  steps: Steps,
  fetcher: Fetcher = fetch,
  sharedOkalaOffersEnabled = false
) {
  let guest: { token: string; expiresAt: number } | undefined;
  let reservationFailure: unknown;
  const physical = async (
    url: string | URL,
    init: RequestInit,
    operation: string
  ) => {
    try {
      await repo.check(id);
      await repo.reserveAttempt(id, operation);
    } catch (error) {
      reservationFailure = error;
      throw error;
    }
    return fetcher(url, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.any([
        ...(init.signal ? [init.signal] : []),
        AbortSignal.timeout(8_000),
      ]),
    });
  };
  const attempt = async (
    url: URL,
    job: Job,
    operation: string,
    onPhysicalAttempt?: () => void
  ) => {
    const single = async (
      u: URL,
      init: RequestInit,
      onPhysicalAttempt?: () => void | Promise<void>
    ) => {
      reservationFailure = undefined;
      try {
        return await effectValue(
          requestJson(u, init, {
            fetcher: (u, i) =>
              physical(
                u as string | URL,
                i ?? {},
                `${operation}:${i?.method === "POST" ? "access" : "get"}`
              ),
            provider: job.scan.source,
            attempts: 1,
            allow401: true,
            forbiddenCode: "UPSTREAM_FORBIDDEN",
            invalidJsonCode: "UPSTREAM_INVALID_JSON",
            onPhysicalAttempt,
            allowNoContent:
              u.pathname === "/express-search/product-list/vendor",
          })
        );
      } catch (error) {
        throw reservationFailure ?? error;
      }
    };
    if (job.scan.source === "okala")
      return single(
        url,
        {
          headers: {
            accept: "application/json",
            origin: "https://www.okala.com",
            source: "okala",
            "ui-version": "2.0",
          },
        },
        onPhysicalAttempt
      );
    const acquire = async () => {
      const auth = new URL("https://svc.snapp.market/oauth2/default/token");
      Object.entries({ ...pwa, UDID: job.runtime.device_id }).forEach(
        ([k, v]) => auth.searchParams.set(k, v)
      );
      const at = Date.now();
      const result = await single(auth, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          data: {
            device_uid: job.runtime.device_id,
            client_id: "snappfood_pwa",
            client_secret: "snappfood_pwa_secret",
            grant_type: "client_credentials",
            scope: "mobile_v2 mobile_v1 webview",
          },
        }),
      });
      const parsed = guestSchema.safeParse(result.body);
      if (!parsed.success)
        throw new CollectorError(
          result.status === 401 ? "GUEST_AUTH_REJECTED" : "UPSTREAM_CHANGED",
          "Automatic access was rejected"
        );
      guest = {
        token: parsed.data.data.access_token,
        expiresAt: at + parsed.data.data.expires_in * 1000,
      };
      if (guest.expiresAt <= Date.now())
        throw new CollectorError(
          "GUEST_AUTH_REJECTED",
          "Automatic access expired"
        );
    };
    Object.entries({ ...pwa, UDID: job.runtime.device_id }).forEach(([k, v]) =>
      url.searchParams.set(k, v)
    );
    if (!guest || guest.expiresAt <= Date.now()) await acquire();
    let result = await single(
      url,
      {
        headers: { ...headers, authorization: `Bearer ${guest!.token}` },
      },
      onPhysicalAttempt
    );
    if (result.status === 401 && (await repo.claimGuestRefresh(id))) {
      await acquire();
      result = await single(
        url,
        {
          headers: { ...headers, authorization: `Bearer ${guest!.token}` },
        },
        onPhysicalAttempt
      );
    }
    if (result.status === 401)
      throw new CollectorError(
        "GUEST_AUTH_REJECTED",
        "Automatic access was rejected"
      );
    return result;
  };
  const read = async (url: URL, key: string): Promise<unknown> => {
    const saved = await repo.discovery(id, key);
    if (saved !== null) return saved;
    for (let ordinal = 0; ordinal < 3; ordinal++) {
      type ProviderAttempt =
        | { ok: true }
        | {
            ok: false;
            code: import("../domain/failures").CollectorCode;
            message: string;
            retryable: boolean;
            delay: number;
          };
      const result = await steps.do<ProviderAttempt>(
        `request:${key}:attempt:${ordinal}`,
        async () => {
          const cached = await repo.discovery(id, key);
          if (cached !== null) return { ok: true as const };
          try {
            const job = await repo.check(id);
            const response = await attempt(new URL(url), job, key);
            // JSON null means cache miss in the repository API. Preserve a 204
            // as explicit metadata so category terminals resume without refetch.
            await repo.saveDiscovery(
              id,
              key,
              response.status === 204 ? { status: 204 } : response.body
            );
            return { ok: true as const };
          } catch (error) {
            await repo.check(id);
            if (error instanceof CollectorError)
              return {
                ok: false as const,
                code: error.code,
                message: error.message,
                retryable: error.retryable,
                delay:
                  error.retryAfterMs ?? Math.min(5000, 1000 * 2 ** ordinal),
              };
            throw error;
          }
        }
      );
      if (result.ok) {
        const body = await repo.discovery(id, key);
        if (body === null)
          throw new DurableError(
            "PERSISTENCE_ERROR",
            "Committed response is missing"
          );
        return body;
      }
      if (!result.retryable || ordinal === 2)
        throw new CollectorError(result.code, result.message, false);
      await repo.check(id);
      await steps.sleep(`retry:${key}:${ordinal}`, result.delay);
    }
    throw new DurableError("UNKNOWN_ERROR", "Provider request failed");
  };
  const readOffers = async (input: {
    url: URL;
    key: string;
    campaignId: number;
    storeIds: number[];
    campaignExpiry: import("../providers/okala/sharedOffers").OkalaCampaignExpiry;
  }) => {
    const startedAt = new Date().toISOString();
    await repo.db
      .prepare(
        "INSERT OR IGNORE INTO scan_offer_coordination(scan_id,request_key,started_at) VALUES(?,?,?)"
      )
      .bind(id, input.key, startedAt)
      .run();
    const coordination = await repo.db
      .prepare(
        "SELECT started_at FROM scan_offer_coordination WHERE scan_id=? AND request_key=?"
      )
      .bind(id, input.key)
      .first<{ started_at: string }>();
    const coordinationDeadlineAt =
      Date.parse(coordination?.started_at ?? startedAt) + 20_000;
    const result = await steps.do(`shared-offers:${input.key}`, async () => {
      const existing = await repo.discovery(id, input.key);
      if (existing !== null) {
        const observedAt =
          (await repo.discoveryObservedAt(id, input.key)) ??
          (await repo.check(id)).scan.startedAt ??
          (await repo.check(id)).scan.createdAt;
        const receipt = await repo.db
          .prepare(
            "SELECT reusable_until,reused FROM scan_offer_observations WHERE scan_id=? AND request_key=?"
          )
          .bind(id, input.key)
          .first<{ reusable_until: string; reused: number }>();
        return {
          observedAt,
          reusableUntil:
            receipt?.reusable_until ??
            new Date(Date.parse(observedAt) + 120_000).toISOString(),
          reused: receipt?.reused === 1,
        };
      }
      const job = await repo.check(id);
      const observation = await readOkalaOffers({
        db: repo.db,
        enabled: sharedOkalaOffersEnabled,
        scanId: id,
        campaignId: input.campaignId,
        storeIds: input.storeIds,
        campaignExpiry: input.campaignExpiry,
        coordinationDeadlineAt,
        load: async (onPhysicalAttempt) => {
          let lastError: unknown;
          for (let ordinal = 0; ordinal < 3; ordinal++) {
            try {
              const response = await attempt(
                new URL(input.url),
                job,
                input.key,
                onPhysicalAttempt
              );
              return response.body;
            } catch (error) {
              lastError = error;
              await repo.check(id);
              if (
                !(error instanceof CollectorError) ||
                !error.retryable ||
                (error.retryAfterMs ?? 0) > 5_000 ||
                ordinal === 2
              )
                throw error;
              const delay =
                error.retryAfterMs ?? Math.min(5000, 1000 * 2 ** ordinal);
              await new Promise((resolve) => setTimeout(resolve, delay));
            }
          }
          throw lastError;
        },
      });
      await repo.saveDiscovery(
        id,
        input.key,
        observation.collection,
        observation.observedAt
      );
      return {
        observedAt: observation.observedAt,
        reusableUntil: observation.reusableUntil,
        reused: observation.reused,
      };
    });
    const collection = await repo.discovery(id, input.key);
    if (collection === null)
      throw new DurableError(
        "PERSISTENCE_ERROR",
        "Okala offer checkpoint is missing"
      );
    await repo.db
      .prepare(
        "DELETE FROM scan_offer_coordination WHERE scan_id=? AND request_key=?"
      )
      .bind(id, input.key)
      .run();
    return {
      collection:
        collection as import("../providers/okala/sharedOffers").OkalaOfferCollection,
      ...result,
    };
  };
  return Object.assign(read, {
    observedAt: (key: string) => repo.discoveryObservedAt(id, key),
    okalaOffers: readOffers,
  });
}
