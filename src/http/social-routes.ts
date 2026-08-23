import { Router } from "express";
import type { Pool } from "pg";
import type { Redis } from "ioredis";
import type { Server } from "socket.io";
import { normalizeTag, isValidTagFormat } from "../tag.js";
import { checkRateLimit } from "../rate-limit.js";
import { asyncHandler, requireAuth, ApiError } from "./middleware.js";

/** Blocked in either direction hides the target exactly like a nonexistent
 *  tag does -- a distinguishable response here would turn lookup into a
 *  block-detector. */
async function resolveVisibleTag(pool: Pool, viewerId: string, tag: string) {
  const { rows } = await pool.query<{ id: string; username: string; tag: string }>(
    `SELECT u.id, u.username, u.tag
       FROM users u
      WHERE u.tag = $1
        AND u.id <> $2
        AND u.disabled_at IS NULL
        AND NOT EXISTS (
              SELECT 1 FROM blocks b
               WHERE (b.blocker_id = $2 AND b.blocked_id = u.id)
                  OR (b.blocker_id = u.id AND b.blocked_id = $2)
            )`,
    [tag, viewerId]
  );
  return rows[0] ?? null;
}

export function createSocialRouter(pool: Pool, redis: Redis, io: Server): Router {
  const router = Router();

  router.get(
    "/users/lookup",
    requireAuth,
    asyncHandler(async (req, res) => {
      const raw = typeof req.query.tag === "string" ? req.query.tag : "";
      const tag = normalizeTag(raw);
      if (!isValidTagFormat(tag)) {
        throw new ApiError(422, "INVALID_TAG_FORMAT", "That's not a valid tag");
      }

      const { allowed, retryAfterSeconds } = await checkRateLimit(redis, `lookup:${req.auth!.userId}`, [
        { name: "burst", windowSeconds: 60, max: 10 },
        { name: "sustained", windowSeconds: 3600, max: 100 },
      ]);
      if (!allowed) {
        res.setHeader("Retry-After", String(retryAfterSeconds));
        throw new ApiError(429, "RATE_LIMITED", "Too many lookups");
      }

      const user = await resolveVisibleTag(pool, req.auth!.userId, tag);
      if (!user) throw new ApiError(404, "NOT_FOUND", "No user with that tag");
      res.json({ user });
    })
  );

  router.get(
    "/contacts",
    requireAuth,
    asyncHandler(async (req, res) => {
      const { rows } = await pool.query(
        `SELECT c.id, c.created_at, c.responded_at,
                u.id AS user_id, u.username, u.tag
           FROM contacts c
           JOIN users u ON u.id = (CASE WHEN c.requester_id = $1 THEN c.addressee_id ELSE c.requester_id END)
          WHERE c.status = 'accepted' AND (c.requester_id = $1 OR c.addressee_id = $1)
          ORDER BY c.responded_at DESC NULLS LAST`,
        [req.auth!.userId]
      );
      res.json({ contacts: rows });
    })
  );

  router.get(
    "/contacts/requests",
    requireAuth,
    asyncHandler(async (req, res) => {
      const direction = req.query.direction === "outgoing" ? "outgoing" : "incoming";
      const { rows } = await pool.query(
        direction === "incoming"
          ? `SELECT c.id, c.created_at, u.id AS user_id, u.username, u.tag
               FROM contacts c JOIN users u ON u.id = c.requester_id
              WHERE c.addressee_id = $1 AND c.status = 'pending'
              ORDER BY c.created_at DESC`
          : `SELECT c.id, c.created_at, u.id AS user_id, u.username, u.tag
               FROM contacts c JOIN users u ON u.id = c.addressee_id
              WHERE c.requester_id = $1 AND c.status = 'pending'
              ORDER BY c.created_at DESC`,
        [req.auth!.userId]
      );
      res.json({ requests: rows });
    })
  );

  router.post(
    "/contacts",
    requireAuth,
    asyncHandler(async (req, res) => {
      const me = req.auth!.userId;
      const tag = normalizeTag(String(req.body?.tag ?? ""));
      if (!isValidTagFormat(tag)) throw new ApiError(422, "INVALID_TAG_FORMAT", "That's not a valid tag");

      const target = await resolveVisibleTag(pool, me, tag);
      if (!target) throw new ApiError(404, "NOT_FOUND", "No user with that tag");

      const { rows: reverse } = await pool.query<{ id: string; status: string }>(
        `SELECT id, status FROM contacts WHERE requester_id = $1 AND addressee_id = $2`,
        [target.id, me]
      );
      if (reverse[0]?.status === "pending") {
        // They already asked us first -- accept both requests at once rather
        // than creating a second row, or two people requesting each other
        // simultaneously end up each staring at the other's pending request.
        const { rows } = await pool.query(
          `UPDATE contacts SET status = 'accepted', responded_at = now() WHERE id = $1 RETURNING *`,
          [reverse[0].id]
        );
        io.to(`user:${me}`).to(`user:${target.id}`).emit("contact:request_accepted", { contactId: rows[0].id });
        return res.json({ contact: rows[0], autoAccepted: true });
      }
      if (reverse[0]?.status === "accepted") {
        throw new ApiError(409, "ALREADY_CONTACTS", "Already contacts");
      }

      const { rows: forward } = await pool.query<{ id: string; status: string }>(
        `SELECT id, status FROM contacts WHERE requester_id = $1 AND addressee_id = $2`,
        [me, target.id]
      );
      if (forward[0]?.status === "pending") throw new ApiError(409, "REQUEST_ALREADY_SENT", "Already sent");
      if (forward[0]?.status === "accepted") throw new ApiError(409, "ALREADY_CONTACTS", "Already contacts");

      const { rows } = forward[0]
        ? await pool.query(
            `UPDATE contacts SET status = 'pending', created_at = now(), responded_at = NULL
              WHERE id = $1 RETURNING *`,
            [forward[0].id]
          )
        : await pool.query(
            `INSERT INTO contacts (requester_id, addressee_id) VALUES ($1, $2) RETURNING *`,
            [me, target.id]
          );

      io.to(`user:${target.id}`).emit("contact:request_received", { contactId: rows[0].id });
      res.status(201).json({ contact: rows[0], autoAccepted: false });
    })
  );

  router.post(
    "/contacts/:id/accept",
    requireAuth,
    asyncHandler(async (req, res) => {
      const { rows } = await pool.query(
        `UPDATE contacts SET status = 'accepted', responded_at = now()
          WHERE id = $1 AND addressee_id = $2 AND status = 'pending'
        RETURNING *`,
        [req.params.id, req.auth!.userId]
      );
      if (!rows[0]) throw new ApiError(404, "NOT_FOUND", "No such pending request");
      io.to(`user:${rows[0].requester_id}`).to(`user:${rows[0].addressee_id}`).emit(
        "contact:request_accepted",
        { contactId: rows[0].id }
      );
      res.json({ contact: rows[0] });
    })
  );

  router.post(
    "/contacts/:id/decline",
    requireAuth,
    asyncHandler(async (req, res) => {
      // Kept as a row rather than deleted, so the same pair can't be
      // re-requested in an immediate loop.
      const { rows } = await pool.query(
        `UPDATE contacts SET status = 'declined', responded_at = now()
          WHERE id = $1 AND addressee_id = $2 AND status = 'pending'
        RETURNING *`,
        [req.params.id, req.auth!.userId]
      );
      if (!rows[0]) throw new ApiError(404, "NOT_FOUND", "No such pending request");
      res.json({ contact: rows[0] });
    })
  );

  router.delete(
    "/contacts/:id",
    requireAuth,
    asyncHandler(async (req, res) => {
      const { rowCount } = await pool.query(
        `DELETE FROM contacts WHERE id = $1 AND (requester_id = $2 OR addressee_id = $2)`,
        [req.params.id, req.auth!.userId]
      );
      if (!rowCount) throw new ApiError(404, "NOT_FOUND", "No such contact");
      res.status(204).end();
    })
  );

  router.get(
    "/blocks",
    requireAuth,
    asyncHandler(async (req, res) => {
      const { rows } = await pool.query(
        `SELECT b.blocked_id AS user_id, b.created_at, u.username, u.tag
           FROM blocks b JOIN users u ON u.id = b.blocked_id
          WHERE b.blocker_id = $1
          ORDER BY b.created_at DESC`,
        [req.auth!.userId]
      );
      res.json({ blocks: rows });
    })
  );

  router.post(
    "/blocks",
    requireAuth,
    asyncHandler(async (req, res) => {
      const me = req.auth!.userId;
      const tag = normalizeTag(String(req.body?.tag ?? ""));
      if (!isValidTagFormat(tag)) throw new ApiError(422, "INVALID_TAG_FORMAT", "That's not a valid tag");

      // Blocking doesn't go through resolveVisibleTag -- you must be able to
      // block someone regardless of any block state that already exists.
      const { rows: targetRows } = await pool.query<{ id: string }>(
        `SELECT id FROM users WHERE tag = $1 AND id <> $2`,
        [tag, me]
      );
      const target = targetRows[0];
      if (!target) throw new ApiError(404, "NOT_FOUND", "No user with that tag");

      await pool.query(
        `INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [me, target.id]
      );
      res.status(201).json({ blockedUserId: target.id });
    })
  );

  router.delete(
    "/blocks/:userId",
    requireAuth,
    asyncHandler(async (req, res) => {
      const { rowCount } = await pool.query(
        `DELETE FROM blocks WHERE blocker_id = $1 AND blocked_id = $2`,
        [req.auth!.userId, req.params.userId]
      );
      if (!rowCount) throw new ApiError(404, "NOT_FOUND", "Not blocked");
      res.status(204).end();
    })
  );

  return router;
}
