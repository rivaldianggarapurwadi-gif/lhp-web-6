import { Router } from "express";
import type { Pool } from "pg";
import type { Redis } from "ioredis";
import type { Server } from "socket.io";
import { signAccessToken } from "../auth.js";
import { hashPassword, verifyPassword } from "../password.js";
import { normalizeTag } from "../tag.js";
import { issueRefreshToken, rotateRefreshToken, revokeAllForUser } from "../refresh-token.js";
import { checkRateLimit } from "../rate-limit.js";
import { parseCookies, serializeCookie, clearedCookie } from "../cookies.js";
import { config } from "../config.js";
import { asyncHandler, requireAuth, ApiError } from "./middleware.js";

const REFRESH_COOKIE = "ceko_refresh";

function refreshCookieOpts(req: { protocol: string }) {
  return {
    path: "/auth",
    maxAgeSeconds: config.refreshTokenTtlSeconds,
    secure: req.protocol === "https" || config.nodeEnv === "production",
    sameSite: "Lax" as const,
  };
}

// A dummy hash checked when the tag doesn't exist, so a login attempt for an
// unknown tag takes the same scrypt-shaped time as one for a real user with
// the wrong password. Without this, response latency alone tells an attacker
// which tags are registered.
let dummyHash: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  if (!dummyHash) dummyHash = hashPassword("not-a-real-password-just-for-timing");
  return dummyHash;
}

export function createAuthRouter(pool: Pool, redis: Redis, io: Server): Router {
  const router = Router();

  router.post(
    "/auth/login",
    asyncHandler(async (req, res) => {
      const { tag, password } = req.body ?? {};
      if (typeof tag !== "string" || typeof password !== "string") {
        throw new ApiError(400, "INVALID_REQUEST", "tag and password are required");
      }

      const ip = req.ip ?? "unknown";
      const { allowed, retryAfterSeconds } = await checkRateLimit(redis, `login:${ip}`, [
        { name: "burst", windowSeconds: 60, max: 10 },
        { name: "sustained", windowSeconds: 3600, max: 50 },
      ]);
      if (!allowed) {
        res.setHeader("Retry-After", String(retryAfterSeconds));
        throw new ApiError(429, "RATE_LIMITED", "Too many attempts");
      }

      const { rows } = await pool.query<{
        id: string;
        username: string;
        tag: string;
        password_hash: string;
        is_admin: boolean;
        disabled_at: Date | null;
        session_version: number;
      }>(
        `SELECT id, username, tag, password_hash, is_admin, disabled_at, session_version
           FROM users WHERE tag = $1`,
        [normalizeTag(tag)]
      );
      const user = rows[0];

      const valid = user
        ? await verifyPassword(password, user.password_hash)
        : await verifyPassword(password, await getDummyHash());

      if (!user || !valid || user.disabled_at) {
        throw new ApiError(401, "INVALID_CREDENTIALS", "Invalid tag or password");
      }

      const accessToken = signAccessToken(user.id, user.session_version);
      const { token: refreshToken } = await issueRefreshToken(pool, user.id);

      res.setHeader("Set-Cookie", serializeCookie(REFRESH_COOKIE, refreshToken, refreshCookieOpts(req)));
      res.json({
        accessToken,
        user: { id: user.id, username: user.username, tag: user.tag, isAdmin: user.is_admin },
      });
    })
  );

  router.post(
    "/auth/refresh",
    asyncHandler(async (req, res) => {
      const cookies = parseCookies(req.header("cookie"));
      const refreshToken = cookies[REFRESH_COOKIE];
      if (!refreshToken) throw new ApiError(401, "UNAUTHORIZED", "No refresh token");

      try {
        const rotated = await rotateRefreshToken(pool, refreshToken);
        const accessToken = signAccessToken(rotated.userId, rotated.sessionVersion);
        res.setHeader(
          "Set-Cookie",
          serializeCookie(REFRESH_COOKIE, rotated.next.token, refreshCookieOpts(req))
        );
        res.json({ accessToken });
      } catch (err) {
        // Whatever went wrong, the cookie the client is holding is dead --
        // don't leave it around to be retried forever.
        res.setHeader("Set-Cookie", clearedCookie(REFRESH_COOKIE, refreshCookieOpts(req)));
        throw err;
      }
    })
  );

  router.post(
    "/auth/logout",
    requireAuth,
    asyncHandler(async (req, res) => {
      const userId = req.auth!.userId;
      await revokeAllForUser(pool, userId);
      res.setHeader("Set-Cookie", clearedCookie(REFRESH_COOKIE, refreshCookieOpts(req)));
      // Matches the design note: logout disconnects this user's live
      // sockets everywhere, cluster-wide via the redis adapter. There is no
      // per-device session tracking at the socket layer in this slice, so
      // "log out" is necessarily "log out everywhere."
      io.in(`user:${userId}`).disconnectSockets(true);
      res.json({ ok: true });
    })
  );

  router.get(
    "/me",
    requireAuth,
    asyncHandler(async (req, res) => {
      const { rows } = await pool.query(
        `SELECT id, username, tag, avatar_url, is_admin, created_at FROM users WHERE id = $1`,
        [req.auth!.userId]
      );
      if (!rows[0]) throw new ApiError(404, "NOT_FOUND", "User not found");
      res.json({ user: rows[0] });
    })
  );

  router.patch(
    "/me",
    requireAuth,
    asyncHandler(async (req, res) => {
      const { username, avatarUrl } = req.body ?? {};
      if (username !== undefined && (typeof username !== "string" || username.trim().length === 0)) {
        throw new ApiError(422, "INVALID_REQUEST", "username must be a non-empty string");
      }
      const { rows } = await pool.query(
        `UPDATE users
            SET username = COALESCE($2, username),
                avatar_url = COALESCE($3, avatar_url)
          WHERE id = $1
        RETURNING id, username, tag, avatar_url, is_admin, created_at`,
        [req.auth!.userId, username ?? null, avatarUrl ?? null]
      );
      res.json({ user: rows[0] });
    })
  );

  return router;
}
