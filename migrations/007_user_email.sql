-- 007_user_email.sql
--
-- An optional email address per account, for the email notification
-- channel (src/email.ts). Nullable and unvalidated at the DB layer --
-- format checking happens in the REST route, same division of labor as
-- everything else here.

BEGIN;

ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;

COMMIT;
