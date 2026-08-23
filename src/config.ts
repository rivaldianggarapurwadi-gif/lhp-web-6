import { resolve } from "node:path";

const port = Number(process.env.PORT ?? 3001);

export const config = {
  pgUrl: process.env.DATABASE_URL ?? "postgres://ceko:ceko@localhost:5432/ceko",
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  port,
  jwtSecret: process.env.JWT_SECRET ?? "dev-only-not-a-real-secret",
  accessTokenTtlSeconds: Number(process.env.ACCESS_TTL ?? 900),
  refreshTokenTtlSeconds: Number(process.env.REFRESH_TTL ?? 60 * 60 * 24 * 30),
  instanceId: process.env.INSTANCE_ID ?? "api-1",
  nodeEnv: process.env.NODE_ENV ?? "development",
  // Where the local-disk storage mock writes uploaded files -- swap Storage
  // in src/storage.ts for a real S3 implementation and this stops mattering.
  uploadDir: resolve(process.env.UPLOAD_DIR ?? "./uploads"),
  // Used to build the presigned upload URL handed back to the client. In the
  // two-instance e2e cluster each instance only knows its own port, so this
  // must be set per-instance rather than guessed from the request.
  publicUrl: process.env.PUBLIC_URL ?? `http://localhost:${port}`,
  corsOrigin: process.env.CORS_ORIGIN ?? null, // null = reflect the request Origin
};
