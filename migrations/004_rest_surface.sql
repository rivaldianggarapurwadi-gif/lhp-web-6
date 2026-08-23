-- 004_rest_surface.sql
--
-- Refresh token storage for the REST auth surface.
--
-- Tokens are opaque random values; only their hash is ever persisted, so a
-- stolen database dump does not hand out live sessions. Rotation is a chain:
-- every token descended from one login shares family_id. Reusing a token
-- that has already been rotated away (rotated_at set) is the signature of
-- theft -- a stolen refresh token being replayed after the legitimate client
-- already rotated past it -- so the caller bumps session_version and revokes
-- the whole family, not just the one row.

BEGIN;

CREATE TABLE IF NOT EXISTS refresh_tokens (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  TEXT NOT NULL UNIQUE,
    family_id   UUID NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    rotated_at  TIMESTAMPTZ,
    revoked_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_family ON refresh_tokens(family_id);

COMMIT;
