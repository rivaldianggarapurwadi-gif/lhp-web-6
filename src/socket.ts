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
import {
  heartbeat,
  removePresence,
  getContactIds,
  sweepStalePresence,
  HEARTBEAT_INTERVAL_MS,
  OFFLINE_DEBOUNCE_MS,
} from "./presence.js";

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

    void heartbeat(redis, userId);
    void announcePresenceIfFirstSocket(io, redis, userId);
    const heartbeatTimer = setInterval(() => void heartbeat(redis, userId), HEARTBEAT_INTERVAL_MS);
    socket.on("disconnect", () => {
      clearInterval(heartbeatTimer);
      void debounceOfflineIfLastSocket(io, redis, userId);
    });

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

    socket.on("typing:start", (p: any) => void relayTyping(socket, redis, userId, p?.conversationId, true));
    socket.on("typing:stop", (p: any) => void relayTyping(socket, redis, userId, p?.conversationId, false));
  });
}

/**
 * Never persisted -- this is a raw relay, not a message. Two guards the bare
 * version didn't have: a participant check (otherwise anyone with a
 * conversation id can make their name flash "typing..." in a room they were
 * never added to), and a rate limit (a chatty client re-emitting on every
 * keystroke otherwise fans out to every other participant on every
 * keystroke too). Silently drops rather than acking an error -- typing
 * indicators have no meaningful failure UI.
 */
async function relayTyping(socket: Socket, redis: Redis, userId: string, conversationId: unknown, isTyping: boolean) {
  if (typeof conversationId !== "string") return;
  try {
    await assertParticipant(pool, redis, conversationId, userId);
  } catch {
    return;
  }
  if (isTyping) {
    // At most one "start" event relayed per 2s per (user, conversation);
    // "stop" always goes through so the indicator doesn't get stuck lit.
    const allowed = await redis.set(`typing-rl:${conversationId}:${userId}`, "1", "PX", 2000, "NX");
    if (!allowed) return;
  }
  socket.to(`conv:${conversationId}`).emit("typing", { conversationId, userId, isTyping });
}

/**
 * The crash-tolerant backstop: a process killed outright never gets to run
 * its disconnect handler, so nothing ever calls debounceOfflineIfLastSocket
 * for its sockets. This is what still ages them out. Called on an interval
 * from server.ts -- see presence.ts for why only one instance actually does
 * the eviction per tick.
 */
export async function runPresenceSweep(io: Server, redis: Redis) {
  const staleUserIds = await sweepStalePresence(redis);
  await Promise.all(staleUserIds.map((id) => fanOutPresence(io, id, false)));
}

/** Fans out to accepted contacts only -- see presence.ts for why. */
async function fanOutPresence(io: Server, userId: string, isOnline: boolean) {
  const contactIds = await getContactIds(pool, userId);
  if (contactIds.length === 0) return;
  io.in(contactIds.map((id) => `user:${id}`)).emit("presence", { userId, isOnline });
}

async function announcePresenceIfFirstSocket(io: Server, redis: Redis, userId: string) {
  const sockets = await io.in(`user:${userId}`).fetchSockets();
  if (sockets.length === 1) await fanOutPresence(io, userId, true);
}

async function debounceOfflineIfLastSocket(io: Server, redis: Redis, userId: string) {
  const stillConnected = (await io.in(`user:${userId}`).fetchSockets()).length > 0;
  if (stillConnected) return;
  setTimeout(async () => {
    // Re-check after the debounce window -- a page refresh or a flaky
    // connection reconnects well within it, and must not flip the dot.
    const reconnected = (await io.in(`user:${userId}`).fetchSockets()).length > 0;
    if (reconnected) return;
    await removePresence(redis, userId);
    await fanOutPresence(io, userId, false);
  }, OFFLINE_DEBOUNCE_MS);
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
