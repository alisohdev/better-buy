import type { WorkerEnv } from "../src/http/types";
import { asD1Database, SqliteD1Database } from "./sqlite-d1";
import type { VpsConfig } from "./config";
import { SqliteScanEngine } from "./scan-engine";

export function createWorkerEnv(
  config: VpsConfig,
  database: SqliteD1Database
): WorkerEnv {
  return {
    DB: asD1Database(database),
    BETTER_AUTH_URL: config.betterAuthUrl,
    BETTER_AUTH_SECRET: config.betterAuthSecret,
    GOOGLE_CLIENT_ID: config.googleClientId,
    GOOGLE_CLIENT_SECRET: config.googleClientSecret,
    APP_ORIGIN: config.appOrigin,
    CORS_ORIGIN: config.corsOrigin,
    BOX_KEY: config.boxKey,
    DEV_MODE: "false",
    SCAN_WORKFLOW_ENABLED: "true",
    SCAN_WORKFLOW_CONCURRENCY: "1",
    SNAPP_STORE_CAMPAIGNS_ENABLED: config.snappStoreCampaignsEnabled,
    OKALA_SHARED_OFFERS_ENABLED: config.okalaSharedOffersEnabled,
    WISHLIST_SCHEDULE_ENABLED: config.wishlistScheduleEnabled,
    API_RATE_LIMITS_ENABLED: config.apiRateLimitsEnabled,
    GEOCODER_BASE_URL: config.geocoderBaseUrl,
    VAPID_PUBLIC_KEY: config.vapidPublicKey,
    VAPID_PRIVATE_KEY: config.vapidPrivateKey,
    VAPID_SUBJECT: config.vapidSubject,
    STORAGE_KIND: "sqlite",
    SCAN_ENGINE: new SqliteScanEngine(database.native),
    ASSETS: {
      fetch: async () => new Response(null, { status: 404 }),
    } as unknown as Fetcher,
  };
}
