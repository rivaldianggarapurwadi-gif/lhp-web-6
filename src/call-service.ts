import type { Pool } from "pg";
import type { Redis } from "ioredis";
import type { Server } from "socket.io";
import { randomUUID } from "node:crypto";
import { AccessToken } from "livekit-server-sdk";
import { config } from "./config.js";
import { getParticipantIds, sendMessage, type PersistedMessage } from "./message-service.js";

/**
 * Signalling only -- media never touches the socket. LiveKit (or any SFU)
 * owns the actual WebRTC negotiation once a client has a room name and a
 * token; everything here is the ring/accept/decline/timeout lifecycle and
 * vending that token. See the design note's "Calls" section.
 */

export class CallError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

// Same env-override pattern as presence.ts -- tests need a timeout measured
// in milliseconds, not 45 real seconds.
export const RING_TIMEOUT_SECONDS = Number(process.env.CALL_RING_TIMEOUT_SECONDS ?? 45);
export const SWEEP_INTERVAL_MS = Number(process.env.CALL_SWEEP_INTERVAL_MS ?? 15_000);

const SWEEP_LOCK_KEY = "call:sweep:lock";
// Long enough to comfortably outlast a real call, short enough that a token
// leaked out of the app is not a standing credential forever.
const TOKEN_TTL_SECONDS = 4 * 60 * 60;

export interface CallRow {
  id: string;
  conversationId: string;
  type: "voice" | "video";
  status: "ringing" | "active" | "ended" | "missed";
  startedBy: string;
  startedAt: string;
  endedAt: string | null;
  sfuRoomName: string | null;
}

function mapRow(row: any): CallRow {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    type: row.type,
    status: row.status,
    startedBy: row.started_by,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    sfuRoomName: row.sfu_room_name,
  };
}

/**
 * Additive, not load-bearing -- same pattern as push.ts/email.ts. Unset
 * LIVEKIT_API_KEY/LIVEKIT_API_SECRET and this is a no-op that returns null
 * instead of throwing, so the ring/accept/decline/timeout bookkeeping below
 * still runs in full; only the actual media connection is missing until
 * real keys are configured.
 */
async function mintToken(roomName: string, identity: string): Promise<string | null> {
  if (!config.livekitApiKey || !config.livekitApiSecret) {
    console.log(`[call] skipped token for ${identity}: LIVEKIT_API_KEY/LIVEKIT_API_SECRET not configured`);
    return null;
  }
  const token = new AccessToken(config.livekitApiKey, config.livekitApiSecret, {
    identity,
    ttl: TOKEN_TTL_SECONDS,
  });
  token.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });
  return token.toJwt();
}

export async function startCall(
  pool: Pool,
  redis: Redis,
  input: { conversationId: string; startedBy: string; type: "voice" | "video" }
): Promise<{ call: CallRow; token: string | null; otherParticipantIds: string[] }> {
  const participants = await getParticipantIds(pool, redis, input.conversationId);
  if (!participants.includes(input.startedBy)) {
    throw new CallError("NOT_A_PARTICIPANT", "Kamu bukan bagian dari percakapan ini");
  }

  // Never let the client name its own room -- that's how someone joins a
  // call they weren't invited to.
  const roomName = `call-${randomUUID()}`;

  let row: any;
  try {
    const { rows } = await pool.query(
      `INSERT INTO calls (conversation_id, type, started_by, sfu_room_name)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [input.conversationId, input.type, input.startedBy, roomName]
    );
    row = rows[0];
  } catch (err: any) {
    // The partial unique index (one live call per conversation) is the
    // authority here, not an application-level check-then-insert that a
    // race could slip past.
    if (err.code === "23505") {
      throw new CallError("CALL_IN_PROGRESS", "Sudah ada panggilan yang sedang berlangsung di percakapan ini");
    }
    throw err;
  }

  await pool.query(
    `INSERT INTO call_participants (call_id, user_id, joined_at) VALUES ($1, $2, now())`,
    [row.id, input.startedBy]
  );

  const token = await mintToken(roomName, input.startedBy);
  return {
    call: mapRow(row),
    token,
    otherParticipantIds: participants.filter((id) => id !== input.startedBy),
  };
}

export async function acceptCall(
  pool: Pool,
  redis: Redis,
  callId: string,
  userId: string
): Promise<{ call: CallRow; token: string | null }> {
  const { rows } = await pool.query(`SELECT * FROM calls WHERE id = $1`, [callId]);
  const existing = rows[0];
  if (!existing) throw new CallError("CALL_NOT_FOUND", "Panggilan tidak ditemukan");
  if (existing.status !== "ringing" && existing.status !== "active") {
    throw new CallError("CALL_ENDED", "Panggilan sudah berakhir");
  }

  const participants = await getParticipantIds(pool, redis, existing.conversation_id);
  if (!participants.includes(userId)) {
    throw new CallError("NOT_A_PARTICIPANT", "Kamu bukan bagian dari percakapan ini");
  }

  await pool.query(
    `INSERT INTO call_participants (call_id, user_id, joined_at) VALUES ($1, $2, now())
     ON CONFLICT (call_id, user_id) DO UPDATE SET joined_at = COALESCE(call_participants.joined_at, now())`,
    [callId, userId]
  );

  const { rows: activated } = await pool.query(
    `UPDATE calls SET status = 'active' WHERE id = $1 AND status = 'ringing' RETURNING *`,
    [callId]
  );
  const row = activated[0] ?? existing;

  const token = await mintToken(existing.sfu_room_name, userId);
  return { call: mapRow(row), token };
}

/**
 * A decline in a DM ends the call outright -- there is no one else who
 * could still answer. In a group call it only means this one person isn't
 * joining; the call keeps ringing for whoever's left until someone accepts
 * or the timeout sweep marks the whole thing missed.
 */
export async function declineCall(
  pool: Pool,
  callId: string,
  userId: string
): Promise<{ call: CallRow; ended: boolean } | null> {
  const { rows } = await pool.query(
    `SELECT c.*, conv.type AS conversation_type
       FROM calls c JOIN conversations conv ON conv.id = c.conversation_id
      WHERE c.id = $1`,
    [callId]
  );
  const existing = rows[0];
  if (!existing || existing.status !== "ringing") return null;

  if (existing.conversation_type !== "dm") {
    return { call: mapRow(existing), ended: false };
  }

  const { rows: updated } = await pool.query(
    `UPDATE calls SET status = 'missed', ended_at = now() WHERE id = $1 AND status = 'ringing' RETURNING *`,
    [callId]
  );
  if (!updated[0]) return null;
  return { call: mapRow(updated[0]), ended: true };
}

/** Explicit hangup. Also what the timeout sweep uses internally once a
 *  call's last live participant is gone. */
export async function leaveCall(
  pool: Pool,
  callId: string,
  userId: string
): Promise<{ call: CallRow; ended: boolean } | null> {
  await pool.query(
    `UPDATE call_participants SET left_at = now()
      WHERE call_id = $1 AND user_id = $2 AND left_at IS NULL`,
    [callId, userId]
  );

  const { rows: remaining } = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM call_participants WHERE call_id = $1 AND left_at IS NULL`,
    [callId]
  );
  if (Number(remaining[0].n) > 0) return null;

  const { rows: updated } = await pool.query(
    `UPDATE calls SET status = 'ended', ended_at = now()
      WHERE id = $1 AND status IN ('ringing', 'active') RETURNING *`,
    [callId]
  );
  if (!updated[0]) return null;
  return { call: mapRow(updated[0]), ended: true };
}

/** A system message goes through the exact same seq-allocated send path as
 *  any other message (message-service.ts is the only place a message is
 *  written), so it orders correctly and fans out over the normal
 *  message:new event instead of a parallel mechanism the client has to
 *  know about separately. */
export async function postCallSystemMessage(
  pool: Pool,
  redis: Redis,
  call: CallRow,
  content: string
): Promise<PersistedMessage> {
  return sendMessage(pool, redis, {
    conversationId: call.conversationId,
    senderId: call.startedBy,
    clientMessageId: randomUUID(),
    type: "system",
    content,
  });
}

/**
 * ~45 seconds after a call starts ringing with nobody having accepted, it's
 * missed. Not a bare setTimeout on the originating instance -- if that
 * process restarts mid-ring, the call would ring forever. A periodic sweep
 * over the actual row state survives a deploy; the Redis lock (same
 * pattern as presence.ts's sweep) keeps every instance from double-firing
 * the same sweep tick.
 */
export async function sweepRingingCalls(pool: Pool, redis: Redis, io: Server): Promise<void> {
  const gotLock = await redis.set(
    SWEEP_LOCK_KEY,
    "1",
    "PX",
    Math.max(SWEEP_INTERVAL_MS - 2000, 1000),
    "NX"
  );
  if (!gotLock) return;

  const { rows } = await pool.query(
    `UPDATE calls SET status = 'missed', ended_at = now()
      WHERE status = 'ringing' AND started_at < now() - make_interval(secs => $1)
    RETURNING *`,
    [RING_TIMEOUT_SECONDS]
  );

  for (const row of rows) {
    const call = mapRow(row);
    io.to(`conv:${call.conversationId}`).emit("call:ended", { callId: call.id, status: call.status });
    const message = await postCallSystemMessage(pool, redis, call, "Panggilan tidak terjawab");
    io.to(`conv:${call.conversationId}`).emit("message:new", message);
  }
}
