-- =====================================================================
--  STEP 2 of 2 - FINALIZE.  Run this AFTER the new code is deployed.
--
--  Safe to run while the NEW code is live and serving traffic. By this
--  point nothing reads or writes the old INTEGER onboarding_phase: the new
--  code uses onboarding_step for the counter.
--
--  This retires the integer column and rebuilds onboarding_phase as the
--  Airtable status field.
--
--  Do NOT run this before the deploy. The old code still writes integers
--  into onboarding_phase and would start erroring against the CHECK.
--
--  Safe to run more than once.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- Close the gap.
--
-- Between 001a and the deploy, the old code may have advanced the integer
-- onboarding_phase for a user mid-onboarding. Copy those last few writes
-- across before the column goes away, so nobody loses their place.
-- ---------------------------------------------------------------------
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'users'
       AND column_name = 'onboarding_phase' AND data_type = 'integer')
  THEN
    UPDATE users
       SET onboarding_step = GREATEST(COALESCE(onboarding_step, 1),
                                      COALESCE(onboarding_phase, 1));

    ALTER TABLE users DROP COLUMN onboarding_phase;
  END IF;
END $$;


-- ---------------------------------------------------------------------
-- onboarding_phase, reborn as the Airtable status.
--
-- Every existing user starts on 'Waitlist' so the onboarding gates still
-- apply; nobody is mass-promoted. Ops promotes accounts by hand.
-- ---------------------------------------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_phase VARCHAR(32) NOT NULL DEFAULT 'Waitlist';

-- A CHECK, not an ENUM: Airtable single-select options change, and widening
-- a CHECK is a one-line change where widening an ENUM is a migration.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_onboarding_phase_check') THEN
    ALTER TABLE users ADD CONSTRAINT users_onboarding_phase_check
      CHECK (onboarding_phase IN
             ('Waitlist', 'Approved', 'Denied', 'Onboarded', 'Active', 'Inactive'));
  END IF;
END $$;

COMMENT ON COLUMN users.onboarding_phase IS
  'Mirrors the Airtable status single-select. Enforced by users_onboarding_phase_check.';

CREATE INDEX IF NOT EXISTS idx_users_onboarding_phase ON users (onboarding_phase);

COMMIT;
