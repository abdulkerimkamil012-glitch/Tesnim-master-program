-- ============================================================================
-- 19_rollback_dash.sql  (Part B1)  -  take the Dashboard engine away again
-- ----------------------------------------------------------------------------
-- Removes ONLY what Part B1 added:
--   * every function whose name starts with dash_
--   * the two doors app_dash and app_dash_restart
--   * the table app_dash_marks (the restart notebook; its lines are lost)
-- It does NOT touch app_users, app_shared, app_log, app_mine, app_sessions,
-- app_config, or any older function (admin_*, app_get, app_login, app_put,
-- app_put_log, _me, app_today). Safe to run twice.
-- ============================================================================

-- 1) Remove the new functions (found by name, so nothing has to be typed by hand).
do $rollback$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and (p.proname like 'dash\_%' or p.proname in ('app_dash', 'app_dash_restart'))
  loop
    execute format('drop function if exists %s', r.sig);
  end loop;
end
$rollback$;

-- 2) Remove the restart notebook.
drop table if exists public.app_dash_marks;
