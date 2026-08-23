import express, { type Express } from "express";
import type { Pool } from "pg";
import type { Redis } from "ioredis";
import type { Server } from "socket.io";
import { config } from "../config.js";
import { cors, errorHandler } from "./middleware.js";
import { createAuthRouter } from "./auth-routes.js";
import { createAdminRouter } from "./admin-routes.js";
import { createSocialRouter } from "./social-routes.js";
import { createConversationRouter } from "./conversation-routes.js";
import { createUploadRouter } from "./upload-routes.js";

export function createApp(pool: Pool, redis: Redis, io: Server): Express {
  const app = express();

  app.get("/health", (_req, res) => res.json({ ok: true, instance: config.instanceId }));

  app.use(cors);
  // The upload PUT route reads the raw request stream itself (see
  // upload-routes.ts) and must not have express.json() consume it first --
  // harmless here anyway, since express.json() only parses bodies whose
  // Content-Type is application/json and leaves everything else untouched.
  app.use(createUploadRouter());

  app.use(express.json({ limit: "1mb" }));
  app.use(createAuthRouter(pool, redis, io));
  app.use(createAdminRouter(pool, io));
  app.use(createSocialRouter(pool, redis, io));
  app.use(createConversationRouter(pool, redis, io));

  app.use((_req, res) => {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "No such route" } });
  });
  app.use(errorHandler);

  return app;
}
