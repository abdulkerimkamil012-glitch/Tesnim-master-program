-- ============================================================================
-- 20_b2_guards.sql  (Part B2)  -  delete lock + login speed limit
-- ----------------------------------------------------------------------------
-- Paste the WHOLE file into Supabase > SQL Editor and press Run, once.
-- At the very end it tests itself. You should see ONE result row: ALL PASS
-- If you see a red error instead, NOTHING was changed (the whole file is one
-- step: all or nothing). Copy the error and send it to me.
--
-- What it does, in plain words
--   1) DELETE LOCK. When the admin turns 🗑 off for a user, the server now
--      refuses any save from that user that would:
--        * remove an activity (also "move it to the Recycle Bin"),
--        * remove a reference page,
--        * delete something forever from the Recycle Bin (or empty the bin),
--        * delete a whole category (its activities left with no category),
--        * do any of the above through a backup import.
--      Restoring from the Recycle Bin, renaming or merging categories, editing
--      and ticking still work. Admins are never locked.
--   2) LOGIN SPEED LIMIT. 5 wrong passwords for one user name in an hour ->
--      that name must wait 30 seconds, then 1, 2, 4, 8 minutes, at most 15.
--      20 wrong passwords from one internet address in an hour -> that address
--      waits the same way. A correct login clears the count.
--
-- How it works without rewriting your old functions: the old app_put and
-- app_login are RENAMED to _app_put_core and _app_login_core (their code is
-- not touched) and locked so the website can no longer call them directly.
-- New app_put and app_login with the SAME names and inputs check the rule
-- first and then hand over to the old ones.
--
-- Safe to run twice. To undo everything: 29_rollback_b2.sql
-- Needs B1 (10 and 11) to be installed first (it uses two dash_ helpers).
-- ============================================================================


begin;   -- everything below is ONE step: all or nothing

-- ---------------------------------------------------------------------------
-- 0) Stop early, with a clear message, if B1 is missing.
-- ---------------------------------------------------------------------------
do $need$
begin
  if to_regprocedure('public.dash_json(jsonb)') is null or to_regprocedure('public.dash_arr(jsonb)') is null then
    raise exception 'B1 is missing: run 10_dash_tables.sql and 11_dash_functions.sql first';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'app_users' and column_name = 'perms') then
    raise exception 'CHECK FAILED: table app_users has no column "perms" - send this message to me';
  end if;
end
$need$;


-- ---------------------------------------------------------------------------
-- 1) Rename the old functions ONCE (only if that has not happened before).
-- ---------------------------------------------------------------------------
do $rename$
begin
  if to_regprocedure('public._app_put_core(uuid, jsonb, jsonb)') is null then
    if to_regprocedure('public.app_put(uuid, jsonb, jsonb)') is null then
      raise exception 'app_put(uuid, jsonb, jsonb) not found - send this message to me';
    end if;
    alter function public.app_put(uuid, jsonb, jsonb) rename to _app_put_core;
  end if;
  if to_regprocedure('public._app_login_core(text, text)') is null then
    if to_regprocedure('public.app_login(text, text)') is null then
      raise exception 'app_login(text, text) not found - send this message to me';
    end if;
    alter function public.app_login(text, text) rename to _app_login_core;
  end if;
end
$rename$;

-- The old ones may now only be called by the new ones (never from the website).
revoke all on function public._app_put_core(uuid, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public._app_login_core(text, text) from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 2) DELETE LOCK helpers
-- ---------------------------------------------------------------------------

-- A category name made comparable: "ምግብ", " ምግብ " and "ምግብ  " are the same.
-- (Same idea as catClean in src/main.js.)
create or replace function public.del_cat_key(c text)
returns text
language sql immutable
set search_path to 'public', 'extensions'
as $f$
  select lower(btrim(regexp_replace(regexp_replace(coalesce(c, ''), '[​-‍﻿]', '', 'g'), '\s+', ' ', 'g')))
$f$;

-- THE RULE (pure: reads no table, so it is tested at the end of this file).
-- p_old = what the server has now, p_new = what the phone wants to save.
-- Returns NULL when the save is fine, otherwise the reason:
--   'program'  an activity would disappear (deleted or moved to the bin)
--   'page'     a reference page would disappear
--   'trash'    a Recycle Bin entry would disappear without being restored
--   'category' a whole category would disappear and its activities would be
--              left with no category
-- A key that is missing from p_new counts as an EMPTY list (the strict side).
create or replace function public.del_guard(p_old jsonb, p_new jsonb)
returns text
language plpgsql stable
set search_path to 'public', 'extensions'
as $f$
declare
  op jsonb := public.dash_arr(public.dash_json(p_old -> 'tesnim_programs'));
  np jsonb := public.dash_arr(public.dash_json(p_new -> 'tesnim_programs'));
  og jsonb := public.dash_arr(public.dash_json(p_old -> 'tesnim_pages'));
  ng jsonb := public.dash_arr(public.dash_json(p_new -> 'tesnim_pages'));
  ot jsonb := public.dash_arr(public.dash_json(p_old -> 'tesnim_trash'));
  nt jsonb := public.dash_arr(public.dash_json(p_new -> 'tesnim_trash'));
begin
  -- 1) an activity disappears
  if exists (
    select 1 from jsonb_array_elements(op) o(v)
     where jsonb_typeof(o.v) = 'object' and coalesce(o.v ->> 'id', '') <> ''
       and not exists (select 1 from jsonb_array_elements(np) n(v) where n.v ->> 'id' = o.v ->> 'id')
  ) then return 'program'; end if;

  -- 2) a page disappears
  if exists (
    select 1 from jsonb_array_elements(og) o(v)
     where jsonb_typeof(o.v) = 'object' and coalesce(o.v ->> 'id', '') <> ''
       and not exists (select 1 from jsonb_array_elements(ng) n(v) where n.v ->> 'id' = o.v ->> 'id')
  ) then return 'page'; end if;

  -- 3) a Recycle Bin entry disappears and its activity / page did NOT come back (= deleted forever)
  if exists (
    select 1 from jsonb_array_elements(ot) t(v)
     where jsonb_typeof(t.v) = 'object' and coalesce(t.v ->> 'id', '') <> ''
       and not exists (select 1 from jsonb_array_elements(nt) u(v) where u.v ->> 'id' = t.v ->> 'id')
       and not exists (select 1
                         from jsonb_array_elements(case when t.v ->> 'kind' = 'page' then ng else np end) b(v)
                        where coalesce(t.v -> 'data' ->> 'id', '') <> ''
                          and b.v ->> 'id' = t.v -> 'data' ->> 'id')
  ) then return 'trash'; end if;

  -- 4) a whole category disappears and its activities are left with no category
  if exists (
    select 1
      from jsonb_array_elements(op) o(v)
      join jsonb_array_elements(np) n(v) on n.v ->> 'id' = o.v ->> 'id'
     where public.del_cat_key(o.v ->> 'category') <> ''
       and public.del_cat_key(n.v ->> 'category') = ''
       and not exists (select 1 from jsonb_array_elements(np) z(v)
                        where public.del_cat_key(z.v ->> 'category') = public.del_cat_key(o.v ->> 'category'))
  ) then return 'category'; end if;

  return null;
end
$f$;

-- May this user delete?  Admin: always.  Everyone else: only if the admin
-- switched 🗑 ("del") on for them.
create or replace function public.del_allowed(u app_users)
returns boolean
language sql stable
set search_path to 'public', 'extensions'
as $f$
  select coalesce(u.is_admin, false)
      or coalesce(public.dash_json(to_jsonb(u) -> 'perms') -> 'del' = 'true'::jsonb, false)
$f$;


-- ---------------------------------------------------------------------------
-- 3) THE NEW app_put  (same name, same inputs as before)
--    Refuses with the error 'nodelete:<reason>' - the app then shows
--    "⛔ deleting is not allowed" and loads the true copy from the server.
-- ---------------------------------------------------------------------------
create or replace function public.app_put(p_tok uuid, p_shared jsonb, p_mine jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $f$
declare
  usr app_users;
  cur jsonb;
  why text;
  res jsonb;
begin
  usr := _me(p_tok);
  if usr.id is null then raise exception 'auth'; end if;

  if p_shared is not null and jsonb_typeof(p_shared) = 'object' and not public.del_allowed(usr) then
    select s.data into cur from public.app_shared s where s.id = 1;
    why := public.del_guard(coalesce(cur, '{}'::jsonb), p_shared);
    if why is not null then
      raise exception 'nodelete:%', why;
    end if;
  end if;

  select to_jsonb(r) into res from public._app_put_core(p_tok, p_shared, p_mine) r;
  return res;
end
$f$;


-- ---------------------------------------------------------------------------
-- 4) LOGIN SPEED LIMIT
-- ---------------------------------------------------------------------------

-- The notebook of wrong passwords. k = 'u:<user name>' or 'ip:<address>'.
create table if not exists public.app_login_fails (
  k            text primary key,
  fails        int not null default 0,
  locked_until timestamptz,
  last_at      timestamptz not null default now()
);
alter table public.app_login_fails enable row level security;   -- no policies on purpose: nobody can read it from outside
revoke all on table public.app_login_fails from public, anon, authenticated;

-- The caller's internet address, as Supabase passes it on (null if unknown).
create or replace function public.login_ip()
returns text
language plpgsql stable
set search_path to 'public', 'extensions'
as $f$
declare h json; v text;
begin
  begin
    h := nullif(current_setting('request.headers', true), '')::json;
  exception when others then
    return null;
  end;
  if h is null then return null; end if;
  v := coalesce(h ->> 'cf-connecting-ip', h ->> 'x-real-ip', split_part(coalesce(h ->> 'x-forwarded-for', ''), ',', 1));
  return nullif(left(btrim(coalesce(v, '')), 64), '');
end
$f$;

-- Write down one wrong password. After p_free wrong ones (within one hour)
-- the key must wait: 30 s, then 60, 120, 240, 480 s, then 15 minutes each time.
create or replace function public.login_fail(p_k text, p_free int)
returns int
language plpgsql
set search_path to 'public', 'extensions'
as $f$
declare n int;
begin
  insert into public.app_login_fails as a (k, fails, last_at)
  values (p_k, 1, now())
  on conflict (k) do update
     set fails   = case when a.last_at < now() - interval '1 hour' then 1 else a.fails + 1 end,
         last_at = now()
  returning a.fails into n;
  if n >= p_free then
    update public.app_login_fails
       set locked_until = now() + make_interval(secs => least(900, 30 * power(2, least(n - p_free, 10))))
     where k = p_k;
  end if;
  return n;
end
$f$;

-- THE NEW app_login (same name, same inputs as before).
--   correct      -> exactly what the old app_login returned ({token: ...})
--   wrong        -> {error: 'bad',  left: tries left before the wait, token: 000...}
--   must wait    -> {error: 'slow', wait: seconds,                    token: 000...}
-- It answers instead of raising an error, because an error would also erase
-- the notebook line we just wrote. The all-zero token is never a real login:
-- an older copy of the app that does not know "error" simply lands back on
-- the login screen.
create or replace function public.app_login(p_user text, p_pass text)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $f$
declare
  zero constant text := '00000000-0000-0000-0000-000000000000';
  ku   text := 'u:' || lower(btrim(coalesce(p_user, '')));
  ip   text := public.login_ip();
  ki   text := case when ip is null then null else 'ip:' || ip end;
  wait_s int;
  res  jsonb;
  n    int;
begin
  -- forget old lines (older than a day and not waiting any more)
  delete from public.app_login_fails
   where last_at < now() - interval '1 day' and (locked_until is null or locked_until < now());

  -- still waiting? Then do not even look at the password.
  select ceil(extract(epoch from max(f.locked_until) - now()))::int into wait_s
    from public.app_login_fails f
   where f.k in (ku, ki) and f.locked_until > now();
  if coalesce(wait_s, 0) > 0 then
    return jsonb_build_object('token', zero, 'error', 'slow', 'wait', wait_s);
  end if;

  begin
    select to_jsonb(r) into res from public._app_login_core(p_user, p_pass) r;
  exception when others then
    if sqlerrm ~* 'bad' then res := null; else raise; end if;   -- any other error goes back to the app unchanged
  end;

  if res is not null and nullif(res ->> 'token', '') is not null and res ->> 'token' <> zero then
    delete from public.app_login_fails where k in (ku, ki);   -- correct password: the count starts again
    return res;
  end if;

  n := public.login_fail(ku, 5);
  if ki is not null then perform public.login_fail(ki, 20); end if;
  return jsonb_build_object('token', zero, 'error', 'bad', 'left', greatest(0, 5 - n));
end
$f$;


-- ---------------------------------------------------------------------------
-- 5) LOCK THE DOORS: only the two new app_ doors can be called from outside.
-- ---------------------------------------------------------------------------
revoke all on function public.del_cat_key(text)              from public, anon, authenticated;
revoke all on function public.del_guard(jsonb, jsonb)        from public, anon, authenticated;
revoke all on function public.del_allowed(app_users)         from public, anon, authenticated;
revoke all on function public.login_ip()                     from public, anon, authenticated;
revoke all on function public.login_fail(text, int)          from public, anon, authenticated;
revoke all on function public.app_put(uuid, jsonb, jsonb)    from public, anon, authenticated;
revoke all on function public.app_login(text, text)          from public, anon, authenticated;
grant execute on function public.app_put(uuid, jsonb, jsonb) to anon, authenticated;
grant execute on function public.app_login(text, text)       to anon, authenticated;


-- ---------------------------------------------------------------------------
-- 6) SELF-TEST. Touches no real data (the one test line it writes in the
--    login notebook is removed again). Any failure undoes the WHOLE file.
-- ---------------------------------------------------------------------------
do $selftest$
declare
  base jsonb := jsonb_build_object(
    'tesnim_programs', '[{"id":"a","name":"A","category":"ምግብ"},{"id":"b","name":"B","category":"ምግብ"},{"id":"c","name":"C","category":"ስፖርት"}]',
    'tesnim_pages',    '[{"id":"g1","title":"G"}]',
    'tesnim_trash',    '[{"id":"t1","kind":"program","data":{"id":"z","name":"Z"},"deletedAt":"2026-10-01T10:00:00Z"},{"id":"t2","kind":"page","data":{"id":"g9","title":"Old"},"deletedAt":"2026-10-01T10:00:00Z"}]');
  cases jsonb := '[]'::jsonb;
  c jsonb; got text; n int; lu timestamptz;
begin
  -- name, the save the phone sends, the answer we expect (null = allowed)
  cases := cases
    || jsonb_build_object('n', '01 nothing changed',              'want', null, 'new', base)
    || jsonb_build_object('n', '02 activity added',               'want', null, 'new', base || jsonb_build_object('tesnim_programs', '[{"id":"a","category":"ምግብ"},{"id":"b","category":"ምግብ"},{"id":"c","category":"ስፖርት"},{"id":"d"}]'))
    || jsonb_build_object('n', '03 activity renamed',             'want', null, 'new', base || jsonb_build_object('tesnim_programs', '[{"id":"a","name":"A2","category":"ምግብ"},{"id":"b","category":"ምግብ"},{"id":"c","category":"ስፖርት"}]'))
    || jsonb_build_object('n', '04 activity deleted',             'want', 'program', 'new', base || jsonb_build_object('tesnim_programs', '[{"id":"a","category":"ምግብ"},{"id":"c","category":"ስፖርት"}]'))
    || jsonb_build_object('n', '05 activity moved to bin',        'want', 'program', 'new', base || jsonb_build_object('tesnim_programs', '[{"id":"a","category":"ምግብ"},{"id":"c","category":"ስፖርት"}]', 'tesnim_trash', '[{"id":"t3","kind":"program","data":{"id":"b"}},{"id":"t1","kind":"program","data":{"id":"z"}},{"id":"t2","kind":"page","data":{"id":"g9"}}]'))
    || jsonb_build_object('n', '06 page deleted',                 'want', 'page', 'new', base || jsonb_build_object('tesnim_pages', '[]'))
    || jsonb_build_object('n', '07 bin entry deleted forever',    'want', 'trash', 'new', base || jsonb_build_object('tesnim_trash', '[{"id":"t2","kind":"page","data":{"id":"g9"}}]'))
    || jsonb_build_object('n', '08 bin emptied',                  'want', 'trash', 'new', base || jsonb_build_object('tesnim_trash', '[]'))
    || jsonb_build_object('n', '09 activity restored from bin',   'want', null, 'new', base || jsonb_build_object('tesnim_programs', '[{"id":"a","category":"ምግብ"},{"id":"b","category":"ምግብ"},{"id":"c","category":"ስፖርት"},{"id":"z"}]', 'tesnim_trash', '[{"id":"t2","kind":"page","data":{"id":"g9"}}]'))
    || jsonb_build_object('n', '10 page restored from bin',       'want', null, 'new', base || jsonb_build_object('tesnim_pages', '[{"id":"g1"},{"id":"g9"}]', 'tesnim_trash', '[{"id":"t1","kind":"program","data":{"id":"z"}}]'))
    || jsonb_build_object('n', '11 category renamed',             'want', null, 'new', base || jsonb_build_object('tesnim_programs', '[{"id":"a","category":"ምግቦች"},{"id":"b","category":"ምግቦች"},{"id":"c","category":"ስፖርት"}]'))
    || jsonb_build_object('n', '12 category merged into another', 'want', null, 'new', base || jsonb_build_object('tesnim_programs', '[{"id":"a","category":"ስፖርት"},{"id":"b","category":"ስፖርት"},{"id":"c","category":"ስፖርት"}]'))
    || jsonb_build_object('n', '13 category deleted (to none)',   'want', 'category', 'new', base || jsonb_build_object('tesnim_programs', '[{"id":"a","category":""},{"id":"b"},{"id":"c","category":"ስፖርት"}]'))
    || jsonb_build_object('n', '14 one activity leaves category', 'want', null, 'new', base || jsonb_build_object('tesnim_programs', '[{"id":"a","category":""},{"id":"b","category":"ምግብ"},{"id":"c","category":"ስፖርት"}]'))
    || jsonb_build_object('n', '15 same category, extra spaces',  'want', null, 'new', base || jsonb_build_object('tesnim_programs', '[{"id":"a","category":" ምግብ  "},{"id":"b","category":"ምግብ"},{"id":"c","category":"ስፖርት"}]'))
    || jsonb_build_object('n', '16 programs key missing (strict)', 'want', 'program', 'new', base - 'tesnim_programs')
    || jsonb_build_object('n', '17 backup import with fewer',     'want', 'program', 'new', jsonb_build_object('tesnim_programs', '[{"id":"a"}]', 'tesnim_pages', '[{"id":"g1"}]', 'tesnim_trash', '[]'));

  for c in select * from jsonb_array_elements(cases) loop
    got := public.del_guard(base, c -> 'new');
    if got is distinct from (c ->> 'want') then
      raise exception 'SELFTEST FAILED: % -> expected %, got %', c ->> 'n', coalesce(c ->> 'want', 'allowed'), coalesce(got, 'allowed');
    end if;
  end loop;

  -- same answers when the lists arrive as real JSON instead of text
  if public.del_guard(jsonb_build_object('tesnim_programs', '[{"id":"a"}]'::jsonb), jsonb_build_object('tesnim_programs', '[]'::jsonb)) is distinct from 'program' then
    raise exception 'SELFTEST FAILED: 18 lists as JSON';
  end if;

  -- the login notebook: 4 wrong = no wait, the 5th = about 30 seconds
  delete from public.app_login_fails where k = 'selftest:x';
  for i in 1..4 loop n := public.login_fail('selftest:x', 5); end loop;
  select locked_until into lu from public.app_login_fails where k = 'selftest:x';
  if n <> 4 or lu is not null then raise exception 'SELFTEST FAILED: 19 login wait came too early (n=%, until=%)', n, lu; end if;
  n := public.login_fail('selftest:x', 5);
  select locked_until into lu from public.app_login_fails where k = 'selftest:x';
  if n <> 5 or lu is null or lu < now() + interval '25 seconds' or lu > now() + interval '35 seconds' then
    raise exception 'SELFTEST FAILED: 20 login wait wrong (n=%, until=%)', n, lu;
  end if;
  delete from public.app_login_fails where k = 'selftest:x';

  -- the doors
  if not has_function_privilege('anon', 'public.app_put(uuid, jsonb, jsonb)', 'EXECUTE')
     or not has_function_privilege('anon', 'public.app_login(text, text)', 'EXECUTE') then
    raise exception 'LOCK CHECK FAILED: the app can no longer call app_put / app_login';
  end if;
  if has_function_privilege('anon', 'public._app_put_core(uuid, jsonb, jsonb)', 'EXECUTE')
     or has_function_privilege('anon', 'public._app_login_core(text, text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.del_guard(jsonb, jsonb)', 'EXECUTE')
     or has_function_privilege('anon', 'public.login_fail(text, int)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public._app_put_core(uuid, jsonb, jsonb)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public._app_login_core(text, text)', 'EXECUTE')
     or has_table_privilege('anon', 'public.app_login_fails', 'SELECT') then
    raise exception 'LOCK CHECK FAILED: a private helper can be called from outside';
  end if;
end
$selftest$;

commit;

select 'ALL PASS' as result,
       (select count(*) from public.app_users u where not public.del_allowed(u)) as users_who_cannot_delete;
