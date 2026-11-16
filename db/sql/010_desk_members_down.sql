-- Undo 010_desk_members.sql. DESTRUCTIVE: drops the Command Center team list.
BEGIN;
DROP TABLE IF EXISTS desk_members;
COMMIT;
