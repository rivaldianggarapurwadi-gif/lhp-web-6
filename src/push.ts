import webpush from "web-push";
import type { Pool } from "pg";
import { config } from "./config.js";

/**
 * Additive, not load-bearing: everything here is a no-op when VAPID keys
 * aren't configured, so local dev (and any deploy that hasn't set them up
 * yet) just runs without push rather than crashing. See server.ts for the
 * startup warning.
 */
const enabled = Boolean(config.vapidPublicKey && config.vapidPrivateKey);
if (enabled) {
  webpush.setVapidDetails(config.vapidSubject, config.vapidPublicKey!, config.vapidPrivateKey!);
}

export interface PushPayload {
  title: string;
  body: string;
  conversationId?: string;
}

export async function saveSubscription(
  pool: Pool,
  userId: string,
  sub: { endpoint: string; keys: { p256dh: string; auth: string } }
): Promise<void> {
  await pool.query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = $1, p256dh = $3, auth = $4`,
    [userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth]
  );
}

export async function removeSubscription(pool: Pool, userId: string, endpoint: string): Promise<void> {
  await pool.query(`DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2`, [
    userId,
    endpoint,
  ]);
}

/**
 * Sends to every subscription this user has (multiple devices/browsers are
 * normal). A 404/410 from the push service means the browser dropped the
 * subscription on its end -- expired or unsubscribed -- so that row gets
 * deleted instead of retried forever. Any other failure (network blip, a
 * transient 5xx from the push service) is logged and left alone; the next
 * message will just try again.
 */
export async function sendPushToUser(pool: Pool, userId: string, payload: PushPayload): Promise<void> {
  if (!enabled) return;

  const { rows } = await pool.query<{ endpoint: string; p256dh: string; auth: string }>(
    `SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1`,
    [userId]
  );
  if (rows.length === 0) return;

  await Promise.all(
    rows.map(async (row) => {
      const subscription = { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } };
      try {
        await webpush.sendNotification(subscription, JSON.stringify(payload));
      } catch (err: any) {
        if (err?.statusCode === 404 || err?.statusCode === 410) {
          await removeSubscription(pool, userId, row.endpoint);
        } else {
          console.error("[push] send failed", err?.statusCode, err?.message);
        }
      }
    })
  );
}
