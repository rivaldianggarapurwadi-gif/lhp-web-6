-- 003_message_mutations.sql
--
-- Closes a hole in the 002 sync design.
--
-- An edit or a soft delete updates an existing row. It does not allocate a new
-- seq -- it must not, or the message would jump position in every client's
-- timeline. But that means `WHERE seq > cursor` cannot see it: a client that
-- was offline while a message was edited or deleted reconnects, backfills, and
-- still shows the stale text. Indefinitely.
--
-- The fix is a second cursor for mutations only.

BEGIN;

ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS mutated_at TIMESTAMPTZ;

-- Maintained by trigger rather than by every call site, so a new code path
-- that edits a message cannot forget to bump it.
CREATE OR REPLACE FUNCTION touch_message_mutated_at() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.content    IS DISTINCT FROM OLD.content
    OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
    OR NEW.edited_at  IS DISTINCT FROM OLD.edited_at THEN
        NEW.mutated_at = now();
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS messages_touch_mutated_at ON messages;
CREATE TRIGGER messages_touch_mutated_at
    BEFORE UPDATE ON messages
    FOR EACH ROW EXECUTE FUNCTION touch_message_mutated_at();

-- Partial: only mutated rows are ever scanned this way, and in a chat app
-- that is a small minority of the table.
CREATE INDEX IF NOT EXISTS idx_messages_mutated
    ON messages(conversation_id, mutated_at)
    WHERE mutated_at IS NOT NULL;

COMMIT;

-- ---------------------------------------------------------------------------
-- The backfill query becomes:
--
--   SELECT ... FROM messages
--    WHERE conversation_id = $1
--      AND (seq > $2 OR mutated_at > $3)
--    ORDER BY seq ASC
--    LIMIT 201;
--
-- $2 = client's contiguous seq cursor
-- $3 = client's last sync time MINUS a 60s overlap
--
-- Note why a timestamp is safe here when it was not safe for ordering.
-- The commit-visibility race still exists -- a mutation can commit after the
-- cursor was taken while carrying an earlier mutated_at. The difference is
-- what happens when you over-fetch: mutations are applied as upserts keyed by
-- message id, so re-sending one the client already has costs nothing. That
-- makes a generous overlap window a complete fix.
--
-- The ordering cursor could not use that trick, because over-fetching there
-- does not help: a missed message falls permanently outside the boundary
-- rather than merely being re-sent. Same race, opposite tolerance.
--
-- $3 comes from the SERVER's clock, returned in the previous sync ack and
-- echoed back by the client. Never trust the client's own clock for this --
-- a device 5 minutes fast silently skips 5 minutes of mutations.
-- ---------------------------------------------------------------------------
