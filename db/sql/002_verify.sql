-- =====================================================================
--  Verification for 001_mvp_schema_up.sql
--
--  Read-only. Changes nothing. Run this after the up script.
--  Every row should say PASS.
-- =====================================================================

SELECT 'users new columns' AS check_name,
       CASE WHEN COUNT(*) = 6 THEN 'PASS' ELSE 'FAIL - expected 6, got ' || COUNT(*) END AS result
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name   = 'users'
   AND column_name IN ('conversation_mode', 'last_date_curated_at', 'date_night_cadence',
                       'next_date_due_at', 'onboarding_phase', 'onboarding_completed_at')

UNION ALL
-- The client asked for onboarding_phase to hold text, not the old step number.
SELECT 'onboarding_phase is varchar',
       CASE WHEN data_type = 'character varying' THEN 'PASS' ELSE 'FAIL - is ' || data_type END
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'onboarding_phase'

UNION ALL
-- The 1..8 counter must survive under its new name. Losing it breaks onboarding.
SELECT 'legacy counter kept as onboarding_step',
       CASE WHEN COUNT(*) = 1 THEN 'PASS' ELSE 'FAIL - column missing' END
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'users'
   AND column_name = 'onboarding_step' AND data_type = 'integer'

UNION ALL
SELECT 'onboarding_phase check constraint',
       CASE WHEN COUNT(*) = 1 THEN 'PASS' ELSE 'FAIL - constraint missing' END
  FROM pg_constraint
 WHERE conname = 'users_onboarding_phase_check'

UNION ALL
SELECT 'new tables',
       CASE WHEN COUNT(*) = 3 THEN 'PASS' ELSE 'FAIL - expected 3, got ' || COUNT(*) END
  FROM pg_tables
 WHERE schemaname = 'public'
   AND tablename IN ('tasks', 'events', 'automation_logs')

UNION ALL
SELECT 'new types',
       CASE WHEN COUNT(*) = 5 THEN 'PASS' ELSE 'FAIL - expected 5, got ' || COUNT(*) END
  FROM pg_type
 WHERE typname IN ('conversation_mode', 'task_status', 'task_priority',
                   'task_category', 'automation_status')

UNION ALL
SELECT 'new indexes',
       CASE WHEN COUNT(*) = 9 THEN 'PASS' ELSE 'FAIL - expected 9, got ' || COUNT(*) END
  FROM pg_indexes
 WHERE schemaname = 'public'
   AND indexname IN ('idx_users_next_date_due_at', 'idx_users_conversation_mode',
                     'idx_users_onboarding_phase',
                     'idx_tasks_status_created_at', 'idx_tasks_user_id_created_at',
                     'idx_tasks_airtable_record_id', 'idx_events_name_timestamp',
                     'idx_events_user_id_timestamp', 'idx_automation_logs_type_timestamp')

UNION ALL
SELECT 'task triggers',
       CASE WHEN COUNT(*) = 2 THEN 'PASS' ELSE 'FAIL - expected 2, got ' || COUNT(*) END
  FROM pg_trigger
 WHERE tgname IN ('trg_tasks_updated_at', 'trg_tasks_completed_at')

UNION ALL
-- Nobody should be flipped to human review by the rollout.
SELECT 'all users still on ai mode',
       CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL - ' || COUNT(*) || ' users set to human' END
  FROM users
 WHERE conversation_mode <> 'ai'

UNION ALL
-- Every user must have a status. Existing users are seeded to 'Waitlist' so the
-- onboarding gates still apply; ops promotes individual accounts by hand.
SELECT 'every user has a status',
       CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL - ' || COUNT(*) || ' rows are NULL' END
  FROM users
 WHERE onboarding_phase IS NULL

UNION ALL
-- Nobody should have been promoted past Waitlist by the rollout itself.
SELECT 'nobody was auto-promoted',
       CASE WHEN COUNT(*) = 0 THEN 'PASS'
            ELSE 'CHECK - ' || COUNT(*) || ' users are not on Waitlist' END
  FROM users
 WHERE onboarding_phase <> 'Waitlist';
