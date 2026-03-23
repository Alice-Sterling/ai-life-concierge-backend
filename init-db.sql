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
  trial_start_date TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  subscription_status TEXT NOT NULL DEFAULT 'LITE',
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

-- trial_start_date & subscription_status (for existing deployments)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'trial_start_date'
  ) THEN
    ALTER TABLE users ADD COLUMN trial_start_date TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'subscription_status'
  ) THEN
    ALTER TABLE users ADD COLUMN subscription_status TEXT DEFAULT 'LITE';
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

-- Create the Black Book (Recommendations) Table
CREATE TABLE IF NOT EXISTS recommendations (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT, -- e.g., 'Dining', 'Gifting', 'Services'
    location TEXT,
    booking_url TEXT,
    description TEXT,
    vibe_tags TEXT[] -- e.g., ARRAY['quiet', 'business', 'high-energy']
);

-- Ensure seed inserts remain idempotent
CREATE UNIQUE INDEX IF NOT EXISTS idx_recommendations_name_location ON recommendations(name, location);

-- Add a GIN index to vibe_tags for ultra-fast array searching
CREATE INDEX IF NOT EXISTS idx_recommendations_vibe_tags ON recommendations USING GIN (vibe_tags);

-- Seed with your first Vetted Recommendation (Example)
INSERT INTO recommendations (name, category, location, booking_url, description, vibe_tags)
VALUES (
    'Park Chinois',
    'Dining',
    'Mayfair',
    'https://parkchinois.com/reservations/',
    'Opulent 1930s Shanghai-style dining with live entertainment. Perfect for high-impact business dinners.',
    ARRAY['high-energy', 'business', 'opulent']
)
ON CONFLICT (name, location) DO NOTHING;
