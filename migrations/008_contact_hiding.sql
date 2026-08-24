-- 008_contact_hiding.sql
--
-- A `contacts` row is one relationship shared by both sides, not two
-- independent per-user records (see taruna.ts) -- so "wipe this Taruna's
-- contacts on login" can never mean deleting the row: that would erase it
-- from the other side's contact list too. These two flags let each side
-- independently hide an *accepted* contact from their own list without
-- touching the shared row or the other side's view at all.
--
-- Every Taruna login sets the flag on that user's own side for every
-- accepted contact; the same "re-add by tag" flow already used to reopen a
-- wiped conversation clears it again (see social-routes.ts POST /contacts).

BEGIN;

ALTER TABLE contacts
    ADD COLUMN IF NOT EXISTS requester_hidden BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS addressee_hidden BOOLEAN NOT NULL DEFAULT false;

COMMIT;
