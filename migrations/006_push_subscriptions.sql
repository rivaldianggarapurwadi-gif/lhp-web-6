-- 006_push_subscriptions.sql
--
-- Web Push subscriptions -- what lets the server notify a Ceko account with
-- no tab open and no live socket. Ceko only: a subscription is itself a
-- standing record tying a device to an account, which is exactly the kind
-- of trace a Taruna session is built never to leave. The app layer refuses
-- to create one for a Taruna account; nothing in this table stops it, but
-- nothing ever calls it for one either.

BEGIN;

CREATE TABLE IF NOT EXISTS push_subscriptions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint    TEXT NOT NULL UNIQUE,
    p256dh      TEXT NOT NULL,
    auth        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);

COMMIT;
