import type { AuthEnv } from "../auth";
import type { ScanEngine } from "../durable/types";
import type { Hono } from "hono";
export type WorkerEnv = AuthEnv & {
  BOX_KEY: string;
  GEOCODER_BASE_URL?: string;
  CORS_ORIGIN?: string;
  DEV_MODE?: string;
  SNAPP_STORE_CAMPAIGNS_ENABLED?: string;
  SCAN_WORKFLOW_ENABLED?: string;
  OKALA_SHARED_OFFERS_ENABLED?: string;
  SCAN_WORKFLOW_CONCURRENCY?: string;
  API_RATE_LIMITS_ENABLED?: string;
  WISHLIST_SCHEDULE_ENABLED?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  STORAGE_KIND?: "d1" | "sqlite";
  SCAN_ENGINE?: ScanEngine;
  SCAN_WORKFLOW?: Workflow<{ scanId: string; contractVersion: 1 }>;
  ASSETS: Fetcher;
};
export type Variables = { userId: string };

export type Api = Hono<{ Bindings: WorkerEnv; Variables: Variables }>;
