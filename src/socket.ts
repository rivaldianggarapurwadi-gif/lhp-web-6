import type { Server, Socket } from "socket.io";
import type { Redis } from "ioredis";
import { pool } from "./db.js";
import { authenticate } from "./auth.js";
import {
  sendMessage,
  backfill,
  assertParticipant,
  SendError,
  BACKFILL_LIMIT,
} from "./message-service.js";

interface SocketData {
  userId: string;
  exp: number;
}

type Ack<T> = (res: { ok: true; data: T } | { ok: false; error: { code: string; message: string } }) => void;

const ok = <T>(data: T) => ({ ok: true as const, data });
const fail = (code: string, message: string) => ({ ok: false as const, error: { code, message } });

/** Never let a handler throw across the socket boundary -- it kills the
 *  connection and the client cannot tell why. */
function guard<T>(ack: Ack<T> | undefined, fn: () => Promise<T>) {
  fn().then(
    (data) => ack?.(ok(data)),
    (err) => {
      if (err instanceof SendError) return ack?.(fail(err.code, err.message));
      console.error("[handler]", err);
      ack?.(fail("INTERNAL", "Something went wrong"));
    }
  );
}

export function attachSocketHandlers(io: Server, redis: Redis) {
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (typeof token !== "string") return next(new Error("UNAUTHORIZED"));
      const { userId, exp } = await authenticate(token);
      (socket.data as SocketData).userId = userId;
      (socket.data as SocketData).exp = exp;
      next();
    } catch {
      next(new Error("UNAUTHORIZED"));
    }
  });

  io.on("connection", (socket: Socket) => {
    const userId = (socket.data as SocketData).userId;

    void joinRooms(socket, userId);

    socket.on("message:send", (payload: any, ack: Ack<any>) =>
      guard(ack, async () => {
        const message = await sendMessage(pool, redis, {
          conversationId: payload.conversationId,
          senderId: userId,
          clientMessageId: payload.clientMessageId,
          type: payload.type ?? "text",
          content: payload.content ?? null,
          replyToMessageId: payload.replyToMessageId ?? null,
        });

        // Fan out AFTER commit. If this process dies here the message is still
        // durable and the next reconnect's sync picks it up.
        io.to(`conv:${message.conversationId}`).emit("message:new", message);
        return message;
      })
    );

    socket.on("messages:backfill", (payload: any, ack: Ack<any>) =>
      guard(ack, async () => {
        await assertParticipant(pool, redis, payload.conversationId, userId);
        return backfill(
          pool,
          payload.conversationId,
          payload.afterSeq ?? 0,
          payload.mutatedSince ?? null
        );
      })
    );

    socket.on("sync", (payload: any, ack: Ack<any>) =>
      guard(ack, () => sync(userId, payload?.cursors ?? {}, payload?.mutatedSince ?? null))
    );

    socket.on("message:read", (payload: any) => {
      void pool
        .query(
          `UPDATE conversation_participants SET last_read_seq = $3
            WHERE conversation_id = $1 AND user_id = $2 AND last_read_seq < $3`,
          [payload.conversationId, userId, payload.seq]
        )
        .then(() => {
          io.to(`conv:${payload.conversationId}`).emit("read:updated", {
            conversationId: payload.conversationId,
            userId,
            seq: payload.seq,
          });
        })
        .catch((e) => console.error("[read]", e));
    });

    socket.on("typing:start", (p: any) =>
      socket.to(`conv:${p.conversationId}`).emit("typing", {
        conversationId: p.conversationId, userId, isTyping: true,
      })
    );
    socket.on("typing:stop", (p: any) =>
      socket.to(`conv:${p.conversationId}`).emit("typing", {
        conversationId: p.conversationId, userId, isTyping: false,
      })
    );
  });
}

async function joinRooms(socket: Socket, userId: string) {
  await socket.join(`user:${userId}`);
  const { rows } = await pool.query<{ conversation_id: string }>(
    `SELECT conversation_id FROM conversation_participants WHERE user_id = $1`,
    [userId]
  );
  await Promise.all(rows.map((r) => socket.join(`conv:${r.conversation_id}`)));
  socket.emit("ready", { conversations: rows.map((r) => r.conversation_id) });
}

/**
 * The one place where the conversation list, per-conversation backfill,
 * membership deltas and the mutation cursor have to agree with each other.
 */
async function sync(
  userId: string,
  cursors: Record<string, number>,
  mutatedSince: string | null
) {
  const { rows: memberships } = await pool.query<{
    conversation_id: string;
    last_read_seq: number;
    last_seq: number;
    type: string;
    name: string | null;
    last_message_at: Date | null;
  }>(
    `SELECT cp.conversation_id, cp.last_read_seq,
            c.last_seq, c.type, c.name, c.last_message_at
       FROM conversation_participants cp
       JOIN conversations c ON c.id = cp.conversation_id
      WHERE cp.user_id = $1
      ORDER BY c.last_message_at DESC NULLS LAST`,
    [userId]
  );

  const current = new Set(memberships.map((m) => m.conversation_id));

  // Anything the client still holds a cursor for but is no longer in: it was
  // removed while offline and must be dropped from the client's cache.
  const removed = Object.keys(cursors).filter((id) => !current.has(id));

  const conversations = [];
  for (const m of memberships) {
    const cursor = cursors[m.conversation_id] ?? null;

    if (cursor === null) {
      // Not in the client's working set. Announce it -- possibly a conversation
      // it was added to while offline -- but let it load history lazily.
      conversations.push({
        id: m.conversation_id,
        type: m.type,
        name: m.name,
        lastSeq: m.last_seq,
        lastReadSeq: m.last_read_seq,
        messages: [],
        truncated: false,
        lazy: true,
      });
      continue;
    }

    const behind = m.last_seq - cursor;
    if (behind > BACKFILL_LIMIT) {
      conversations.push({
        id: m.conversation_id,
        type: m.type,
        name: m.name,
        lastSeq: m.last_seq,
        lastReadSeq: m.last_read_seq,
        messages: [],
        truncated: true,
        lazy: false,
      });
      continue;
    }

    const page = await backfill(pool, m.conversation_id, cursor, mutatedSince);
    conversations.push({
      id: m.conversation_id,
      type: m.type,
      name: m.name,
      lastSeq: m.last_seq,
      lastReadSeq: m.last_read_seq,
      messages: page.messages,
      truncated: page.truncated,
      lazy: false,
    });
  }

  const { rows: clock } = await pool.query<{ now: Date }>(`SELECT now() AS now`);
  return { conversations, removed, syncedAt: clock[0].now.toISOString() };
}
