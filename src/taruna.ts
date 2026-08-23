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
 * Contacts are deliberately NOT cleared here, unlike the original plan --
 * this was corrected after testing surfaced why. A `contacts` row is a
 * single relationship *shared* by both users, not two independent per-user
 * records; deleting "the Taruna's side" of it deletes the only row there
 * is, which would also erase it from the Ceko's own contact list and break
 * "Ceko's side is never cleared." The conversation history and list --
 * which the wipe below does clear -- is what "the chat" actually means;
 * the address book is a separate concept and survives.
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
