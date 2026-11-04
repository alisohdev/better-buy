import { Cause, Context, Effect, Option } from "effect";
import {
  API_ERROR_MESSAGES,
  isWithinTehranBoundary,
  type DealRecord,
  type LocationRecord,
  type ScanRecord,
} from "@better-buy/shared";
import {
  CollectorError,
  PersistenceError,
  ScanValidationError,
  type ScanFailure,
} from "../domain/failures";

export type ScanInput = {
  locationId: string;
  source: ScanRecord["source"];
  threshold: number;
  mode: ScanRecord["mode"];
  requestedThreshold?: number;
};
export type Counts = { vendorCount: number; productCount: number };
export type Collection = Counts & {
  deals: Omit<DealRecord, "scanId" | "state">[];
  coverage?: "complete" | "incomplete";
};
export type Access = null;
export type ScanJob = ScanInput & {
  id: string;
  location: LocationRecord;
  access: Access;
};

export class ScanPersistence extends Context.Service<
  ScanPersistence,
  {
    location: (
      id: string
    ) => Effect.Effect<LocationRecord | null, PersistenceError>;
    active: () => Effect.Effect<{ id: string } | null, PersistenceError>;
    reserve: (
      input: ScanInput,
      location: LocationRecord
    ) => Effect.Effect<string, PersistenceError | ScanValidationError>;
    running: (id: string) => Effect.Effect<void, PersistenceError>;
    progress: (
      id: string,
      counts: Counts
    ) => Effect.Effect<void, PersistenceError>;
    succeed: (
      id: string,
      result: Collection
    ) => Effect.Effect<void, PersistenceError>;
    fail: (
      id: string,
      code: string,
      message: string
    ) => Effect.Effect<void, PersistenceError>;
  }
>()("better-buy/ScanPersistence") {}

export class ProviderAccess extends Context.Service<
  ProviderAccess,
  {
    establish: (
      source: ScanInput["source"]
    ) => Effect.Effect<Access, ScanFailure>;
  }
>()("better-buy/ProviderAccess") {}

export class ProviderCollection extends Context.Service<
  ProviderCollection,
  {
    collect: (
      job: ScanJob,
      progress: (counts: Counts) => Effect.Effect<void, PersistenceError>
    ) => Effect.Effect<Collection, ScanFailure>;
  }
>()("better-buy/ProviderCollection") {}

export const prepareScan = (input: ScanInput) =>
  Effect.gen(function* () {
    if (input.source === "digikalajet")
      return yield* Effect.fail(
        new ScanValidationError(
          "PROVIDER_UNAVAILABLE",
          API_ERROR_MESSAGES.PROVIDER_UNAVAILABLE
        )
      );
    const persistence = yield* ScanPersistence;
    const location = yield* persistence.location(input.locationId);
    if (!location)
      return yield* Effect.fail(
        new ScanValidationError(
          "LOCATION_NOT_FOUND",
          "موقعیت تحویل پیدا نشد.",
          404
        )
      );
    if (!isWithinTehranBoundary(location.latitude, location.longitude))
      return yield* Effect.fail(
        new ScanValidationError(
          "OUTSIDE_TEHRAN",
          API_ERROR_MESSAGES.OUTSIDE_TEHRAN,
          422
        )
      );
    if (yield* persistence.active())
      return yield* Effect.fail(
        new ScanValidationError(
          "SCAN_IN_PROGRESS",
          API_ERROR_MESSAGES.SCAN_IN_PROGRESS
        )
      );
    const access = yield* (yield* ProviderAccess).establish(input.source);
    const storedInput = {
      ...input,
      requestedThreshold: input.threshold,
      threshold:
        input.source === "okala"
          ? Math.max(30, input.threshold)
          : input.threshold,
    };
    const id = yield* persistence.reserve(storedInput, location);
    return { ...storedInput, id, location, access } satisfies ScanJob;
  });

export const executeScan = (job: ScanJob) =>
  Effect.gen(function* () {
    const persistence = yield* ScanPersistence;
    const workflow = Effect.gen(function* () {
      const result = yield* Effect.gen(function* () {
        yield* persistence.running(job.id);
        const collector = yield* ProviderCollection;
        return yield* collector.collect(job, (counts) =>
          persistence.progress(job.id, counts)
        );
      });
      // D1 has no cancellation API. Await the atomic batch even if interrupted so
      // a failure finalizer cannot race a success commit whose outcome is unknown.
      yield* persistence.succeed(job.id, result);
    });
    yield* workflow.pipe(
      Effect.catchCause((cause) => {
        const expected = Cause.findErrorOption(cause);
        const failure =
          Option.isSome(expected) && !Cause.hasDies(cause)
            ? expected.value
            : null;
        const code =
          failure?.code ??
          (Cause.hasInterrupts(cause) ? "INTERRUPTED" : "UNKNOWN_ERROR");
        const message =
          failure?.message ?? "اسکن با خطای برنامه متوقف شد؛ دوباره تلاش کنید.";
        const diagnostic = safeScanFailureDiagnostic(
          job.source,
          code,
          failure?.message
        );
        return Effect.gen(function* () {
          yield* Effect.sync(() =>
            console.error(failure ? "Scan failed" : "Scan execution defect", {
              scanId: job.id,
              source: job.source,
              code,
              ...(diagnostic ? { diagnostic } : {}),
            })
          );
          yield* persistence.fail(job.id, code, message);
        });
      })
    );
  });

function safeScanFailureDiagnostic(
  source: ScanRecord["source"],
  code: string,
  message: string | undefined
) {
  if (source !== "snappmarket" || !message) return undefined;

  for (const [prefix, category] of [
    ["Snapp campaign contract changed: ", "campaign_contract"],
    ["Snapp campaign coverage incomplete: ", "campaign_coverage"],
  ] as const) {
    if (!message.startsWith(prefix)) continue;
    const check = message.slice(prefix.length);
    if (check.startsWith("product: ")) return `${category}.product_check`;
    const normalized = check.replaceAll("[]", " list");
    return /^[A-Za-z0-9 _.\/()]{1,120}$/.test(normalized)
      ? `${category}.${normalized}`
      : `${category}.unclassified_check`;
  }

  if (code === "UPSTREAM_CHANGED") {
    if (message === "Market Party vendor_id is not a positive numeric identity")
      return "market_party.vendor_id_identity";
    if (message === "Market Party product.vendorId conflicts with vendor_id")
      return "market_party.product_vendor_mismatch";
    if (message.startsWith("ساختار پاسخ")) return "response.schema";
    if (message.startsWith("پاسخ ") && message.includes(" JSON معتبر نبود"))
      return "response.invalid_json";
    return "upstream_changed.unclassified";
  }

  return code === "INCOMPLETE_PAGINATION"
    ? "pagination.incomplete_unclassified"
    : undefined;
}
