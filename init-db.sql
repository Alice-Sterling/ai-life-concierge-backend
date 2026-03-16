-- Ai Life Concierge - PostgreSQL schema
-- Run this once against your database (e.g. Railway PostgreSQL)

-- Tier enum for user subscription level
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_tier') THEN
        CREATE TYPE user_tier AS ENUM ('lite', 'pro');
    END IF;
END $$;

-- Users table (user_tier ENUM and metadata on conversations ensured below)
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name VARCHAR(255),
  last_name VARCHAR(255),
  phone_number VARCHAR(50) NOT NULL UNIQUE,
  email VARCHAR(255),
  client_id VARCHAR(255) UNIQUE,
  tier user_tier NOT NULL DEFAULT 'lite',
  last_nudge_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Add last_nudge_at if table already existed without it
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'last_nudge_at'
  ) THEN
    ALTER TABLE users ADD COLUMN last_nudge_at TIMESTAMPTZ;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone_number);
CREATE INDEX IF NOT EXISTS idx_users_client_id ON users(client_id);
CREATE INDEX IF NOT EXISTS idx_users_last_nudge_at ON users(last_nudge_at);

-- Conversations table (message + AI response per exchange)
CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_body TEXT NOT NULL,
  ai_response TEXT,
  metadata JSONB DEFAULT '{}',
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON conversations(user_id);
CREATE INDEX IF NOT EXISTS idx_conversations_timestamp ON conversations(timestamp);
