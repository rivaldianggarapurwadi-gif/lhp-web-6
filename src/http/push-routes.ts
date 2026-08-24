import { Router } from "express";
import type { Pool } from "pg";
import { config } from "../config.js";
import { saveSubscription, removeSubscription } from "../push.js";
import { asyncHandler, requireAuth, ApiError } from "./middleware.js";

export function createPushRouter(pool: Pool): Router {
  const router = Router();

  // Public by design -- it's meant to be embedded in the client, same as
  // any VAPID public key. The private key never leaves the server.
  router.get(
    "/push/vapid-public-key",
    asyncHandler(async (_req, res) => {
      res.json({ publicKey: config.vapidPublicKey });
    })
  );

  router.post(
    "/push/subscribe",
    requireAuth,
    asyncHandler(async (req, res) => {
      // A subscription is a standing record tying this device to this
      // account -- exactly what a Taruna session is built never to leave.
      if (req.auth!.accountKind === "taruna") {
        throw new ApiError(403, "NOT_SUPPORTED", "Akun Taruna tidak mendukung notifikasi push");
      }
      const sub = req.body ?? {};
      if (typeof sub.endpoint !== "string" || !sub.keys?.p256dh || !sub.keys?.auth) {
        throw new ApiError(422, "INVALID_REQUEST", "Data subscription push tidak valid");
      }
      await saveSubscription(pool, req.auth!.userId, {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
      });
      res.status(204).end();
    })
  );

  router.delete(
    "/push/subscribe",
    requireAuth,
    asyncHandler(async (req, res) => {
      const endpoint = typeof req.body?.endpoint === "string" ? req.body.endpoint : "";
      if (!endpoint) throw new ApiError(422, "INVALID_REQUEST", "endpoint wajib diisi");
      await removeSubscription(pool, req.auth!.userId, endpoint);
      res.status(204).end();
    })
  );

  return router;
}
