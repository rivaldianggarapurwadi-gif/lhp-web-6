import { resolve } from "node:path";

const port = Number(process.env.PORT ?? 3001);

export const DEV_JWT_SECRET = "dev-only-not-a-real-secret";

export const config = {
  pgUrl: process.env.DATABASE_URL ?? "postgres://ceko:ceko@localhost:5432/ceko",
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  port,
  jwtSecret: process.env.JWT_SECRET ?? DEV_JWT_SECRET,
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
  // Push is additive, not load-bearing -- unset in local dev, and the app
  // still runs fine with it silently disabled. See push.ts.
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY ?? null,
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY ?? null,
  vapidSubject: process.env.VAPID_SUBJECT ?? "mailto:admin@example.com",
  // Same additive-not-load-bearing pattern as push. See email.ts.
  resendApiKey: process.env.RESEND_API_KEY ?? null,
  emailFrom: process.env.EMAIL_FROM ?? "Materi <onboarding@resend.dev>",
  // Same pattern again: unset in local dev, and call:start still runs the
  // full ring/accept/decline/timeout signaling and bookkeeping -- it just
  // can't mint a real media token, so the client learns the call has no
  // audio/video attached to it yet rather than the server refusing to ring
  // at all. See call-service.ts.
  livekitUrl: process.env.LIVEKIT_URL ?? null,
  livekitApiKey: process.env.LIVEKIT_API_KEY ?? null,
  livekitApiSecret: process.env.LIVEKIT_API_SECRET ?? null,
};
