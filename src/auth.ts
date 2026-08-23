import jwt from "jsonwebtoken";
import { config } from "./config.js";
import { pool } from "./db.js";

export interface AccessClaims {
  sub: string;
  sv: number; // session_version at issue time
  exp: number;
}

export function signAccessToken(userId: string, sessionVersion: number): string {
  return jwt.sign({ sub: userId, sv: sessionVersion }, config.jwtSecret, {
    expiresIn: config.accessTokenTtlSeconds,
  });
}

export function verifyAccessToken(token: string): AccessClaims {
  return jwt.verify(token, config.jwtSecret) as AccessClaims;
}

/**
 * A token is not enough on its own. The account may have been disabled, or its
 * session_version bumped by a password change, since the token was issued --
 * and a socket outlives its token by hours.
 */
export async function authenticate(token: string) {
  const claims = verifyAccessToken(token);
  const { rows } = await pool.query<{
    id: string;
    session_version: number;
    disabled_at: Date | null;
    is_admin: boolean;
    account_kind: "ceko" | "taruna";
  }>(`SELECT id, session_version, disabled_at, is_admin, account_kind FROM users WHERE id = $1`, [
    claims.sub,
  ]);

  const user = rows[0];
  if (!user) throw new Error("UNAUTHORIZED");
  if (user.disabled_at) throw new Error("UNAUTHORIZED");
  if (user.session_version !== claims.sv) throw new Error("UNAUTHORIZED");
  return { userId: user.id, exp: claims.exp, isAdmin: user.is_admin, accountKind: user.account_kind };
}
