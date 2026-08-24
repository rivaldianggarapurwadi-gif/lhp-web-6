import { Router } from "express";
import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import type { Server } from "socket.io";
import { hashPassword } from "../password.js";
import { generateUniqueTag } from "../tag.js";
import { revokeAllForUser } from "../refresh-token.js";
import { asyncHandler, requireAuth, requireAdmin, ApiError } from "./middleware.js";

export function createAdminRouter(pool: Pool, io: Server): Router {
  const router = Router();

  router.post(
    "/admin/users",
    requireAuth,
    requireAdmin,
    asyncHandler(async (req, res) => {
      const { username, password, accountKind } = req.body ?? {};
      if (typeof username !== "string" || username.trim().length === 0) {
        throw new ApiError(422, "INVALID_REQUEST", "username wajib diisi");
      }
      if (accountKind !== undefined && accountKind !== "ceko" && accountKind !== "taruna") {
        throw new ApiError(422, "INVALID_REQUEST", "accountKind harus 'ceko' atau 'taruna'");
      }

      const tag = await generateUniqueTag(pool);
      // An admin-chosen password is supported, but if none is given, mint a
      // one-time random one server-side and hand it back exactly once --
      // it is never stored anywhere but the hash.
      const generatedPassword: string | null =
        typeof password === "string" && password.length > 0 ? null : randomBytes(9).toString("base64url");
      const passwordHash = await hashPassword(generatedPassword ?? password);

      const { rows } = await pool.query(
        `INSERT INTO users (username, tag, password_hash, created_by, account_kind)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, username, tag, is_admin, account_kind, created_at`,
        [username.trim(), tag, passwordHash, req.auth!.userId, accountKind ?? "ceko"]
      );

      res.status(201).json({ user: rows[0], generatedPassword });
    })
  );

  router.get(
    "/admin/users",
    requireAuth,
    requireAdmin,
    asyncHandler(async (req, res) => {
      const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
      const before = typeof req.query.before === "string" ? req.query.before : null;
      const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);

      const { rows } = await pool.query(
        `SELECT id, username, tag, email, is_admin, account_kind, disabled_at, created_at
           FROM users
          WHERE ($1 = '' OR username ILIKE '%' || $1 || '%' OR tag ILIKE '%' || $1 || '%')
            AND ($2::timestamptz IS NULL OR created_at < $2::timestamptz)
          ORDER BY created_at DESC
          LIMIT $3`,
        [q, before, limit]
      );
      res.json({ users: rows });
    })
  );

  router.patch(
    "/admin/users/:id",
    requireAuth,
    requireAdmin,
    asyncHandler(async (req, res) => {
      const id = String(req.params.id);
      const { disabled, newPassword, username, isAdmin, accountKind, email } = req.body ?? {};

      if (accountKind !== undefined && accountKind !== "ceko" && accountKind !== "taruna") {
        throw new ApiError(422, "INVALID_REQUEST", "accountKind harus 'ceko' atau 'taruna'");
      }
      if (email !== undefined && email !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new ApiError(422, "INVALID_REQUEST", "Format email tidak valid");
      }

      const { rows: existing } = await pool.query(`SELECT id FROM users WHERE id = $1`, [id]);
      if (!existing[0]) throw new ApiError(404, "NOT_FOUND", "Pengguna tidak ditemukan");

      // isAdmin is read fresh from the DB on every request (see
      // authenticate() in auth.ts, called on every requireAuth), never
      // cached in the token -- so demoting/promoting takes effect
      // immediately without needing a session bump. Refusing to demote
      // yourself avoids an admin locking themselves out with no other
      // admin able to undo it.
      if (isAdmin === false && id === req.auth!.userId) {
        throw new ApiError(422, "CANNOT_SELF_DEMOTE", "Tidak bisa mencabut hak admin milikmu sendiri");
      }

      // Disabling, resetting a password, or switching account kind all need
      // to kill every live session immediately, not just future logins --
      // bump session_version (invalidates outstanding access tokens on
      // their next check) and revoke refresh tokens (stops silent renewal
      // -- essential for a ceko-to-taruna switch, since a Taruna must never
      // keep a persistent session alive), then drop the live sockets right
      // now rather than waiting for their next re-auth check.
      const sessionInvalidatingChange =
        disabled === true || typeof newPassword === "string" || accountKind !== undefined;

      const sets: string[] = [];
      const values: unknown[] = [id];
      if (typeof disabled === "boolean") {
        sets.push(`disabled_at = ${disabled ? "now()" : "NULL"}`);
      }
      if (typeof newPassword === "string" && newPassword.length > 0) {
        values.push(await hashPassword(newPassword));
        sets.push(`password_hash = $${values.length}`);
      }
      if (typeof username === "string" && username.trim().length > 0) {
        values.push(username.trim());
        sets.push(`username = $${values.length}`);
      }
      if (typeof isAdmin === "boolean") {
        sets.push(`is_admin = ${isAdmin ? "TRUE" : "FALSE"}`);
      }
      if (email !== undefined) {
        values.push(email);
        sets.push(`email = $${values.length}`);
      }
      if (accountKind !== undefined) {
        values.push(accountKind);
        sets.push(`account_kind = $${values.length}`);
      }
      if (sessionInvalidatingChange) {
        sets.push(`session_version = session_version + 1`);
      }
      if (sets.length === 0) {
        throw new ApiError(422, "INVALID_REQUEST", "Tidak ada yang diperbarui");
      }

      const { rows } = await pool.query(
        `UPDATE users SET ${sets.join(", ")} WHERE id = $1
         RETURNING id, username, tag, email, is_admin, account_kind, disabled_at, created_at`,
        values
      );

      if (sessionInvalidatingChange) {
        await revokeAllForUser(pool, id);
        io.in(`user:${id}`).disconnectSockets(true);
      }

      res.json({ user: rows[0] });
    })
  );

  return router;
}
