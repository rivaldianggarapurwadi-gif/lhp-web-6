import type { Request, Response, NextFunction, RequestHandler } from "express";
import { authenticate } from "../auth.js";
import { SendError } from "../message-service.js";
import { RefreshTokenError } from "../refresh-token.js";
import { config } from "../config.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: { userId: string; exp: number; isAdmin: boolean; accountKind: "ceko" | "taruna" };
    }
  }
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

/** Same {code,message} shapes SendError/RefreshTokenError already use
 *  internally -- mapped to HTTP status here rather than duplicated as
 *  ApiErrors at every call site. */
const KNOWN_ERROR_STATUS: Record<string, number> = {
  UNAUTHORIZED: 401,
  INVALID_TOKEN: 401,
  TOKEN_REUSE_DETECTED: 401,
  NOT_A_PARTICIPANT: 403,
  FORBIDDEN: 403,
  CONVERSATION_NOT_FOUND: 404,
  NOT_FOUND: 404,
  EMPTY_MESSAGE: 422,
  MESSAGE_TOO_LONG: 422,
  REPLY_TARGET_INVALID: 422,
};

// Express 5 catches rejected handler promises on its own; this wrapper is
// kept anyway so a downgrade or a stray callback-style bug doesn't silently
// hang a request instead of erroring.
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export const requireAuth: RequestHandler = asyncHandler(async (req, _res, next) => {
  const header = req.header("authorization") ?? "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) {
    throw new ApiError(401, "UNAUTHORIZED", "Token tidak ditemukan");
  }
  try {
    req.auth = await authenticate(token);
  } catch {
    throw new ApiError(401, "UNAUTHORIZED", "Token tidak valid atau sudah kedaluwarsa");
  }
  next();
});

export const requireAdmin: RequestHandler = (req, _res, next) => {
  if (!req.auth?.isAdmin) return next(new ApiError(403, "FORBIDDEN", "Khusus admin"));
  next();
};

/** Wildcard socket.io CORS is fine for a token-in-header socket handshake,
 *  but credentialed cookie requests (the refresh cookie) cannot use
 *  Access-Control-Allow-Origin: * -- the origin must be echoed back
 *  explicitly. CORS_ORIGIN pins it in real deployments; unset reflects
 *  whatever Origin the request sent, which is fine for this slice. */
export const cors: RequestHandler = (req, res, next) => {
  const origin = config.corsOrigin ?? req.header("origin");
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
  }
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,PUT,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
    res.status(204).end();
    return;
  }
  next();
};

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  if (err instanceof SendError || err instanceof RefreshTokenError) {
    const status = KNOWN_ERROR_STATUS[err.code] ?? 400;
    return res.status(status).json({ error: { code: err.code, message: err.message } });
  }
  // express.json()'s own parse failure -- a body the client sent, not a
  // server fault, so it belongs in the 4xx range.
  if (err instanceof SyntaxError && "body" in err) {
    return res.status(400).json({ error: { code: "INVALID_JSON", message: "Format JSON tidak valid" } });
  }
  console.error("[http]", err);
  res.status(500).json({ error: { code: "INTERNAL", message: "Terjadi kesalahan" } });
}
