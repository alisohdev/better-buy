import {
  buildPushPayload,
  type PushSubscription,
} from "@block65/webcrypto-web-push";
import { z } from "zod";
import { encrypt, decrypt } from "./infrastructure/credential-box";
import type { WorkerEnv } from "./http/types";

export function isPushEndpoint(value: string) {
  try {
    const url = new URL(value);
    const host = url.hostname;
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.hash &&
      (host === "fcm.googleapis.com" ||
        host === "web.push.apple.com" ||
        host === "updates.push.services.mozilla.com" ||
        host.endsWith(".push.services.mozilla.com") ||
        host.endsWith(".notify.windows.com"))
    );
  } catch {
    return false;
  }
}

const keySchema = (bytes: number) =>
  z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/)
    .refine((value) => {
      try {
        return (
          atob(value.replace(/-/g, "+").replace(/_/g, "/")).length === bytes
        );
      } catch {
        return false;
      }
    });
export const pushSubscriptionSchema = z.object({
  endpoint: z.string().max(2048).refine(isPushEndpoint),
  keys: z.object({ p256dh: keySchema(65), auth: keySchema(16) }),
});

export const pushConfigured = (env: WorkerEnv) =>
  Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT);

export async function subscriptionId(endpoint: string) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint))
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function savePushSubscription(
  env: WorkerEnv,
  userId: string,
  subscription: z.infer<typeof pushSubscriptionSchema>
) {
  const id = await subscriptionId(subscription.endpoint);
  const encrypted = await encrypt(
    JSON.stringify({ ...subscription, expirationTime: null }),
    env.BOX_KEY,
    "push:" + userId + ":" + id
  );
  const result = await env.DB.prepare(
    "INSERT INTO push_subscriptions(id,user_id,encrypted_subscription,created_at) SELECT ?,?,?,? WHERE (SELECT COUNT(*) FROM push_subscriptions WHERE user_id=?)<5 OR EXISTS(SELECT 1 FROM push_subscriptions WHERE user_id=? AND id=?) " +
      "ON CONFLICT(id) DO UPDATE SET encrypted_subscription=excluded.encrypted_subscription WHERE user_id=excluded.user_id RETURNING id"
  )
    .bind(id, userId, encrypted, new Date().toISOString(), userId, userId, id)
    .first();
  return Boolean(result);
}

export async function drainPushDeliveries(
  env: WorkerEnv,
  timestamp = Date.now(),
  fetcher: typeof fetch = fetch,
  scope?: { userId: string; scanId: string }
) {
  if (!pushConfigured(env)) return;
  const now = new Date(timestamp).toISOString();
  const query = env.DB.prepare(
    "SELECT d.notification_id,d.subscription_id,d.user_id,d.attempts,s.encrypted_subscription,n.title,n.body " +
      "FROM wishlist_push_deliveries d JOIN push_subscriptions s ON s.id=d.subscription_id AND s.user_id=d.user_id " +
      "JOIN wishlist_notifications n ON n.id=d.notification_id AND n.user_id=d.user_id " +
      "WHERE d.delivered_at IS NULL AND d.attempts<5 AND d.next_attempt_at<=? AND (d.lease_until IS NULL OR d.lease_until<=?)" +
      (scope ? " AND d.user_id=? AND n.scan_id=?" : "") +
      " ORDER BY d.next_attempt_at LIMIT 5"
  );
  const rows = (
    await (
      scope
        ? query.bind(now, now, scope.userId, scope.scanId)
        : query.bind(now, now)
    ).all<{
      notification_id: string;
      subscription_id: string;
      user_id: string;
      attempts: number;
      encrypted_subscription: string;
      title: string;
      body: string;
    }>()
  ).results;
  await Promise.all(
    rows.map(async (row) => {
      const token = crypto.randomUUID();
      const claim = await env.DB.prepare(
        "UPDATE wishlist_push_deliveries SET lease_token=?,lease_until=?,attempts=attempts+1 WHERE notification_id=? AND subscription_id=? AND delivered_at IS NULL AND attempts<5 AND (lease_until IS NULL OR lease_until<=?) RETURNING notification_id"
      )
        .bind(
          token,
          new Date(timestamp + 120_000).toISOString(),
          row.notification_id,
          row.subscription_id,
          now
        )
        .first();
      if (!claim) return;
      try {
        const subscription = JSON.parse(
          await decrypt(
            row.encrypted_subscription,
            env.BOX_KEY,
            "push:" + row.user_id + ":" + row.subscription_id
          )
        ) as PushSubscription;
        if (!isPushEndpoint(subscription.endpoint))
          throw new Error("Invalid push endpoint");
        const payload = await buildPushPayload(
          {
            data: JSON.stringify({
              id: row.notification_id,
              title: row.title,
              body: row.body.slice(0, 250),
              url: "/?notification=" + encodeURIComponent(row.notification_id),
            }),
            options: { ttl: 3600, urgency: "normal" },
          },
          subscription,
          {
            publicKey: env.VAPID_PUBLIC_KEY!,
            privateKey: env.VAPID_PRIVATE_KEY!,
            subject: env.VAPID_SUBJECT!,
          }
        );
        const response = await fetcher(subscription.endpoint, {
          ...payload,
          redirect: "error",
          signal: AbortSignal.timeout(5000),
        });
        if (response.status === 404 || response.status === 410) {
          await env.DB.prepare(
            "DELETE FROM push_subscriptions WHERE id=? AND user_id=?"
          )
            .bind(row.subscription_id, row.user_id)
            .run();
          return;
        }
        if (!response.ok) throw new Error("Push service rejected request");
        await env.DB.prepare(
          "UPDATE wishlist_push_deliveries SET delivered_at=?,lease_token=NULL,lease_until=NULL WHERE notification_id=? AND subscription_id=? AND lease_token=?"
        )
          .bind(now, row.notification_id, row.subscription_id, token)
          .run();
      } catch {
        await env.DB.prepare(
          "UPDATE wishlist_push_deliveries SET next_attempt_at=?,lease_token=NULL,lease_until=NULL WHERE notification_id=? AND subscription_id=? AND lease_token=?"
        )
          .bind(
            new Date(timestamp + 300_000 * 2 ** row.attempts).toISOString(),
            row.notification_id,
            row.subscription_id,
            token
          )
          .run();
      }
    })
  );
}
