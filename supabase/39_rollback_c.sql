-- ============================================================================
-- 39_rollback_c.sql  (Bundle C)  -  undo 30_c_sync.sql
-- ----------------------------------------------------------------------------
-- Removes app_sync and its helper. The app notices and goes back to app_get
-- (the full download) by itself - nothing else to change. Safe to run twice.
-- Result: "Success. No rows returned".
-- ============================================================================
drop function if exists public.app_sync(uuid, text, text, text, jsonb);
drop function if exists public.sync_months(jsonb, jsonb);
