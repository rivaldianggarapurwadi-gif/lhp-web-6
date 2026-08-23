import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number
) => Promise<Buffer>;

// Node's own scrypt, not bcrypt -- zero new dependency, and this repo already
// pulls in nothing it doesn't need. Cost parameters are the scrypt defaults
// (N=16384, r=8, p=1); encoded into the hash so they can change later without
// invalidating existing rows.
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, KEYLEN);
  return `scrypt$${N}$${R}$${P}$${salt.toString("hex")}$${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, , , , saltHex, hashHex] = parts;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const derived = await scrypt(password, salt, expected.length);
  // Buffers must be equal length before comparing, or timingSafeEqual throws
  // -- and a length mismatch here means a corrupt/foreign hash, not a match.
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}
