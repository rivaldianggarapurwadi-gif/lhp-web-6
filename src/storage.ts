import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, open, stat } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";
import { config } from "./config.js";

/**
 * Swap point for real object storage. presignUpload hands the client
 * somewhere to PUT bytes; headObject is what the server calls before
 * trusting a client-supplied storageKey on a message -- the same invariant
 * the design note calls out for real S3 (a client cannot attach a key it
 * never uploaded), just proved against local disk instead.
 */
export interface Storage {
  presignUpload(userId: string, filename: string, contentType: string): PresignedUpload;
  headObject(storageKey: string): Promise<{ exists: boolean; sizeBytes: number }>;
}

export interface PresignedUpload {
  storageKey: string;
  uploadUrl: string;
  method: "PUT";
  expiresAt: string;
}

const UPLOAD_TTL_SECONDS = 300;

function keyToPath(storageKey: string): string {
  // storageKey is server-generated (see presignUpload) and never round-trips
  // back into a path from raw user input on the upload side, but headObject
  // reads a key the caller supplies when referencing an attachment -- so
  // still refuse anything that could escape the upload root.
  const path = normalize(join(config.uploadDir, storageKey));
  if (path !== config.uploadDir && !path.startsWith(config.uploadDir + sep)) {
    throw new Error("storageKey escapes upload root");
  }
  return path;
}

function sign(storageKey: string, expiresAt: number): string {
  return createHmac("sha256", config.jwtSecret)
    .update(`${storageKey}:${expiresAt}`)
    .digest("hex");
}

export function verifyUploadSignature(storageKey: string, expiresAt: number, sig: string): boolean {
  if (Date.now() > expiresAt) return false;
  const expected = Buffer.from(sign(storageKey, expiresAt), "hex");
  const given = Buffer.from(sig, "hex");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export const localStorage: Storage = {
  presignUpload(userId, filename, _contentType) {
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-100);
    const storageKey = `${userId}/${randomUUID()}-${safeName}`;
    const expiresAt = Date.now() + UPLOAD_TTL_SECONDS * 1000;
    const sig = sign(storageKey, expiresAt);
    const uploadUrl = `${config.publicUrl}/local-storage/upload?key=${encodeURIComponent(
      storageKey
    )}&expires=${expiresAt}&sig=${sig}`;
    return { storageKey, uploadUrl, method: "PUT", expiresAt: new Date(expiresAt).toISOString() };
  },

  async headObject(storageKey) {
    try {
      const s = await stat(keyToPath(storageKey));
      return { exists: s.isFile(), sizeBytes: s.size };
    } catch {
      return { exists: false, sizeBytes: 0 };
    }
  },
};

/** Called by the PUT route itself once the signature on the URL has checked out. */
export async function writeUpload(storageKey: string, data: AsyncIterable<Buffer>): Promise<number> {
  const path = keyToPath(storageKey);
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "w");
  let size = 0;
  try {
    for await (const chunk of data) {
      await handle.write(chunk);
      size += chunk.length;
    }
  } finally {
    await handle.close();
  }
  return size;
}
