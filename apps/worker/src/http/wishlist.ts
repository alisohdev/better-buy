import { z } from "zod";
import { isWithinTehranBoundary } from "@better-buy/shared";
import { normalizeWishlistText, wishlistTokens } from "../wishlist-matching";
import { readWishlist, readNotifications } from "../wishlist";
import {
  pushConfigured,
  pushSubscriptionSchema,
  savePushSubscription,
  subscriptionId,
} from "../wishlist-push";
import type { Api } from "./types";
import { scanEngineFor } from "../runtime/scan-engine";

const phraseSchema = z.object({ phrase: z.string().trim().min(2).max(120) });
const locationSchema = z.object({
  locationId: z.string().min(1).max(200).nullable(),
});
export function registerWishlist(api: Api) {
  api.get("/api/wishlist", async (c) => {
    const pref = await c.env.DB.prepare(
      "SELECT p.default_location_id FROM wishlist_preferences p JOIN locations l ON l.id=p.default_location_id AND l.user_id=p.user_id WHERE p.user_id=?"
    )
      .bind(c.get("userId"))
      .first<{ default_location_id: string }>();
    return c.json({
      data: {
        items: await readWishlist(c.env.DB, c.get("userId")),
        defaultLocationId: pref?.default_location_id ?? null,
        pushPublicKey: pushConfigured(c.env) ? c.env.VAPID_PUBLIC_KEY! : null,
        scheduleEnabled:
          c.env.WISHLIST_SCHEDULE_ENABLED === "true" &&
          Boolean(scanEngineFor(c.env)),
        devScanEnabled:
          c.env.DEV_MODE === "true" && Boolean(scanEngineFor(c.env)),
      },
    });
  });
  api.post("/api/wishlist", async (c) => {
    const parsed = phraseSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        {
          error: "INVALID_INPUT",
          message: "نام کالا باید بین ۲ تا ۱۲۰ نویسه باشد.",
        },
        400
      );
    const normalized = normalizeWishlistText(parsed.data.phrase);
    if (normalized.length < 2) return c.json({ error: "INVALID_INPUT" }, 400);
    const result = await c.env.DB.prepare(
      "INSERT INTO wishlist_items(id,user_id,phrase,normalized_phrase,tokens_json,created_at) SELECT ?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM wishlist_items WHERE user_id=?)<30 OR EXISTS(SELECT 1 FROM wishlist_items WHERE user_id=? AND normalized_phrase=?) ON CONFLICT(user_id,normalized_phrase) DO UPDATE SET phrase=wishlist_items.phrase RETURNING id"
    )
      .bind(
        crypto.randomUUID(),
        c.get("userId"),
        parsed.data.phrase,
        normalized,
        JSON.stringify(wishlistTokens(normalized)),
        new Date().toISOString(),
        c.get("userId"),
        c.get("userId"),
        normalized
      )
      .first();
    if (!result)
      return c.json(
        {
          error: "WISHLIST_LIMIT",
          message: "حداکثر ۳۰ عبارت می‌توانید اضافه کنید.",
        },
        409
      );
    return c.json({ data: await readWishlist(c.env.DB, c.get("userId")) }, 201);
  });
  api.delete("/api/wishlist/:id", async (c) => {
    await c.env.DB.prepare(
      "DELETE FROM wishlist_items WHERE user_id=? AND id=?"
    )
      .bind(c.get("userId"), c.req.param("id"))
      .run();
    return c.json({ data: { ok: true } });
  });
  api.put("/api/wishlist/location", async (c) => {
    const parsed = locationSchema.safeParse(
      await c.req.json().catch(() => null)
    );
    if (!parsed.success) return c.json({ error: "INVALID_INPUT" }, 400);
    if (parsed.data.locationId) {
      const location = await c.env.DB.prepare(
        "SELECT latitude,longitude FROM locations WHERE user_id=? AND id=?"
      )
        .bind(c.get("userId"), parsed.data.locationId)
        .first<{ latitude: number; longitude: number }>();
      if (!location) return c.json({ error: "NOT_FOUND" }, 404);
      if (!isWithinTehranBoundary(location.latitude, location.longitude))
        return c.json({ error: "OUTSIDE_TEHRAN" }, 422);
    }
    await c.env.DB.prepare(
      "INSERT INTO wishlist_preferences(user_id,default_location_id,updated_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET default_location_id=excluded.default_location_id,updated_at=excluded.updated_at"
    )
      .bind(c.get("userId"), parsed.data.locationId, new Date().toISOString())
      .run();
    return c.json({ data: { defaultLocationId: parsed.data.locationId } });
  });
  api.get("/api/notifications", async (c) =>
    c.json({ data: await readNotifications(c.env.DB, c.get("userId")) })
  );
  api.post("/api/notifications/:id/read", async (c) => {
    await c.env.DB.prepare(
      "UPDATE wishlist_notifications SET read_at=COALESCE(read_at,?) WHERE user_id=? AND id=?"
    )
      .bind(new Date().toISOString(), c.get("userId"), c.req.param("id"))
      .run();
    return c.json({ data: { ok: true } });
  });
  api.post("/api/push/subscriptions", async (c) => {
    if (!pushConfigured(c.env))
      return c.json({ error: "PUSH_NOT_CONFIGURED" }, 503);
    const parsed = pushSubscriptionSchema.safeParse(
      await c.req.json().catch(() => null)
    );
    if (!parsed.success) return c.json({ error: "INVALID_SUBSCRIPTION" }, 400);
    if (!(await savePushSubscription(c.env, c.get("userId"), parsed.data)))
      return c.json(
        {
          error: "SUBSCRIPTION_LIMIT_OR_CONFLICT",
          message:
            "ثبت اعلان ممکن نشد؛ اشتراک مرورگر را غیرفعال و دوباره فعال کنید.",
        },
        409
      );
    return c.json({ data: { ok: true } }, 201);
  });
  api.delete("/api/push/subscriptions", async (c) => {
    const parsed = z
      .object({ endpoint: z.string().max(2048) })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "INVALID_INPUT" }, 400);
    await c.env.DB.prepare(
      "DELETE FROM push_subscriptions WHERE user_id=? AND id=?"
    )
      .bind(c.get("userId"), await subscriptionId(parsed.data.endpoint))
      .run();
    return c.json({ data: { ok: true } });
  });
}
