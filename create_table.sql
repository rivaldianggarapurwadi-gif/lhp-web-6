-- Run this in Supabase Dashboard → SQL Editor
CREATE TABLE IF NOT EXISTS users (
    username   TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    password   TEXT NOT NULL,
    tokens     INTEGER DEFAULT 8,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
