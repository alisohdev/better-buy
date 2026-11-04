import { z } from "zod";
import { DurableError } from "../durable/types";
import { scanEngineFor } from "../runtime/scan-engine";
import { reconcileDurableScan } from "../durable/service";
import { SavedProductsError } from "../saved-products";
import { notifyWishlistScan } from "../wishlist";
import { drainPushDeliveries, pushConfigured } from "../wishlist-push";
import { beginWishlistScan } from "../wishlist-scheduler";
import type { Api } from "./types";

const userId = z.string().trim().min(1).max(200);
const startInput = z.object({
  userId,
  source: z.enum(["snappmarket", "okala"]),
  key: z.string().uuid(),
  marketPartyOnly: z.boolean().default(false),
});
const statusInput = z.object({ userId, scanId: z.string().uuid() });
const browserStartInput = startInput
  .omit({ userId: true, marketPartyOnly: true })
  .strict();
const browserStatusInput = statusInput.omit({ userId: true }).strict();

export function registerDevWishlist(
  api: Api,
  access: "cli" | "session" = "cli"
) {
  const path =
    access === "session" ? "/api/wishlist/dev-scan" : "/api/dev/wishlist";
  api.post(`${path}/start`, async (c) => {
    const body = await c.req.json().catch(() => null);
    const input =
      access === "session"
        ? browserStartInput
            .transform((data) => ({
              ...data,
              userId: c.get("userId"),
              marketPartyOnly: false,
            }))
            .safeParse(body)
        : startInput.safeParse(body);
    if (!input.success) return c.json({ error: "INVALID_INPUT" }, 400);
    const engine = scanEngineFor(c.env);
    if (!engine) return c.json({ error: "DURABLE_EXECUTION_UNAVAILABLE" }, 503);
    const target = await c.env.DB.prepare(
      "SELECT l.id FROM wishlist_preferences p JOIN locations l ON l.id=p.default_location_id AND l.user_id=p.user_id WHERE p.user_id=? AND EXISTS(SELECT 1 FROM wishlist_items w WHERE w.user_id=p.user_id)"
    )
      .bind(input.data.userId)
      .first<{ id: string }>();
    if (!target) return c.json({ error: "WISHLIST_OR_LOCATION_MISSING" }, 409);
    try {
      const scan = await beginWishlistScan(
        {
          ...c.env,
          SCAN_ENGINE: engine,
          ...(input.data.marketPartyOnly && input.data.source === "snappmarket"
            ? { SNAPP_STORE_CAMPAIGNS_ENABLED: "false" }
            : {}),
        },
        {
          userId: input.data.userId,
          source: input.data.source,
          key: input.data.key,
          locationId: target.id,
        }
      );
      return c.json({ data: { scanId: scan.id, status: scan.status } }, 202);
    } catch (error) {
      if (error instanceof DurableError)
        return c.json(
          { error: error.code, message: error.message },
          error.status
        );
      console.error("Development wishlist scan could not start");
      return c.json({ error: "SCAN_START_FAILED" }, 500);
    }
  });

  api.post(`${path}/status`, async (c) => {
    const body = await c.req.json().catch(() => null);
    const input =
      access === "session"
        ? browserStatusInput
            .transform((data) => ({ ...data, userId: c.get("userId") }))
            .safeParse(body)
        : statusInput.safeParse(body);
    if (!input.success) return c.json({ error: "INVALID_INPUT" }, 400);
    const engine = scanEngineFor(c.env);
    if (!engine) return c.json({ error: "DURABLE_EXECUTION_UNAVAILABLE" }, 503);
    const scan = await reconcileDurableScan(
      { ...c.env, SCAN_ENGINE: engine },
      input.data.userId,
      input.data.scanId
    );
    if (!scan) return c.json({ error: "NOT_FOUND" }, 404);
    if (scan.status !== "succeeded")
      return c.json({
        data: {
          status: scan.status,
          errorCode: scan.errorCode,
          errorMessage: scan.errorMessage,
        },
      });
    try {
      await notifyWishlistScan(c.env.DB, input.data.userId, scan.id);
    } catch (error) {
      if (
        error instanceof SavedProductsError &&
        error.code === "PROJECTION_PENDING"
      )
        return c.json({ data: { status: "processing" } });
      console.error("Development wishlist notification processing failed", {
        scanId: scan.id,
      });
      return c.json({ error: "NOTIFICATION_PROCESSING_FAILED" }, 500);
    }
    const receipt = await c.env.DB.prepare(
      "SELECT completed FROM wishlist_scan_receipts WHERE scan_id=?"
    )
      .bind(scan.id)
      .first<{ completed: number }>();
    if (receipt?.completed !== 1)
      return c.json({ data: { status: "processing" } });
    const notification = await c.env.DB.prepare(
      "SELECT id,title,body,matches_json FROM wishlist_notifications WHERE user_id=? AND scan_id=?"
    )
      .bind(input.data.userId, scan.id)
      .first<{
        id: string;
        title: string;
        body: string;
        matches_json: string;
      }>();
    if (notification)
      await drainPushDeliveries(c.env, Date.now(), fetch, {
        userId: input.data.userId,
        scanId: scan.id,
      });
    const deliveries = notification
      ? (
          await c.env.DB.prepare(
            "SELECT delivered_at FROM wishlist_push_deliveries WHERE user_id=? AND notification_id=?"
          )
            .bind(input.data.userId, notification.id)
            .all<{ delivered_at: string | null }>()
        ).results
      : [];
    return c.json({
      data: {
        status: "succeeded",
        push: !notification
          ? "not_applicable"
          : !pushConfigured(c.env)
            ? "unconfigured"
            : !deliveries.length
              ? "no_deliveries"
              : deliveries.every((item) => item.delivered_at)
                ? "accepted"
                : "pending",
        notification: notification
          ? {
              id: notification.id,
              title: notification.title,
              body: notification.body,
              matches: JSON.parse(notification.matches_json),
            }
          : null,
      },
    });
  });
}
