import type { Redis } from "ioredis";

export interface RateLimitWindow {
  /** e.g. "burst" or "sustained" -- just used to namespace the Redis key. */
  name: string;
  windowSeconds: number;
  max: number;
}

/**
 * Fixed-window counter, one key per (bucket, window). Not sliding, not
 * leaky-bucket -- a burst right at a window boundary can technically let
 * through close to 2x max. That imprecision is fine here: this guards an
 * enumeration surface and a login endpoint, not a billing meter.
 */
export async function checkRateLimit(
  redis: Redis,
  bucket: string,
  windows: RateLimitWindow[]
): Promise<{ allowed: boolean; retryAfterSeconds?: number }> {
  for (const w of windows) {
    const key = `ratelimit:${w.name}:${bucket}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, w.windowSeconds);
    if (count > w.max) {
      const ttl = await redis.ttl(key);
      return { allowed: false, retryAfterSeconds: ttl > 0 ? ttl : w.windowSeconds };
    }
  }
  return { allowed: true };
}
