import { Router } from "express";
import { verifyUploadSignature, writeUpload } from "../storage.js";
import { asyncHandler, ApiError } from "./middleware.js";

/**
 * Stands in for "PUT straight to S3 with a presigned URL." Not behind
 * requireAuth on purpose -- a real presigned PUT isn't either. The
 * expiring HMAC signature in the query string (minted by
 * storage.presignUpload) is what stands in for the bearer token.
 */
export function createUploadRouter(): Router {
  const router = Router();

  router.put(
    "/local-storage/upload",
    asyncHandler(async (req, res) => {
      const key = typeof req.query.key === "string" ? req.query.key : "";
      const expires = Number(req.query.expires);
      const sig = typeof req.query.sig === "string" ? req.query.sig : "";
      if (!key || !Number.isFinite(expires) || !sig || !verifyUploadSignature(key, expires, sig)) {
        throw new ApiError(403, "INVALID_UPLOAD_URL", "This upload URL is invalid or has expired");
      }
      const sizeBytes = await writeUpload(key, req);
      res.json({ storageKey: key, sizeBytes });
    })
  );

  return router;
}
