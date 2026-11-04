import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sourceDirectory = fileURLToPath(new URL(".", import.meta.url));

export type VpsConfig = {
  databasePath: string;
  host: string;
  port: number;
  betterAuthUrl: string;
  appOrigin: string;
  corsOrigin: string;
  betterAuthSecret: string;
  boxKey: string;
  googleClientId: string;
  googleClientSecret: string;
  snappStoreCampaignsEnabled: string;
  okalaSharedOffersEnabled: string;
  wishlistScheduleEnabled: string;
  apiRateLimitsEnabled: string;
  geocoderBaseUrl?: string;
  vapidPublicKey?: string;
  vapidPrivateKey?: string;
  vapidSubject?: string;
};

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function databasePath() {
  return (
    process.env.VPS_DATABASE_PATH ??
    resolve(sourceDirectory, "../../../.data/better-buy-vps.sqlite")
  );
}

export function loadVpsConfig(): VpsConfig {
  const betterAuthUrl = process.env.BETTER_AUTH_URL ?? "https://better-buy.ir";
  const appOrigin = process.env.APP_ORIGIN ?? betterAuthUrl;
  return {
    databasePath: databasePath(),
    host: process.env.VPS_HTTP_HOST ?? "127.0.0.1",
    port: Number.parseInt(process.env.VPS_HTTP_PORT ?? "8787", 10),
    betterAuthUrl,
    appOrigin,
    corsOrigin: process.env.CORS_ORIGIN ?? appOrigin,
    betterAuthSecret: required("BETTER_AUTH_SECRET"),
    boxKey: required("BOX_KEY"),
    googleClientId: required("GOOGLE_CLIENT_ID"),
    googleClientSecret: required("GOOGLE_CLIENT_SECRET"),
    snappStoreCampaignsEnabled:
      process.env.SNAPP_STORE_CAMPAIGNS_ENABLED ?? "false",
    okalaSharedOffersEnabled:
      process.env.OKALA_SHARED_OFFERS_ENABLED ?? "false",
    wishlistScheduleEnabled: process.env.WISHLIST_SCHEDULE_ENABLED ?? "true",
    apiRateLimitsEnabled: process.env.API_RATE_LIMITS_ENABLED ?? "true",
    geocoderBaseUrl: process.env.GEOCODER_BASE_URL,
    vapidPublicKey: process.env.VAPID_PUBLIC_KEY,
    vapidPrivateKey: process.env.VAPID_PRIVATE_KEY,
    vapidSubject: process.env.VAPID_SUBJECT,
  };
}
