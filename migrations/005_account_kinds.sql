-- 005_account_kinds.sql
--
-- Two account kinds with genuinely different session/history semantics.
--
-- 'ceko' keeps today's behavior exactly: persistent refresh-token session,
-- history never cleared. 'taruna' is for accounts sharing a limited pool of
-- devices -- every login wipes the account's conversation membership and
-- contacts (never the underlying messages/conversations themselves, so the
-- other side's history is untouched), and no refresh token is ever issued,
-- so a page refresh or tab close forces a real re-login.
--
-- pending_release_seq is what lets a message survive that wipe instead of
-- vanishing: when a Taruna re-joins a DM that already has messages, this is
-- set to the conversation's last_seq at that moment, and history/backfill
-- hide everything at or before it until the Taruna explicitly asks for the
-- backlog (POST /conversations/:id/request-pending clears it back to NULL).
-- NULL here is a no-op everywhere -- every row today, and every Ceko row
-- ever, so this is purely additive to the existing message path.

BEGIN;

CREATE TYPE account_kind AS ENUM ('ceko', 'taruna');

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS account_kind account_kind NOT NULL DEFAULT 'ceko';

ALTER TABLE conversation_participants
    ADD COLUMN IF NOT EXISTS pending_release_seq BIGINT;

COMMIT;
