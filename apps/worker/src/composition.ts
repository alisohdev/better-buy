import { Context, Effect } from "effect";
import { API_ERROR_MESSAGES } from "@better-buy/shared";
import {
  ProviderAccess,
  ProviderCollection,
  ScanPersistence,
  type ScanInput,
} from "./application/scans";
import { PersistenceError, ScanValidationError } from "./domain/failures";
import { collectDeals } from "./providers/snapp/collector";
import { collectOkala } from "./providers/okala/collector";
import { Store } from "./store";

// One call per authenticated request. Nothing tenant-bound lives in a shared layer.
export function scanServices(
  db: D1Database,
  userId: string,
  boxKey: string,
  storeCampaignsEnabled = false,
  sharedOkalaOffersEnabled = false
) {
  const store = new Store(db, userId, boxKey);
  const persisted = <A>(operation: string, run: () => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: () => new PersistenceError(operation),
    });
  const persistence = ScanPersistence.of({
    location: (id) => persisted("location", () => store.location(id)),
    active: () => persisted("active", () => store.activeScan()),
    reserve: (input: ScanInput, location) =>
      Effect.tryPromise({
        try: () =>
          store.createScan(
            input.locationId,
            input.threshold,
            input.source,
            input.mode,
            location,
            input.requestedThreshold
          ),
        catch: (error) =>
          error instanceof ScanValidationError
            ? error
            : error instanceof Error &&
                /scans_one_active_per_user|UNIQUE constraint failed: scans\.user_id/i.test(
                  error.message
                )
              ? new ScanValidationError(
                  "SCAN_IN_PROGRESS",
                  API_ERROR_MESSAGES.SCAN_IN_PROGRESS
                )
              : new PersistenceError("reserve"),
      }),
    running: (id) =>
      persisted("running", () => store.markRunning(id)).pipe(
        Effect.uninterruptible
      ),
    progress: (id, counts) =>
      persisted("progress", () => store.progress(id, counts)).pipe(
        Effect.uninterruptible
      ),
    succeed: (id, result) =>
      persisted("succeed", () => store.succeed(id, result, result.deals)).pipe(
        Effect.uninterruptible
      ),
    fail: (id, code, message) =>
      persisted("fail", () => store.fail(id, code, message)).pipe(
        Effect.uninterruptible
      ),
  });
  const access = ProviderAccess.of({ establish: () => Effect.succeed(null) });
  const collection = ProviderCollection.of({
    collect: (job, onProgress) => {
      const input = {
        latitude: job.location.latitude,
        longitude: job.location.longitude,
        threshold: job.threshold,
        onProgress,
      };
      if (job.source === "snappmarket")
        return collectDeals({
          ...input,
          storeCampaigns: storeCampaignsEnabled,
          onManifest: (scopes) =>
            persisted("manifest", () =>
              store.freezeSnappManifest(job.id, scopes)
            ).pipe(Effect.uninterruptible),
        }).pipe(
          Effect.tap((result) =>
            Effect.sync(() => {
              if ("campaignResearch" in result)
                console.info("Snapp store campaign comparison", {
                  scanId: job.id,
                  diagnostics: result.campaignResearch,
                });
            })
          )
        );
      if (job.source === "okala")
        return collectOkala({
          ...input,
          db,
          scanId: job.id,
          sharedOffersEnabled: sharedOkalaOffersEnabled,
          onManifest: (collectionIds, storeIds) =>
            persisted("manifest", () =>
              store.freezeOkalaManifest(job.id, collectionIds, storeIds)
            ).pipe(Effect.uninterruptible),
        });
      return Effect.fail(
        new ScanValidationError(
          "PROVIDER_UNAVAILABLE",
          API_ERROR_MESSAGES.PROVIDER_UNAVAILABLE
        )
      );
    },
  });
  return Context.make(ScanPersistence, persistence).pipe(
    Context.add(ProviderAccess, access),
    Context.add(ProviderCollection, collection)
  );
}
