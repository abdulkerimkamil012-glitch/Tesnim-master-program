-- ============================================================================
-- 29_rollback_b2.sql  (Part B2)  -  undo 20_b2_guards.sql
-- ----------------------------------------------------------------------------
-- Puts the OLD app_put and app_login back under their own names (with the
-- same open permissions they had before), and removes the delete lock, the
-- login speed limit and its notebook table. B1 (the Dashboard engine) stays.
-- Safe to run twice. Result: "Success. No rows returned".
-- ============================================================================

do $rollback$
begin
  -- app_put: only if the old one is still waiting under its private name
  if to_regprocedure('public._app_put_core(uuid, jsonb, jsonb)') is not null then
    drop function if exists public.app_put(uuid, jsonb, jsonb);          -- the B2 wrapper
    alter function public._app_put_core(uuid, jsonb, jsonb) rename to app_put;
    grant execute on function public.app_put(uuid, jsonb, jsonb) to public, anon, authenticated;
  end if;

  -- app_login: the same
  if to_regprocedure('public._app_login_core(text, text)') is not null then
    drop function if exists public.app_login(text, text);                -- the B2 wrapper
    alter function public._app_login_core(text, text) rename to app_login;
    grant execute on function public.app_login(text, text) to public, anon, authenticated;
  end if;
end
$rollback$;

drop function if exists public.del_guard(jsonb, jsonb);
drop function if exists public.del_allowed(app_users);
drop function if exists public.del_cat_key(text);
drop function if exists public.login_fail(text, int);
drop function if exists public.login_ip();
drop table if exists public.app_login_fails;
