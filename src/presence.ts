import type { Pool } from "pg";
import type { Redis } from "ioredis";

/**
 * Crash-tolerant by construction: an instance that dies mid-connection
 * leaves nothing to clean up. Membership is a ZSET scored by last-heartbeat
 * time; "online" is a read-time window check, and the sweeper below just
 * evicts whatever has aged out. Nothing here depends on a disconnect event
 * ever actually arriving.
 */
const PRESENCE_KEY = "presence";

export const HEARTBEAT_INTERVAL_MS = Number(process.env.PRESENCE_HEARTBEAT_MS ?? 30_000);
export const ONLINE_WINDOW_MS = Number(process.env.PRESENCE_ONLINE_WINDOW_MS ?? 90_000);
export const SWEEP_INTERVAL_MS = Number(process.env.PRESENCE_SWEEP_INTERVAL_MS ?? 30_000);
// How long to wait after a user's last socket closes before treating them as
// offline, so a reconnecting client (a page refresh, a flaky connection)
// doesn't flap the dot on every contact's screen. The heartbeat/sweep pair
// above is the crash-tolerant backstop for when this never gets to run at
// all (the process is killed, not just disconnected).
export const OFFLINE_DEBOUNCE_MS = Number(process.env.PRESENCE_OFFLINE_DEBOUNCE_MS ?? 12_000);

export async function heartbeat(redis: Redis, userId: string): Promise<void> {
  await redis.zadd(PRESENCE_KEY, Date.now(), userId);
}

export async function removePresence(redis: Redis, userId: string): Promise<void> {
  await redis.zrem(PRESENCE_KEY, userId);
}

export async function isOnline(redis: Redis, userId: string): Promise<boolean> {
  const score = await redis.zscore(PRESENCE_KEY, userId);
  return score !== null && Date.now() - Number(score) < ONLINE_WINDOW_MS;
}

export async function getOnlineUserIds(redis: Redis, userIds: string[]): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const scores = await redis.zmscore(PRESENCE_KEY, ...userIds);
  const cutoff = Date.now() - ONLINE_WINDOW_MS;
  const online = new Set<string>();
  userIds.forEach((id, i) => {
    const score = scores[i];
    if (score !== null && Number(score) > cutoff) online.add(id);
  });
  return online;
}

/**
 * Evicts anything past the online window and returns who just aged out, so
 * the caller can fan that out. Guarded by a short-lived Redis lock so that
 * in a multi-instance cluster only one instance performs a given sweep tick
 * -- otherwise every instance would independently fan out the same
 * "went offline" event.
 */
export async function sweepStalePresence(redis: Redis): Promise<string[]> {
  const gotLock = await redis.set("presence:sweep:lock", "1", "PX", Math.max(SWEEP_INTERVAL_MS - 2000, 1000), "NX");
  if (!gotLock) return [];

  const cutoff = Date.now() - ONLINE_WINDOW_MS;
  const stale = await redis.zrangebyscore(PRESENCE_KEY, "-inf", cutoff);
  if (stale.length > 0) await redis.zremrangebyscore(PRESENCE_KEY, "-inf", cutoff);
  return stale;
}

/** Fan-out is narrow on purpose -- broadcasting every presence change to
 *  every connected user is the classic way to melt a chat server, an O(n^2)
 *  cost as the user base grows. Only accepted contacts ever need to know. */
export async function getContactIds(pool: Pool, userId: string): Promise<string[]> {
  const { rows } = await pool.query<{ other_id: string }>(
    `SELECT CASE WHEN requester_id = $1 THEN addressee_id ELSE requester_id END AS other_id
       FROM contacts
      WHERE status = 'accepted' AND (requester_id = $1 OR addressee_id = $1)`,
    [userId]
  );
  return rows.map((r) => r.other_id);
}
