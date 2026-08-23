import { randomBytes, randomUUID, createHash } from "node:crypto";
import { Pool } from "pg";

export class RefreshTokenError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export interface IssuedRefreshToken {
  token: string;
  familyId: string;
}

export async function issueRefreshToken(
  pool: Pool,
  userId: string,
  familyId: string = randomUUID()
): Promise<IssuedRefreshToken> {
  const token = randomBytes(32).toString("base64url");
  await pool.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, family_id) VALUES ($1, $2, $3)`,
    [userId, hashToken(token), familyId]
  );
  return { token, familyId };
}

export interface RotatedRefreshToken {
  userId: string;
  sessionVersion: number;
  next: IssuedRefreshToken;
}

/**
 * Reuse of an already-rotated token is the signature of theft: the
 * legitimate client rotated past it, so whoever is presenting it now got it
 * some other way. The whole family -- not just this row -- gets revoked, and
 * session_version bumps so every access token in flight dies too.
 *
 * Row-locked so two concurrent refresh calls on the same token cannot both
 * observe "not yet rotated" and both succeed.
 */
export async function rotateRefreshToken(pool: Pool, rawToken: string): Promise<RotatedRefreshToken> {
  const client = await pool.connect();
  let reuseDetected = false;
  try {
    await client.query("BEGIN");

    const { rows } = await client.query<{
      id: string;
      user_id: string;
      family_id: string;
      rotated_at: Date | null;
      revoked_at: Date | null;
    }>(
      `SELECT id, user_id, family_id, rotated_at, revoked_at
         FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE`,
      [hashToken(rawToken)]
    );
    const row = rows[0];
    if (!row) {
      throw new RefreshTokenError("INVALID_TOKEN", "Refresh token not recognised");
    }

    if (row.rotated_at || row.revoked_at) {
      reuseDetected = true;
      await client.query(
        `UPDATE refresh_tokens SET revoked_at = now()
          WHERE family_id = $1 AND revoked_at IS NULL`,
        [row.family_id]
      );
      await client.query(
        `UPDATE users SET session_version = session_version + 1 WHERE id = $1`,
        [row.user_id]
      );
      await client.query("COMMIT");
      throw new RefreshTokenError("TOKEN_REUSE_DETECTED", "Session revoked");
    }

    await client.query(`UPDATE refresh_tokens SET rotated_at = now() WHERE id = $1`, [row.id]);

    const nextToken = randomBytes(32).toString("base64url");
    await client.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, family_id) VALUES ($1, $2, $3)`,
      [row.user_id, hashToken(nextToken), row.family_id]
    );

    const { rows: userRows } = await client.query<{ session_version: number }>(
      `SELECT session_version FROM users WHERE id = $1`,
      [row.user_id]
    );

    await client.query("COMMIT");

    return {
      userId: row.user_id,
      sessionVersion: userRows[0].session_version,
      next: { token: nextToken, familyId: row.family_id },
    };
  } catch (err) {
    // The reuse-detected path already committed -- rolling back here would
    // undo the revocation it just made durable.
    if (!reuseDetected) await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function revokeFamily(pool: Pool, familyId: string): Promise<void> {
  await pool.query(
    `UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL`,
    [familyId]
  );
}

export async function revokeAllForUser(pool: Pool, userId: string): Promise<void> {
  await pool.query(
    `UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId]
  );
}
