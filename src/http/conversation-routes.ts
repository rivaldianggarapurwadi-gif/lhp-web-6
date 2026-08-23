import { Router } from "express";
import type { Pool } from "pg";
import type { Redis } from "ioredis";
import type { Server } from "socket.io";
import {
  sendMessage,
  history,
  assertParticipant,
  invalidateParticipants,
  getPendingReleaseSeq,
} from "../message-service.js";
import { localStorage, type Storage } from "../storage.js";
import { asyncHandler, requireAuth, ApiError } from "./middleware.js";

const CONVERSATION_SUMMARY_SQL = `
  SELECT cp.conversation_id AS id, c.type, c.name, c.last_seq, cp.last_read_seq,
         cp.pending_release_seq,
         GREATEST(c.last_seq - cp.last_read_seq, 0) AS unread,
         lm.id AS last_message_id, lm.content AS last_message_content,
         lm.type AS last_message_type, lm.created_at AS last_message_created_at,
         lm.sender_id AS last_message_sender_id,
         (SELECT COALESCE(array_agg(json_build_object('id', u.id, 'username', u.username, 'tag', u.tag)), '{}')
            FROM conversation_participants cp2 JOIN users u ON u.id = cp2.user_id
           WHERE cp2.conversation_id = c.id) AS participants
    FROM conversation_participants cp
    JOIN conversations c ON c.id = cp.conversation_id
    LEFT JOIN LATERAL (
      SELECT id, content, type, created_at, sender_id FROM messages m
       WHERE m.conversation_id = c.id AND m.deleted_at IS NULL
       ORDER BY m.seq DESC LIMIT 1
    ) lm ON true
`;

async function contactAndBlockCheck(pool: Pool, a: string, b: string): Promise<void> {
  const { rows: blocked } = await pool.query(
    `SELECT 1 FROM blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)`,
    [a, b]
  );
  if (blocked[0]) throw new ApiError(403, "BLOCKED", "Cannot start a conversation with this user");

  const { rows: accepted } = await pool.query(
    `SELECT 1 FROM contacts
      WHERE status = 'accepted'
        AND ((requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1))`,
    [a, b]
  );
  if (!accepted[0]) throw new ApiError(409, "NOT_CONTACTS", "Must be accepted contacts first");
}

export function createConversationRouter(
  pool: Pool,
  redis: Redis,
  io: Server,
  storage: Storage = localStorage
): Router {
  const router = Router();

  router.get(
    "/conversations",
    requireAuth,
    asyncHandler(async (req, res) => {
      const { rows } = await pool.query(
        `${CONVERSATION_SUMMARY_SQL} WHERE cp.user_id = $1 ORDER BY c.last_message_at DESC NULLS LAST`,
        [req.auth!.userId]
      );
      res.json({ conversations: rows });
    })
  );

  router.post(
    "/conversations",
    requireAuth,
    asyncHandler(async (req, res) => {
      const me = req.auth!.userId;
      const body = req.body ?? {};

      if (body.type === "dm") {
        const targetId = String(body.userId ?? "");
        if (!targetId || targetId === me) throw new ApiError(422, "INVALID_REQUEST", "userId is required");
        await contactAndBlockCheck(pool, me, targetId);

        const dmKey = [me, targetId].sort().join(":");
        const { rows: inserted } = await pool.query(
          `INSERT INTO conversations (type, dm_key, created_by) VALUES ('dm', $1, $2)
           ON CONFLICT (dm_key) WHERE type = 'dm' DO NOTHING
           RETURNING id`,
          [dmKey, me]
        );

        let conversationId: string;
        let created: boolean;
        if (inserted[0]) {
          conversationId = inserted[0].id;
          created = true;
          // Brand new conversation -- nothing exists yet to hide, so both
          // sides start with an ungated (pending_release_seq NULL) view.
          await pool.query(
            `INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1,$2), ($1,$3)`,
            [conversationId, me, targetId]
          );
          io.in(`user:${me}`).in(`user:${targetId}`).socketsJoin(`conv:${conversationId}`);
        } else {
          const { rows: existing } = await pool.query<{ id: string; last_seq: number }>(
            `SELECT id, last_seq FROM conversations WHERE dm_key = $1 AND type = 'dm'`,
            [dmKey]
          );
          conversationId = existing[0].id;
          created = false;

          // The conversation already exists, but the caller might not
          // currently be a participant of it -- e.g. a Taruna re-adding a
          // Ceko contact after their last login wiped their membership.
          // ON CONFLICT DO NOTHING makes this a no-op for the normal case
          // (already a participant); RETURNING only produces a row when a
          // genuine re-join just happened, which is exactly when there's
          // something to gate: everything already in the conversation is
          // held back as pending until POST .../request-pending releases it.
          const { rows: joined } = await pool.query(
            `INSERT INTO conversation_participants (conversation_id, user_id, pending_release_seq)
             VALUES ($1, $2, $3)
             ON CONFLICT (conversation_id, user_id) DO NOTHING
             RETURNING conversation_id`,
            [conversationId, me, existing[0].last_seq > 0 ? existing[0].last_seq : null]
          );
          if (joined[0]) {
            // The participant cache may already have been populated (e.g.
            // by an earlier send) before this INSERT happened, and would
            // otherwise keep saying the caller isn't a participant for up
            // to its 5-minute TTL.
            await invalidateParticipants(redis, conversationId);
            io.in(`user:${me}`).socketsJoin(`conv:${conversationId}`);
          }
        }

        const { rows: summary } = await pool.query(
          `${CONVERSATION_SUMMARY_SQL} WHERE c.id = $1 AND cp.user_id = $2`,
          [conversationId, me]
        );
        return res.status(created ? 201 : 200).json({ conversation: summary[0] });
      }

      if (body.type === "group") {
        const name = typeof body.name === "string" ? body.name.trim() : "";
        const userIds: string[] = Array.isArray(body.userIds)
          ? [...new Set((body.userIds as unknown[]).map(String))]
          : [];
        if (!name) throw new ApiError(422, "INVALID_REQUEST", "name is required");
        if (userIds.length === 0) throw new ApiError(422, "INVALID_REQUEST", "userIds must be non-empty");

        for (const id of userIds) {
          if (id === me) continue;
          await contactAndBlockCheck(pool, me, id);
        }

        const client = await pool.connect();
        let conversationId: string;
        try {
          await client.query("BEGIN");
          const { rows } = await client.query(
            `INSERT INTO conversations (type, name, created_by) VALUES ('group', $1, $2) RETURNING id`,
            [name, me]
          );
          conversationId = rows[0].id;
          const participantIds = [...new Set([me, ...userIds])];
          for (const id of participantIds) {
            await client.query(
              `INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2)`,
              [conversationId, id]
            );
          }
          await client.query("COMMIT");
          io.in(participantIds.map((id) => `user:${id}`)).socketsJoin(`conv:${conversationId}`);
        } catch (err) {
          await client.query("ROLLBACK").catch(() => {});
          throw err;
        } finally {
          client.release();
        }

        const { rows: summary } = await pool.query(
          `${CONVERSATION_SUMMARY_SQL} WHERE c.id = $1 AND cp.user_id = $2`,
          [conversationId, me]
        );
        return res.status(201).json({ conversation: summary[0] });
      }

      throw new ApiError(422, "INVALID_REQUEST", "type must be 'dm' or 'group'");
    })
  );

  router.get(
    "/conversations/:id/messages",
    requireAuth,
    asyncHandler(async (req, res) => {
      const conversationId = String(req.params.id);
      const me = req.auth!.userId;
      await assertParticipant(pool, redis, conversationId, me);
      const before = req.query.before ? Number(req.query.before) : null;
      const limit = req.query.limit ? Number(req.query.limit) : 50;
      const pendingReleaseSeq = await getPendingReleaseSeq(pool, conversationId, me);
      const messages = await history(pool, conversationId, before, limit, pendingReleaseSeq);
      res.json({ messages, pending: pendingReleaseSeq !== null });
    })
  );

  router.post(
    "/conversations/:id/request-pending",
    requireAuth,
    asyncHandler(async (req, res) => {
      const conversationId = String(req.params.id);
      const me = req.auth!.userId;
      await assertParticipant(pool, redis, conversationId, me);

      const { rows } = await pool.query(
        `UPDATE conversation_participants SET pending_release_seq = NULL
          WHERE conversation_id = $1 AND user_id = $2 AND pending_release_seq IS NOT NULL
        RETURNING conversation_id`,
        [conversationId, me]
      );
      if (!rows[0]) throw new ApiError(404, "NOTHING_PENDING", "No pending messages to request");

      // Lets the other side's client show a notification that its pending
      // backlog was just requested -- see index.html for how this is used.
      io.to(`conv:${conversationId}`).emit("pending:requested", { conversationId, userId: me });
      res.json({ ok: true });
    })
  );

  router.post(
    "/conversations/:id/messages",
    requireAuth,
    asyncHandler(async (req, res) => {
      const me = req.auth!.userId;
      const body = req.body ?? {};
      if (typeof body.clientMessageId !== "string") {
        throw new ApiError(422, "INVALID_REQUEST", "clientMessageId is required");
      }

      // Same invariant real S3 would give you for free: a client cannot
      // reference an attachment it never actually uploaded.
      for (const a of body.attachments ?? []) {
        const head = await storage.headObject(a.storageKey);
        if (!head.exists) {
          throw new ApiError(422, "ATTACHMENT_NOT_UPLOADED", `No such upload: ${a.storageKey}`);
        }
      }

      const message = await sendMessage(pool, redis, {
        conversationId: String(req.params.id),
        senderId: me,
        clientMessageId: body.clientMessageId,
        type: body.type ?? "text",
        content: body.content ?? null,
        replyToMessageId: body.replyToMessageId ?? null,
        attachments: body.attachments ?? undefined,
      });

      io.to(`conv:${message.conversationId}`).emit("message:new", message);
      res.status(message.deduplicated ? 200 : 201).json({ message });
    })
  );

  router.post(
    "/conversations/:id/read",
    requireAuth,
    asyncHandler(async (req, res) => {
      const me = req.auth!.userId;
      const conversationId = String(req.params.id);
      const seq = Number(req.body?.seq);
      if (!Number.isFinite(seq)) throw new ApiError(422, "INVALID_REQUEST", "seq is required");
      await assertParticipant(pool, redis, conversationId, me);

      await pool.query(
        `UPDATE conversation_participants SET last_read_seq = $3
          WHERE conversation_id = $1 AND user_id = $2 AND last_read_seq < $3`,
        [conversationId, me, seq]
      );
      io.to(`conv:${conversationId}`).emit("read:updated", { conversationId, userId: me, seq });
      res.json({ ok: true });
    })
  );

  router.post(
    "/conversations/:id/participants",
    requireAuth,
    asyncHandler(async (req, res) => {
      const conversationId = String(req.params.id);
      const targetId = String(req.body?.userId ?? "");
      if (!targetId) throw new ApiError(422, "INVALID_REQUEST", "userId is required");
      await assertParticipant(pool, redis, conversationId, req.auth!.userId);

      const { rows: conv } = await pool.query(`SELECT type FROM conversations WHERE id = $1`, [conversationId]);
      if (!conv[0]) throw new ApiError(404, "CONVERSATION_NOT_FOUND", "No such conversation");
      if (conv[0].type !== "group") throw new ApiError(422, "NOT_A_GROUP", "DMs have fixed membership");

      await pool.query(
        `INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [conversationId, targetId]
      );
      await invalidateParticipants(redis, conversationId);
      io.in(`user:${targetId}`).socketsJoin(`conv:${conversationId}`);
      io.to(`conv:${conversationId}`).emit("participant:added", { conversationId, userId: targetId });
      res.status(204).end();
    })
  );

  router.delete(
    "/conversations/:id/participants",
    requireAuth,
    asyncHandler(async (req, res) => {
      const conversationId = String(req.params.id);
      const targetId = String(req.body?.userId ?? "");
      if (!targetId) throw new ApiError(422, "INVALID_REQUEST", "userId is required");
      await assertParticipant(pool, redis, conversationId, req.auth!.userId);

      const { rows: conv } = await pool.query(`SELECT type FROM conversations WHERE id = $1`, [conversationId]);
      if (!conv[0]) throw new ApiError(404, "CONVERSATION_NOT_FOUND", "No such conversation");
      if (conv[0].type !== "group") throw new ApiError(422, "NOT_A_GROUP", "DMs have fixed membership");

      await pool.query(
        `DELETE FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2`,
        [conversationId, targetId]
      );
      await invalidateParticipants(redis, conversationId);
      io.to(`conv:${conversationId}`).emit("participant:removed", { conversationId, userId: targetId });
      io.in(`user:${targetId}`).socketsLeave(`conv:${conversationId}`);
      res.status(204).end();
    })
  );

  router.post(
    "/uploads/presign",
    requireAuth,
    asyncHandler(async (req, res) => {
      const filename = typeof req.body?.filename === "string" ? req.body.filename : "upload";
      const contentType = typeof req.body?.contentType === "string" ? req.body.contentType : "application/octet-stream";
      res.json(storage.presignUpload(req.auth!.userId, filename, contentType));
    })
  );

  return router;
}
