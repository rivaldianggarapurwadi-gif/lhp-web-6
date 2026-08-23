import type { Pool } from "pg";
import type { Redis } from "ioredis";
import type { Server } from "socket.io";
import { getParticipantIds } from "./message-service.js";
import { sendPushToUser } from "./push.js";
import { sendEmailToUser } from "./email.js";

export interface NotifyPayload {
  title: string;
  body: string;
  conversationId?: string;
}

/**
 * Called after the live socket fan-out, not instead of it. A participant
 * with a socket connected right now gets the in-page notification off that
 * same event -- notifying them again here would double-notify. Only
 * whoever has zero connected sockets at this instant is actually
 * unreachable any other way, which is exactly who push/email exist for.
 *
 * Both channels are tried for each offline participant, independently --
 * a missing push subscription or a missing email address just makes that
 * one channel's send a no-op (see push.ts/email.ts), not a skip of the
 * other.
 */
export async function notifyOfflineParticipants(
  io: Server,
  pool: Pool,
  redis: Redis,
  conversationId: string,
  senderId: string,
  payload: NotifyPayload
): Promise<void> {
  const participantIds = await getParticipantIds(pool, redis, conversationId);
  const others = participantIds.filter((id) => id !== senderId);

  await Promise.all(
    others.map(async (userId) => {
      const sockets = await io.in(`user:${userId}`).fetchSockets();
      if (sockets.length > 0) return;
      await Promise.all([
        sendPushToUser(pool, userId, payload),
        sendEmailToUser(pool, userId, { subject: payload.title, text: payload.body }),
      ]);
    })
  );
}
