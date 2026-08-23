-- Chat app schema (PostgreSQL)

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TYPE conversation_type AS ENUM ('dm', 'group');
CREATE TYPE message_type AS ENUM ('text', 'image', 'file', 'system');
CREATE TYPE contact_status AS ENUM ('pending', 'accepted', 'blocked');
CREATE TYPE call_type AS ENUM ('voice', 'video');
CREATE TYPE call_status AS ENUM ('ringing', 'active', 'ended', 'missed');

-- Accounts are created by an admin, not self-registered.
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(32) NOT NULL,
    tag VARCHAR(8) NOT NULL UNIQUE,          -- the short code used to find this user
    password_hash TEXT NOT NULL,
    avatar_url TEXT,
    is_admin BOOLEAN NOT NULL DEFAULT FALSE,
    created_by UUID REFERENCES users(id),    -- which admin created this account
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_users_tag ON users(tag);

-- Friend/contact requests, initiated via tag lookup.
CREATE TABLE contacts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    requester_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    addressee_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status contact_status NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    responded_at TIMESTAMPTZ,
    UNIQUE (requester_id, addressee_id),
    CHECK (requester_id <> addressee_id)
);
CREATE INDEX idx_contacts_addressee ON contacts(addressee_id, status);

-- A conversation is either a 1:1 DM or a group chat.
CREATE TABLE conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type conversation_type NOT NULL,
    name VARCHAR(100),                       -- used for group chats only
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE conversation_participants (
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_read_message_id UUID,
    PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX idx_conv_participants_user ON conversation_participants(user_id);

CREATE TABLE messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id UUID NOT NULL REFERENCES users(id),
    type message_type NOT NULL DEFAULT 'text',
    content TEXT,
    reply_to_message_id UUID REFERENCES messages(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    edited_at TIMESTAMPTZ,
    deleted_at TIMESTAMPTZ                   -- soft delete
);
CREATE INDEX idx_messages_conversation ON messages(conversation_id, created_at DESC);

CREATE TABLE attachments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    file_type VARCHAR(50),
    file_size_bytes BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A call is an event that happens inside an existing conversation.
CREATE TABLE calls (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    type call_type NOT NULL,
    status call_status NOT NULL DEFAULT 'ringing',
    started_by UUID NOT NULL REFERENCES users(id),
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at TIMESTAMPTZ
);

CREATE TABLE call_participants (
    call_id UUID NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at TIMESTAMPTZ,
    left_at TIMESTAMPTZ,
    PRIMARY KEY (call_id, user_id)
);
