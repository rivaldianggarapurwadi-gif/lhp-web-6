-- 002_realtime.sql
-- Schema changes the realtime delivery design depends on.
-- Safe to run against the existing schema in 001. Idempotent where practical.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Users: soft-disable + token revocation
--
-- messages.sender_id has no ON DELETE clause, so a user who has ever sent a
-- message can never be DELETEd. For an admin-managed system that is the right
-- default -- but it means "remove this account" has to be a soft disable.
-- session_version is bumped to invalidate every outstanding access token and
-- to kick live sockets (see the auth section of the design doc).
-- ---------------------------------------------------------------------------
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS disabled_at      TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS session_version  INTEGER NOT NULL DEFAULT 1;

-- users.updated_at defaults to now() but nothing ever moves it.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS users_set_updated_at ON users;
CREATE TRIGGER users_set_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Tag lookups normalise to upper case; enforce the stored form matches the
-- generator's alphabet so a malformed row can never be created by hand.
ALTER TABLE users
    ADD CONSTRAINT users_tag_format
    CHECK (tag ~ '^[2-9A-HJKMNP-TV-Z]{6}$');   -- 2-9 and A-Z less I, L, O, U

-- ---------------------------------------------------------------------------
-- 2. Conversations: per-conversation sequence counter, DM identity, sort key
--
-- last_seq is the allocator for messages.seq. Incrementing it takes a row lock
-- on the conversation, which is exactly the serialisation point we want: seq
-- order == commit order, with no gaps.
--
-- dm_key makes "the DM between A and B" a unique, lookup-able thing so that
-- POST /conversations is idempotent. Format: least(uuid)::text || ':' || greatest(uuid)::text
-- ---------------------------------------------------------------------------
ALTER TABLE conversations
    ADD COLUMN IF NOT EXISTS last_seq         BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_message_at  TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS dm_key           TEXT;

ALTER TABLE conversations
    ADD CONSTRAINT conversations_dm_key_required
    CHECK (type <> 'dm' OR dm_key IS NOT NULL);

ALTER TABLE conversations
    ADD CONSTRAINT conversations_group_name_required
    CHECK (type <> 'group' OR name IS NOT NULL);

CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_dm_key
    ON conversations(dm_key) WHERE type = 'dm';

-- Conversation list ordering ("most recent first") without touching messages.
CREATE INDEX IF NOT EXISTS idx_conversations_recent
    ON conversations(last_message_at DESC NULLS LAST);

-- ---------------------------------------------------------------------------
-- 3. Messages: ordering key + send idempotency
--
-- seq: gapless, monotonic, per conversation. This is what pagination cursors,
--      reconnect backfill and read receipts all key off. created_at cannot do
--      this job -- now() is transaction-start time, so two overlapping inserts
--      can commit in the opposite order to their timestamps, and a client
--      backfilling "everything after <timestamp>" would silently skip one.
--
-- client_message_id: supplied by the sender before the request goes out. If the
--      socket drops after the INSERT commits but before the ack is delivered,
--      the client retries and the unique constraint turns the retry into a
--      lookup instead of a duplicate message.
-- ---------------------------------------------------------------------------
ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS seq                BIGINT,
    ADD COLUMN IF NOT EXISTS client_message_id  UUID;

-- Backfill seq for any rows that already exist, ordered by their timestamp.
WITH numbered AS (
    SELECT id,
           row_number() OVER (PARTITION BY conversation_id
                              ORDER BY created_at, id) AS rn
    FROM messages
    WHERE seq IS NULL
)
UPDATE messages m
SET seq = numbered.rn
FROM numbered
WHERE m.id = numbered.id;

-- Move each conversation's counter past whatever was just backfilled.
UPDATE conversations c
SET last_seq = COALESCE(
        (SELECT max(seq) FROM messages m WHERE m.conversation_id = c.id), 0),
    last_message_at = (
        SELECT max(created_at) FROM messages m WHERE m.conversation_id = c.id);

ALTER TABLE messages ALTER COLUMN seq SET NOT NULL;

ALTER TABLE messages
    ADD CONSTRAINT messages_conversation_seq_key UNIQUE (conversation_id, seq);

ALTER TABLE messages
    ADD CONSTRAINT messages_client_id_key UNIQUE (conversation_id, client_message_id);

-- A text message with no body is not a thing -- except once it is soft-deleted,
-- at which point the body is blanked deliberately.
ALTER TABLE messages
    ADD CONSTRAINT messages_text_has_content
    CHECK (type <> 'text' OR content IS NOT NULL OR deleted_at IS NOT NULL);

-- A reply must point at a message, not at itself.
ALTER TABLE messages
    ADD CONSTRAINT messages_no_self_reply
    CHECK (reply_to_message_id IS NULL OR reply_to_message_id <> id);

-- History pagination and backfill are both keyset scans on seq, so this is the
-- index that matters now. The created_at index is no longer on any hot path.
CREATE INDEX IF NOT EXISTS idx_messages_conversation_seq
    ON messages(conversation_id, seq DESC);
DROP INDEX IF EXISTS idx_messages_conversation;

-- ---------------------------------------------------------------------------
-- 4. Read state as a comparable value
--
-- last_read_message_id is a UUID, and UUIDs do not order meaningfully -- so an
-- unread count needs a correlated subquery to resolve the pointer to a
-- timestamp first, and it breaks outright if that message is ever hard-deleted.
-- last_read_seq answers "how many unread" with a plain integer comparison.
-- ---------------------------------------------------------------------------
ALTER TABLE conversation_participants
    ADD COLUMN IF NOT EXISTS last_read_seq BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS muted_until   TIMESTAMPTZ;

UPDATE conversation_participants cp
SET last_read_seq = COALESCE(m.seq, 0)
FROM messages m
WHERE m.id = cp.last_read_message_id
  AND cp.last_read_seq = 0;

ALTER TABLE conversation_participants DROP COLUMN IF EXISTS last_read_message_id;

-- ---------------------------------------------------------------------------
-- 5. Contacts: the missing half of the index, and 'declined'
--
-- Listing "my contacts" is (requester_id = me OR addressee_id = me), but only
-- the addressee side was indexed, so half of every contact list query was a
-- sequential scan.
--
-- 'declined' is kept as a row rather than deleting it, so a declined request
-- cannot be immediately re-sent in a loop.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_contacts_requester
    ON contacts(requester_id, status);

ALTER TYPE contact_status ADD VALUE IF NOT EXISTS 'declined';

-- ---------------------------------------------------------------------------
-- 6. Blocks live outside the friendship row
--
-- Overloading contacts.status with 'blocked' destroys the friendship state it
-- overwrites, and it can only record a block in the direction the original
-- request happened to run. A block is its own directed fact.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS blocks (
    blocker_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (blocker_id, blocked_id),
    CHECK (blocker_id <> blocked_id)
);
CREATE INDEX IF NOT EXISTS idx_blocks_blocked ON blocks(blocked_id);

-- ---------------------------------------------------------------------------
-- 7. Calls: one live call per conversation
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS idx_calls_one_live_per_conversation
    ON calls(conversation_id) WHERE status IN ('ringing', 'active');

CREATE INDEX IF NOT EXISTS idx_calls_conversation_started
    ON calls(conversation_id, started_at DESC);

-- The SFU room name is minted server-side and stored, so a client can never
-- name its own room and join someone else's call.
ALTER TABLE calls
    ADD COLUMN IF NOT EXISTS sfu_room_name TEXT;

-- ---------------------------------------------------------------------------
-- 8. Attachments: store the key, not a URL
--
-- A public URL in the database is a public URL forever. Storing the object key
-- lets the API mint a short-lived signed GET at read time instead.
-- ---------------------------------------------------------------------------
ALTER TABLE attachments
    ADD COLUMN IF NOT EXISTS storage_key TEXT;

UPDATE attachments SET storage_key = url WHERE storage_key IS NULL;

ALTER TABLE attachments ALTER COLUMN storage_key SET NOT NULL;
ALTER TABLE attachments ALTER COLUMN url DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);

COMMIT;
