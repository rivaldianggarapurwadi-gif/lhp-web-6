import { createServer } from "node:http";
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { Redis } from "ioredis";
import { config } from "./config.js";
import { pool } from "./db.js";
import { attachSocketHandlers } from "./socket.js";
import { createApp } from "./http/app.js";

async function main() {
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

  await new Promise<void>((resolve) => http.listen(config.port, resolve));
  console.log(`[${config.instanceId}] listening on ${config.port}`);

  const shutdown = async () => {
    await io.close();
    await Promise.all([pub.quit(), sub.quit(), cache.quit()]);
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => { console.error(err); process.exit(1); });
