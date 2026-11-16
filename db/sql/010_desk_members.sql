-- =====================================================================
--  Who may use the Command Center (Project 4).
--
--  Until now the dashboard's server function read the team from a secret
--  (COMMAND_CENTER_ALLOWED_EMAILS): adding a person meant editing a secret
--  in Lovable. The team now lives here and is managed from the dashboard
--  itself by an owner.
--
--  role
--    owner   reads, replies, takes over, and manages the team
--    agent   reads, replies, takes over
--    viewer  reads only
--
--  Purely additive. Safe on a live database, either side of a deploy.
--  Undo: 010_desk_members_down.sql
-- =====================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS desk_members (
  email      VARCHAR(254) PRIMARY KEY CHECK (email = lower(btrim(email)) AND email LIKE '%_@_%'),
  role       VARCHAR(16)  NOT NULL CHECK (role IN ('owner', 'agent', 'viewer')),
  added_by   VARCHAR(254),
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE desk_members IS
  'People who may use the Command Center, and what they may do. Managed from the dashboard by an owner.';

COMMIT;
