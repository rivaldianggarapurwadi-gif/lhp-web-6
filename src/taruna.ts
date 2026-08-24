import type { Pool } from "pg";
import type { Redis } from "ioredis";
import { invalidateParticipants } from "./message-service.js";

/**
 * The reset that runs on every Taruna login. Deliberately narrow: it removes
 * only this user's *membership* in conversations, never a message or a
 * conversation row itself. That's what keeps the other side's history
 * intact while this account's chat view goes back to a clean slate -- and
 * it's what makes "pending" messages possible at all: a Ceko message sent
 * while this row didn't exist is still sitting in the conversation, waiting
 * for this user to re-join it.
 *
 * Contacts are never *deleted* here -- a `contacts` row is a single
 * relationship shared by both users, not two independent per-user records;
 * deleting "the Taruna's side" of it deletes the only row there is, which
 * would also erase it from the Ceko's own contact list. That was the
 * original plan, corrected after testing surfaced why. What this does
 * instead is hide every accepted contact from this user's own view only
 * (see migrations/008_contact_hiding.sql) -- the row survives untouched and
 * the other side's list is never affected. The same "re-add by tag" flow
 * this account already uses to reopen a wiped conversation un-hides it
 * again (see social-routes.ts POST /contacts).
 *
 * Blocks are also deliberately NOT cleared. Wiping them every login would
 * re-expose a Taruna to someone they deliberately blocked, which cuts
 * against the entire point of a block.
 */
export async function wipeTarunaHistory(pool: Pool, redis: Redis, userId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: memberships } = await client.query<{ conversation_id: string }>(
      `SELECT conversation_id FROM conversation_participants WHERE user_id = $1`,
      [userId]
    );

    await client.query(`DELETE FROM conversation_participants WHERE user_id = $1`, [userId]);

    await client.query(
      `UPDATE contacts SET requester_hidden = true WHERE requester_id = $1 AND status = 'accepted'`,
      [userId]
    );
    await client.query(
      `UPDATE contacts SET addressee_hidden = true WHERE addressee_id = $1 AND status = 'accepted'`,
      [userId]
    );

    await client.query("COMMIT");

    // Outside the transaction, after COMMIT -- same reasoning as the send
    // path in message-service.ts: don't do slow/external work (a Redis
    // round trip per conversation here) while holding rows locked.
    await Promise.all(memberships.map((m) => invalidateParticipants(redis, m.conversation_id)));
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
