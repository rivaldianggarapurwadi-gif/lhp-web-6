import { createServer } from "node:http";
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { Redis } from "ioredis";
import { config, DEV_JWT_SECRET } from "./config.js";
import { pool } from "./db.js";
import { attachSocketHandlers, runPresenceSweep } from "./socket.js";
import { createApp } from "./http/app.js";
import { SWEEP_INTERVAL_MS } from "./presence.js";

async function main() {
  // Refuse to boot with a public-facing deployment signing tokens on a
  // secret that's checked into every README and Docker image ever built
  // from this repo. Better to fail loudly at startup than silently issue
  // forgeable access tokens in production.
  if (config.nodeEnv === "production" && config.jwtSecret === DEV_JWT_SECRET) {
    console.error("JWT_SECRET must be set to a real secret when NODE_ENV=production.");
    process.exit(1);
  }

  const http = createServer();

  // Constructed without a server yet -- io.attach(http) happens further
  // down, *after* the Express app is registered as http's request listener.
  // Engine.io's attach() snapshots whatever request listeners already exist
  // and wraps them as its fallback for non-socket.io paths; attach it before
  // the Express app exists and REST requests have nothing to fall through
  // to. The routers below need `io` itself (to call things like
  // io.in(room).disconnectSockets()), which is why it's constructed early
  // and attached late rather than passed straight to createServer().
  const io = new Server({
    transports: ["websocket"], // no polling => no sticky sessions required
    cors: { origin: "*" },
  });

  // Three separate connections on purpose. A Redis client in subscriber mode
  // cannot issue ordinary commands, so the adapter's pub/sub pair must not be
  // the same client used for the participant cache.
  const pub = new Redis(config.redisUrl);
  const sub = pub.duplicate();
  const cache = new Redis(config.redisUrl);

  io.adapter(createAdapter(pub, sub));
  attachSocketHandlers(io, cache);

  const app = createApp(pool, cache, io);
  http.on("request", app);
  io.attach(http);

  // Every instance runs this; presence.ts's lock ensures only one of them
  // actually performs a given tick's eviction and fan-out.
  const sweepTimer = setInterval(() => void runPresenceSweep(io, cache), SWEEP_INTERVAL_MS);

  await new Promise<void>((resolve) => http.listen(config.port, resolve));
  console.log(`[${config.instanceId}] listening on ${config.port}`);

  const shutdown = async () => {
    clearInterval(sweepTimer);
    await io.close();
    await Promise.all([pub.quit(), sub.quit(), cache.quit()]);
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => { console.error(err); process.exit(1); });
