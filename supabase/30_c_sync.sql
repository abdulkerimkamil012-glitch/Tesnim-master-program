-- ============================================================================
-- 30_c_sync.sql  (Bundle C)  -  "send me only what changed"
-- ----------------------------------------------------------------------------
-- Paste the WHOLE file into Supabase > SQL Editor and press Run, once.
-- At the end it tests itself. You should see ONE result row: ALL PASS
-- If you see a red error instead, NOTHING was changed. Copy the error and send it to me.
--
-- What it does, in plain words
--   Before: every minute each phone downloaded EVERYTHING (all activities, all pages, the whole tick
--   history since day one) just to see whether anything had changed.
--   Now: the phone says what it already has - three version numbers and one short fingerprint per
--   month of ticks - and app_sync answers with ONLY:
--     * the activity / page / bin list - only if it changed,
--     * the user's own settings          - only if they changed,
--     * the months of ticks that changed - only those months (plus the list of month fingerprints).
--   When nothing changed the answer is a few hundred bytes.
--
-- How it works without knowing your old tables: app_sync asks your existing app_get for the full
-- answer ON THE SERVER (so every rule app_get has - who may see what - still applies), and then only
-- sends the phone the parts that are new. app_get itself is not changed.
--
-- Safe to run twice. To undo: 39_rollback_c.sql (the app then simply uses app_get again).
-- Needs B1 (11_dash_functions.sql) for two small helpers.
-- ============================================================================

begin;   -- everything below is ONE step: all or nothing

do $need$
begin
  if to_regprocedure('public.dash_json(jsonb)') is null or to_regprocedure('public.dash_obj(jsonb)') is null then
    raise exception 'B1 is missing: run 10_dash_tables.sql and 11_dash_functions.sql first';
  end if;
  if to_regprocedure('public.app_get(uuid)') is null then
    raise exception 'app_get(uuid) not found - send this message to me';
  end if;
end
$need$;


-- ---------------------------------------------------------------------------
-- 1) THE MONTH SPLITTER (pure: reads no table, so it is tested below).
--    p_log  = the whole tick history {"2026-10-18": {...}, ...}
--    p_have = the fingerprints the phone already has {"2026-10": "<md5>", ...} (null = none)
--    Returns {"hashes": {every month: fingerprint}, "months": {only the months whose fingerprint differs: their days}}
--    A key that is not a date (should never happen) goes into the month "_".
-- ---------------------------------------------------------------------------
create or replace function public.sync_months(p_log jsonb, p_have jsonb)
returns jsonb
language sql stable
set search_path to 'public', 'extensions'
as $f$
  with d as (
    select case when e.key ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then left(e.key, 7) else '_' end as m, e.key as k, e.value as v
      from jsonb_each(public.dash_obj(public.dash_json(p_log))) as e
  ),
  g as (
    select d.m, jsonb_object_agg(d.k, d.v) as days from d group by d.m
  ),
  h as (
    select g.m, g.days, md5(g.days::text) as fp from g
  )
  select jsonb_build_object(
    'hashes', coalesce((select jsonb_object_agg(h.m, h.fp) from h), '{}'::jsonb),
    'months', coalesce((select jsonb_object_agg(h.m, h.days) from h
                         where p_have is null or jsonb_typeof(p_have) <> 'object' or (p_have ->> h.m) is distinct from h.fp), '{}'::jsonb))
$f$;


-- ---------------------------------------------------------------------------
-- 2) THE DOOR FOR THE APP:  app_sync(token, sv, mv, lv, month fingerprints)
--    sv / mv / lv = the version numbers the phone has (as text; null = "I have nothing").
--    Always returns: user, sv, mv, lv.
--    Adds "shared" only when sv differs, "mine" only when mv differs, and
--    "hashes" + "months" only when lv differs (only the changed months inside).
--    A bad token gives the same 'auth' error as app_get.
-- ---------------------------------------------------------------------------
create or replace function public.app_sync(
  p_tok    uuid,
  p_sv     text  default null,
  p_mv     text  default null,
  p_lv     text  default null,
  p_months jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $f$
declare
  g   jsonb;
  res jsonb;
begin
  select to_jsonb(r) into g from public.app_get(p_tok) r;   -- all of app_get's own checks happen here
  if g is null or jsonb_typeof(g) <> 'object' then raise exception 'auth'; end if;

  res := jsonb_build_object('user', g -> 'user', 'sv', g -> 'sv', 'mv', g -> 'mv', 'lv', g -> 'lv');

  if p_sv is null or (g ->> 'sv') is distinct from p_sv then
    res := res || jsonb_build_object('shared', coalesce(g -> 'shared', '{}'::jsonb));
  end if;
  if p_mv is null or (g ->> 'mv') is distinct from p_mv then
    res := res || jsonb_build_object('mine', coalesce(g -> 'mine', '{}'::jsonb));
  end if;
  if p_lv is null or (g ->> 'lv') is distinct from p_lv then
    res := res || public.sync_months(g -> 'log', p_months);
  end if;
  return res;
end
$f$;


-- ---------------------------------------------------------------------------
-- 3) LOCK THE DOORS: the splitter is private; only app_sync can be called from outside.
-- ---------------------------------------------------------------------------
revoke all on function public.sync_months(jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.app_sync(uuid, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.app_sync(uuid, text, text, text, jsonb) to anon, authenticated;


-- ---------------------------------------------------------------------------
-- 4) SELF-TEST (made-up data only; touches no table).
-- ---------------------------------------------------------------------------
do $selftest$
declare
  lg  jsonb := '{"2026-09-30":{"a":true},"2026-10-01":{"a":{"r":"x"}},"2026-10-18":{"a":true,"b":{"r":"p","p":60}}}';
  r   jsonb; r2 jsonb; r3 jsonb;
begin
  -- 1) the phone has nothing: every month comes, with a fingerprint each
  r := public.sync_months(lg, null);
  if (select count(*) from jsonb_object_keys(r -> 'hashes')) <> 2 or (select count(*) from jsonb_object_keys(r -> 'months')) <> 2 then
    raise exception 'SELFTEST FAILED: 1 expected 2 months, got %', r;
  end if;
  if r -> 'months' -> '2026-10' -> '2026-10-18' -> 'b' <> '{"r":"p","p":60}'::jsonb then raise exception 'SELFTEST FAILED: 2 day content lost'; end if;

  -- 2) the phone already has both months: nothing is sent, fingerprints still are
  r2 := public.sync_months(lg, r -> 'hashes');
  if r2 -> 'months' <> '{}'::jsonb or r2 -> 'hashes' <> r -> 'hashes' then raise exception 'SELFTEST FAILED: 3 unchanged months were sent: %', r2; end if;

  -- 3) one tick changes in October: ONLY October is sent
  r3 := public.sync_months(jsonb_set(lg, '{2026-10-18,a}', '{"r":"x"}'), r -> 'hashes');
  if (select array_agg(k order by k) from jsonb_object_keys(r3 -> 'months') k) <> array['2026-10'] then raise exception 'SELFTEST FAILED: 4 expected only 2026-10, got %', r3 -> 'months'; end if;

  -- 4) the history arrives as TEXT holding JSON (some setups store it that way): same answer
  if public.sync_months(to_jsonb(lg::text), null) -> 'hashes' <> r -> 'hashes' then raise exception 'SELFTEST FAILED: 5 text history'; end if;

  -- 5) an empty history
  if public.sync_months('{}'::jsonb, null) <> '{"hashes":{},"months":{}}'::jsonb or public.sync_months(null, null) <> '{"hashes":{},"months":{}}'::jsonb then
    raise exception 'SELFTEST FAILED: 6 empty history';
  end if;

  -- 6) a bad token is refused
  begin
    perform public.app_sync('00000000-0000-0000-0000-000000000000'::uuid);
    raise exception 'SELFTEST FAILED: 7 a bad token was accepted';
  exception when others then
    if sqlerrm like 'SELFTEST FAILED%' then raise; end if;
  end;

  -- 7) the doors
  if not has_function_privilege('anon', 'public.app_sync(uuid, text, text, text, jsonb)', 'EXECUTE') then raise exception 'LOCK CHECK FAILED: the app cannot call app_sync'; end if;
  if has_function_privilege('anon', 'public.sync_months(jsonb, jsonb)', 'EXECUTE') then raise exception 'LOCK CHECK FAILED: sync_months can be called from outside'; end if;
end
$selftest$;

commit;

select 'ALL PASS' as result;
