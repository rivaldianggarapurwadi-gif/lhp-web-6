import { randomInt } from "node:crypto";
import { Pool } from "pg";

// Crockford-ish, minus BOTH members of every confusable pair (O/0, I/1, L/1,
// U/V). The tempting shortcut -- excluding only the digit half of each pair,
// e.g. [2-9A-HJ-NP-TV-Z] -- quietly re-admits L. This is the alphabet the
// users_tag_format CHECK in 002_realtime.sql was written against; keep them
// in sync.
export const TAG_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
export const TAG_LENGTH = 6;
export const TAG_FORMAT = /^[2-9A-HJKMNP-TV-Z]{6}$/;

export function normalizeTag(input: string): string {
  return input.trim().toUpperCase();
}

export function isValidTagFormat(tag: string): boolean {
  return TAG_FORMAT.test(tag);
}

export function generateTag(): string {
  return Array.from({ length: TAG_LENGTH }, () => TAG_ALPHABET[randomInt(TAG_ALPHABET.length)]).join(
    ""
  );
}

/** Admin-only, low-frequency path, so a plain check-then-generate loop is
 *  fine -- no need to race INSERT against the UNIQUE constraint here. */
export async function generateUniqueTag(pool: Pool): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const tag = generateTag();
    const { rowCount } = await pool.query(`SELECT 1 FROM users WHERE tag = $1`, [tag]);
    if (rowCount === 0) return tag;
  }
  throw new Error("Could not generate a unique tag after 10 attempts");
}
