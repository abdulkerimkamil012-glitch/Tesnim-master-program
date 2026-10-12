-- ============================================================================
-- 11_dash_functions.sql  (Part B1)  -  the Dashboard engine, computed on the SERVER
-- ----------------------------------------------------------------------------
-- Run 10_dash_tables.sql FIRST. This file only ADDS new functions (all named
-- dash_<name>, plus app_dash and app_dash_restart). It never changes _me, app_today
-- or any existing function. Safe to run again: it just re-creates the same things.
--
-- The picture: the counting rules of the app (src/main.js) are copied here, step
-- by step, into small "helpers". The big helper dash_calc_core() is a pure
-- calculator: you hand it the activities, the recycle bin, the ticks and the
-- dates, and it hands back the numbers. It never reads a table, so it can be
-- tested with made-up data (see 12_dash_selftest.sql).
-- Only app_dash and app_dash_restart can be called from the app. Every helper
-- is locked at the very end of this file.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1) The time zone used to turn "deleted at 22:30 UTC" into a LOCAL date.
--    This is the ONE place to change it. "Today" never comes from here:
--    today always comes from app_today().
-- ---------------------------------------------------------------------------
create or replace function public.dash_tz()
returns text
language sql stable
set search_path to 'public', 'extensions'
as $f$
  select 'Africa/Addis_Ababa'::text
$f$;


-- ---------------------------------------------------------------------------
-- 2) Tiny safety helpers: "give me an array / an object, or an empty one".
--    dash_json also opens values that were saved as TEXT holding JSON
--    (app_shared keeps tesnim_programs and tesnim_trash that way).
-- ---------------------------------------------------------------------------
create or replace function public.dash_arr(j jsonb)
returns jsonb
language sql immutable
set search_path to 'public', 'extensions'
as $f$
  select case when jsonb_typeof(j) = 'array' then j else '[]'::jsonb end
$f$;

create or replace function public.dash_obj(j jsonb)
returns jsonb
language sql immutable
set search_path to 'public', 'extensions'
as $f$
  select case when jsonb_typeof(j) = 'object' then j else '{}'::jsonb end
$f$;

create or replace function public.dash_json(j jsonb)
returns jsonb
language plpgsql immutable
set search_path to 'public', 'extensions'
as $f$
begin
  if j is null then return null; end if;
  if jsonb_typeof(j) = 'string' then return (j #>> '{}')::jsonb; end if;
  return j;
exception when others then
  return null;   -- text that is not valid JSON counts as "nothing there"
end
$f$;


-- ---------------------------------------------------------------------------
-- 3) "Is this value truthy?"  Same meaning as in JavaScript: false, 0, "" and
--    null are "empty"; everything else (even {} and []) is "something".
-- ---------------------------------------------------------------------------
create or replace function public.dash_truthy(j jsonb)
returns boolean
language sql immutable
set search_path to 'public', 'extensions'
as $f$
  select case jsonb_typeof(j)
    when 'boolean' then j = 'true'::jsonb
    when 'number'  then j <> '0'::jsonb
    when 'string'  then (j #>> '{}') <> ''
    when 'object'  then true
    when 'array'   then true
    else false
  end
$f$;


-- ---------------------------------------------------------------------------
-- 4) hasEntry: did the person really tick / mark / note this activity on this
--    day?  (main.js hasEntry)  A stored object counts only if at least one of
--    its values is truthy, so a note that was erased ("") is not an entry.
-- ---------------------------------------------------------------------------
create or replace function public.dash_has_entry(l jsonb)
returns boolean
language sql immutable
set search_path to 'public', 'extensions'
as $f$
  select case jsonb_typeof(l)
    when 'object' then exists (select 1 from jsonb_each(l) as x(kk, vv) where public.dash_truthy(x.vv))
    when 'array'  then exists (select 1 from jsonb_array_elements(l) as x(vv) where public.dash_truthy(x.vv))
    else public.dash_truthy(l)
  end
$f$;


-- ---------------------------------------------------------------------------
-- 5) schedOn / appliesOn: which weekdays did this activity have ON THAT DAY?
--    p.sh = [{u:'2026-10-07', s:[1,3]}, more entries] means "before day u the weekdays
--    were s". The FIRST entry (in the saved order) whose u is after the day
--    wins; if none, the current p.schedule is used.
--    A day counts if the schedule is 'daily' or lists that weekday (1=Mon..7=Sun).
-- ---------------------------------------------------------------------------
create or replace function public.dash_sched_on(p jsonb, ds text)
returns jsonb
language plpgsql immutable
set search_path to 'public', 'extensions'
as $f$
declare h jsonb;
begin
  for h in
    select x.vv from jsonb_array_elements(public.dash_arr(p -> 'sh')) with ordinality as x(vv, ord) order by x.ord
  loop
    if jsonb_typeof(h) = 'object' and (h ->> 'u') is not null
       and ds collate "C" < (h ->> 'u') collate "C" then
      return coalesce(h -> 's', 'null'::jsonb);   -- first match wins, even if it has no weekdays
    end if;
  end loop;
  return p -> 'schedule';
end
$f$;

create or replace function public.dash_applies(p jsonb, ds text, wd int)
returns boolean
language sql immutable
set search_path to 'public', 'extensions'
as $f$
  select coalesce(
    s = '"daily"'::jsonb or (jsonb_typeof(s) = 'array' and s @> jsonb_build_array(wd)),
    false)
  from (select public.dash_sched_on(p, ds) as s) q
$f$;


-- ---------------------------------------------------------------------------
-- 6) p.off = [[from, to], [from, to]]: the days an activity spent in the Recycle Bin
--    before it was restored. The "from" day is inside, the "to" day is not.
-- ---------------------------------------------------------------------------
create or replace function public.dash_in_off(p jsonb, ds text)
returns boolean
language sql immutable
set search_path to 'public', 'extensions'
as $f$
  select exists (
    select 1
    from jsonb_array_elements(public.dash_arr(p -> 'off')) as x(g)
    where jsonb_typeof(x.g) = 'array'
      and ds collate "C" >= (x.g ->> 0) collate "C"
      and ds collate "C" <  (x.g ->> 1) collate "C"
  )
$f$;


-- ---------------------------------------------------------------------------
-- 7) shapeOn / at: what KIND of activity was it on that day (single or
--    checklist) and which sub-items did it have?  p.vh = [{u, t, s}] keeps the
--    older shapes: the first entry whose u is after the day wins.
-- ---------------------------------------------------------------------------
create or replace function public.dash_shape_on(p jsonb, ds text, out typ text, out subs jsonb)
returns record
language plpgsql immutable
set search_path to 'public', 'extensions'
as $f$
declare h jsonb;
begin
  typ  := p ->> 'type';
  subs := p -> 'subItems';
  for h in
    select x.vv from jsonb_array_elements(public.dash_arr(p -> 'vh')) with ordinality as x(vv, ord) order by x.ord
  loop
    if jsonb_typeof(h) = 'object' and (h ->> 'u') is not null
       and ds collate "C" < (h ->> 'u') collate "C" then
      typ  := h ->> 't';
      subs := case when (h ->> 't') = 'checklist' then h -> 's' else null end;
      return;
    end if;
  end loop;
end
$f$;


-- ---------------------------------------------------------------------------
-- 8) JavaScript's Number(x) for the "p" (percent) value: numbers stay,
--    true = 1, null = 0, a numeric text like "60" works, anything else = unknown.
-- ---------------------------------------------------------------------------
create or replace function public.dash_num(j jsonb)
returns numeric
language plpgsql immutable
set search_path to 'public', 'extensions'
as $f$
declare s text;
begin
  case jsonb_typeof(j)
    when 'number'  then return (j #>> '{}')::numeric;
    when 'boolean' then return case when j = 'true'::jsonb then 1 else 0 end;
    when 'null'    then return 0;
    when 'string'  then
      s := j #>> '{}';
      if s ~ '^\s*[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?\s*$' then return s::numeric; end if;
      if btrim(s) = '' then return 0; end if;
      return null;
    else return null;
  end case;
  return null;
exception when others then
  return null;
end
$f$;


-- ---------------------------------------------------------------------------
-- 9) resOf / parseRes / isDone: the RESULT of one activity on one day.
--    k = 'v' done | 'p' partly | 'x' not done | '' nothing;  pct = 0..100
--      checklist  -> 100 if the value is true, {r:'v'}, or EVERY sub-item is true. Never partial.
--      single     -> true=100, {r:'x'}=✗, {r:'v'}=100, {r:'p',p}: >=100 is done, 1..99 partly,
--                    a note alone = nothing, a leftover master object = 100 only if every saved
--                    sub-tick is true.
-- ---------------------------------------------------------------------------
create or replace function public.dash_result(l jsonb, typ text, subs jsonb, out k text, out pct int)
returns record
language plpgsql immutable
set search_path to 'public', 'extensions'
as $f$
declare n numeric;
begin
  k := '';
  pct := 0;
  if not public.dash_truthy(l) then return; end if;   -- nothing saved

  -- ---- a checklist (master) activity ----
  if typ = 'checklist' then
    if l = 'true'::jsonb
       or (l -> 'r') = '"v"'::jsonb
       or (jsonb_array_length(public.dash_arr(subs)) > 0
           and not exists (
             select 1 from jsonb_array_elements(public.dash_arr(subs)) as x(s)
             where not coalesce((l -> (x.s ->> 'id')) = 'true'::jsonb, false))) then
      k := 'v';
      pct := 100;
    end if;
    return;
  end if;

  -- ---- a single activity ----
  -- a leftover master value (sub-ticks without any "r"): done only if every saved sub-tick is true
  if jsonb_typeof(l) = 'object' and not (l ? 'r') then
    if exists (select 1 from jsonb_each(l) as x(kk, vv) where x.kk <> 'n') then
      if not exists (select 1 from jsonb_each(l) as x(kk, vv) where x.kk <> 'n' and x.vv <> 'true'::jsonb) then
        k := 'v';
        pct := 100;
      end if;
      return;
    end if;
  elsif jsonb_typeof(l) = 'array' and jsonb_array_length(l) > 0 then
    if not exists (select 1 from jsonb_array_elements(l) as x(vv) where x.vv <> 'true'::jsonb) then
      k := 'v';
      pct := 100;
    end if;
    return;
  end if;

  -- parseRes
  if l = 'true'::jsonb then k := 'v'; pct := 100; return; end if;
  if jsonb_typeof(l) = 'object' then
    if (l -> 'r') = '"x"'::jsonb then k := 'x'; pct := 0; return; end if;
    if (l -> 'r') = '"v"'::jsonb then k := 'v'; pct := 100; return; end if;
    if (l -> 'r') = '"p"'::jsonb then
      n := public.dash_num(l -> 'p');
      if n is null then return; end if;
      n := floor(n + 0.5);                      -- JavaScript Math.round
      if n >= 100 then k := 'v'; pct := 100;
      elsif n >= 1 then k := 'p'; pct := n::int;
      end if;
      return;
    end if;
    if not (l ? 'r') and (l ? 'n') then return; end if;   -- a note with no result yet
  end if;
  k := 'v';       -- any other stored value counts as done, exactly like the app
  pct := 100;
end
$f$;


-- ---------------------------------------------------------------------------
-- 10) The deletedAt time -> the LOCAL day it was deleted on ('YYYY-MM-DD').
--     Bad or missing time -> null (the app skips such an activity too).
-- ---------------------------------------------------------------------------
create or replace function public.dash_local_day(raw text)
returns text
language plpgsql stable
set search_path to 'public', 'extensions'
as $f$
begin
  return to_char(((raw::timestamptz) at time zone public.dash_tz())::date, 'YYYY-MM-DD');
exception when others then
  return null;
end
$f$;


-- ---------------------------------------------------------------------------
-- 11) The list of activities that can count: live programs + "ghosts".
--     A ghost = a Recycle Bin entry of kind 'program' whose id is not live;
--     the FIRST entry per id wins (the app keeps the bin newest-first), and it
--     stops counting on the local day it was deleted (ends).
--     created = the start day. If an activity has no createdAt we use its
--     earliest day with a real entry; if it has none, skipped = true and it is
--     left out of every count (dash_skipped_count tells you how many).
-- ---------------------------------------------------------------------------
create or replace function public.dash_acts(p_progs jsonb, p_trash jsonb, p_log jsonb)
returns table(pid text, p jsonb, ends text, created text, ghost boolean, skipped boolean)
language sql stable
set search_path to 'public', 'extensions'
as $f$
  with lg as (
    select public.dash_obj(public.dash_json(p_log)) as j
  ),
  live as (
    select e.vv as p, (e.vv ->> 'id') as pid
    from jsonb_array_elements(public.dash_arr(public.dash_json(p_progs))) as e(vv)
    where jsonb_typeof(e.vv) = 'object' and coalesce(e.vv ->> 'id', '') <> ''
  ),
  gh as (
    select distinct on (g.pid) g.pid, g.p, g.raw
    from (
      select x.tt -> 'data' as p, (x.tt -> 'data' ->> 'id') as pid, (x.tt ->> 'deletedAt') as raw, x.ord
      from jsonb_array_elements(public.dash_arr(public.dash_json(p_trash))) with ordinality as x(tt, ord)
      where jsonb_typeof(x.tt) = 'object'
        and (x.tt ->> 'kind') = 'program'
        and jsonb_typeof(x.tt -> 'data') = 'object'
        and coalesce(x.tt -> 'data' ->> 'id', '') <> ''
    ) g
    where not exists (select 1 from live where live.pid = g.pid)
    order by g.pid, g.ord
  ),
  allp as (
    select l.pid, l.p, null::text as ends, false as ghost
    from live l
    union all
    select h.pid, h.p, public.dash_local_day(h.raw), true
    from gh h
    where public.dash_local_day(h.raw) is not null
  )
  select a.pid, a.p, a.ends, c.created, a.ghost, (c.created is null) as skipped
  from allp a
  cross join lg
  cross join lateral (
    select coalesce(
      nullif(a.p ->> 'createdAt', ''),
      (select min(e.key collate "C")
         from jsonb_each(lg.j) as e
        where e.key ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
          and public.dash_has_entry(e.value -> a.pid))
    ) as created
  ) c
$f$;


-- ---------------------------------------------------------------------------
-- 12) THE CALCULATOR (pure: reads no table).
--     For every requested date it returns one row:
--       t  = activities that count that day      dn = results of 100 (full ticks)
--       pt = partly done (1-99%)                  fl = ✗ not done
--       sp = the percents added up (a 60% adds 60)
--     p_ids = only these activity ids (null = all activities).
--     An activity counts on a day when: its weekdays include the day (as they
--     were then) AND the day is before it was deleted AND the day is not inside
--     an "off" range AND (the day is on/after its start day OR something real was
--     saved that day).
-- ---------------------------------------------------------------------------
create or replace function public.dash_calc_core(p_progs jsonb, p_trash jsonb, p_log jsonb, p_ids text[], p_dates date[])
returns table(d date, t int, dn int, pt int, fl int, sp numeric)
language sql stable
set search_path to 'public', 'extensions'
as $f$
  with lg as (
    select public.dash_obj(public.dash_json(p_log)) as j
  ),
  a as (
    select x.pid, x.p, x.ends, x.created
    from public.dash_acts(p_progs, p_trash, p_log) x
    where not x.skipped and (p_ids is null or x.pid = any (p_ids))
  ),
  dd as (
    select distinct u.d from unnest(p_dates) as u(d) where u.d is not null
  ),
  cand as materialized (
    select dd.d, x.ds, a.pid, a.p, v.l
    from dd
    cross join a
    cross join lg
    cross join lateral (
      select to_char(dd.d, 'YYYY-MM-DD') as ds, extract(isodow from dd.d)::int as wd
    ) x
    cross join lateral (
      select lg.j -> x.ds -> a.pid as l
    ) v
    where public.dash_applies(a.p, x.ds, x.wd)
      and (a.ends is null or x.ds collate "C" < a.ends collate "C")
      and not public.dash_in_off(a.p, x.ds)
      and (x.ds collate "C" >= a.created collate "C" or public.dash_has_entry(v.l))
  ),
  cell as (
    select c.d, c.pid, r.k, r.pct
    from cand c
    cross join lateral public.dash_shape_on(c.p, c.ds) s
    cross join lateral public.dash_result(c.l, s.typ, s.subs) r
  )
  select dd.d,
         count(cell.pid)::int,
         (count(*) filter (where cell.k = 'v'))::int,
         (count(*) filter (where cell.k = 'p'))::int,
         (count(*) filter (where cell.k = 'x'))::int,
         coalesce(sum(cell.pct), 0)::numeric
  from dd
  left join cell on cell.d = dd.d
  group by dd.d
  order by dd.d
$f$;


-- ---------------------------------------------------------------------------
-- 13) The same calculator, but it fetches the real data itself:
--     the activities and the Recycle Bin from app_shared, the ticks from app_log.
-- ---------------------------------------------------------------------------
create or replace function public.dash_calc(p_ids text[], p_dates date[])
returns table(d date, t int, dn int, pt int, fl int, sp numeric)
language sql stable
set search_path to 'public', 'extensions'
as $f$
  select c.d, c.t, c.dn, c.pt, c.fl, c.sp
  from public.dash_calc_core(
    (select s.data -> 'tesnim_programs' from public.app_shared s where s.id = 1),
    (select s.data -> 'tesnim_trash'    from public.app_shared s where s.id = 1),
    (select l.data                      from public.app_log    l where l.id = 1),
    p_ids,
    p_dates
  ) c
$f$;


-- ---------------------------------------------------------------------------
-- 14) How many activities were LEFT OUT because they have no start day and no
--     entry anywhere? (pure version for tests, and a version that reads the tables)
-- ---------------------------------------------------------------------------
create or replace function public.dash_skipped_count(p_progs jsonb, p_trash jsonb, p_log jsonb)
returns int
language sql stable
set search_path to 'public', 'extensions'
as $f$
  select count(*)::int from public.dash_acts(p_progs, p_trash, p_log) x where x.skipped
$f$;

create or replace function public.dash_skipped()
returns int
language sql stable
set search_path to 'public', 'extensions'
as $f$
  select public.dash_skipped_count(
    (select s.data -> 'tesnim_programs' from public.app_shared s where s.id = 1),
    (select s.data -> 'tesnim_trash'    from public.app_shared s where s.id = 1),
    (select l.data                      from public.app_log    l where l.id = 1)
  )
$f$;


-- ---------------------------------------------------------------------------
-- 15) The percent rule (same as mkStat in main.js):
--     nothing counted -> null;  every activity a full tick -> 100;
--     otherwise the average, rounded, and NEVER above 99 (99.6% shows 99).
-- ---------------------------------------------------------------------------
create or replace function public.dash_pct(sp numeric, t int, dn int)
returns int
language sql immutable
set search_path to 'public', 'extensions'
as $f$
  select case
    when coalesce(t, 0) = 0 then null
    when dn = t then 100
    else least(99, round(coalesce(sp, 0) / t)::int)
  end
$f$;


-- ---------------------------------------------------------------------------
-- 16) One day as JSON: {pct, full, has} and, only when counts are allowed,
--     also {t, dn, pt, fl}.
-- ---------------------------------------------------------------------------
create or replace function public.dash_cell_json(t int, dn int, pt int, fl int, sp numeric, counts boolean)
returns jsonb
language sql immutable
set search_path to 'public', 'extensions'
as $f$
  select jsonb_build_object('pct', public.dash_pct(sp, t, dn), 'full', (t > 0 and dn = t), 'has', (t > 0))
         || case when counts
                 then jsonb_build_object('t', t, 'dn', dn, 'pt', pt, 'fl', fl)
                 else '{}'::jsonb end
$f$;


-- ---------------------------------------------------------------------------
-- 17) One "part" of the answer for a list of dates:
--     {"cells": {"2026-10-05": <day>, "2026-10-06": <day>}, "sum": <whole period>}
--     The period has pct, days (days with something to do), full (days where
--     every activity was a full tick) and, when allowed, the added-up counts.
-- ---------------------------------------------------------------------------
create or replace function public.dash_part(p_ids text[], p_dates date[], p_counts boolean)
returns jsonb
language plpgsql stable
set search_path to 'public', 'extensions'
as $f$
declare cells jsonb; sm jsonb;
begin
  select
    coalesce(jsonb_object_agg(to_char(c.d, 'YYYY-MM-DD'),
                              public.dash_cell_json(c.t, c.dn, c.pt, c.fl, c.sp, p_counts)), '{}'::jsonb),
    jsonb_build_object(
      'pct',  public.dash_pct(coalesce(sum(c.sp), 0), coalesce(sum(c.t), 0)::int, coalesce(sum(c.dn), 0)::int),
      'days', count(*) filter (where c.t > 0),
      'full', count(*) filter (where c.t > 0 and c.dn = c.t))
    || case when p_counts
            then jsonb_build_object('t', coalesce(sum(c.t), 0), 'dn', coalesce(sum(c.dn), 0),
                                    'pt', coalesce(sum(c.pt), 0), 'fl', coalesce(sum(c.fl), 0))
            else '{}'::jsonb end
  into cells, sm
  from public.dash_calc(p_ids, p_dates) c;
  return jsonb_build_object('cells', cells, 'sum', sm);
end
$f$;


-- ---------------------------------------------------------------------------
-- 18) The restart notebook: the newest start day, and the last 20 marks.
-- ---------------------------------------------------------------------------
create or replace function public.dash_start()
returns date
language sql stable
set search_path to 'public', 'extensions'
as $f$
  select m.start_date from public.app_dash_marks m order by m.id desc limit 1
$f$;

create or replace function public.dash_marks_json()
returns jsonb
language sql stable
set search_path to 'public', 'extensions'
as $f$
  select coalesce(
    jsonb_agg(jsonb_build_object('d', m.start_date, 'by', m.by_name, 'at', m.created_at) order by m.id desc),
    '[]'::jsonb)
  from (select * from public.app_dash_marks order by id desc limit 20) m
$f$;


-- ---------------------------------------------------------------------------
-- 19) THE DOOR FOR THE APP:  app_dash(token, from, to, weekdays, exact dates)
--     * bad token -> error 'auth'
--     * which days: p_dates if given (max 120, exactly those); otherwise
--       p_from..p_to (max 400 days; only one given -> the other defaults: to = today,
--       from = 6 days before "to"), filtered by p_wd (1=Mon..7=Sun; null or empty = all).
--       Nothing given = the last 7 days. Days after today are always dropped.
--       from after to, or too many days -> error 'range'.
--     * admin / "all" users get full numbers (scope "all");
--       restricted users get scope "own": the overall picture shows only
--       {pct, full, has} (no counts, no names), and "m" holds THEIR OWN activities in full.
-- ---------------------------------------------------------------------------
create or replace function public.app_dash(
  p_tok   uuid,
  p_from  date   default null,
  p_to    date   default null,
  p_wd    int[]  default null,
  p_dates date[] default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $f$
declare
  usr app_users;
  td date; st date;
  is_full boolean;
  my_ids text[];
  dts date[]; since_dts date[];
  d_from date; d_to date;
  part_o jsonb; part_m jsonb; since_o jsonb; since_m jsonb;
  days_json jsonb;
begin
  usr := _me(p_tok);
  if usr.id is null then raise exception 'auth'; end if;
  td := app_today();

  -- which days?
  if p_dates is not null then
    if coalesce(array_length(p_dates, 1), 0) > 120 then raise exception 'range'; end if;
    select coalesce(array_agg(q.x order by q.x), '{}'::date[]) into dts
      from (select distinct z as x from unnest(p_dates) as z where z is not null and z <= td) q;
  else
    d_to   := coalesce(p_to, td);
    d_from := coalesce(p_from, d_to - 6);
    if d_from > d_to or (d_to - d_from) >= 400 then raise exception 'range'; end if;
    select coalesce(array_agg(d_from + g order by g), '{}'::date[]) into dts
      from generate_series(0, d_to - d_from) as g
     where d_from + g <= td
       and (p_wd is null
            or coalesce(array_length(p_wd, 1), 0) = 0
            or extract(isodow from d_from + g)::int = any (p_wd));
  end if;

  -- who is asking?
  is_full := coalesce(usr.is_admin, false) or coalesce(usr.programs = '"all"'::jsonb, false);
  if not is_full then
    my_ids := case when jsonb_typeof(usr.programs) = 'array'
                   then array(select jsonb_array_elements_text(usr.programs))
                   else '{}'::text[] end;
  end if;

  -- the restart mark
  st := public.dash_start();

  -- the numbers
  part_o := public.dash_part(null, dts, is_full);
  if not is_full then part_m := public.dash_part(my_ids, dts, true); end if;

  if st is not null and st <= td then
    since_dts := array(select st + g from generate_series(0, td - st) as g);
    since_o := public.dash_part(null, since_dts, is_full);
    if not is_full then since_m := public.dash_part(my_ids, since_dts, true); end if;
  end if;

  select coalesce(jsonb_agg(
           jsonb_build_object(
             'd', to_char(z, 'YYYY-MM-DD'),
             'o', part_o -> 'cells' -> to_char(z, 'YYYY-MM-DD'),
             'm', case when is_full then null else part_m -> 'cells' -> to_char(z, 'YYYY-MM-DD') end)
           order by z), '[]'::jsonb)
    into days_json
    from unnest(dts) as z;

  return jsonb_build_object(
    'today', td,
    'scope', case when is_full then 'all' else 'own' end,
    'start', st,
    'marks', public.dash_marks_json(),
    'days',  days_json,
    'sum',   jsonb_build_object('o', part_o -> 'sum',
                                'm', case when is_full then null else part_m -> 'sum' end),
    'since', case when since_o is null then null
                  else jsonb_build_object('o', since_o -> 'sum',
                                          'm', case when is_full then null else since_m -> 'sum' end) end
  );
end
$f$;


-- ---------------------------------------------------------------------------
-- 20) THE RESTART BUTTON (admin only): app_dash_restart(token, start, clear)
--     * bad token -> 'auth';  not an admin -> 'denied'
--     * default start = today (app_today()); a start in the future, or more than
--       1000 days back, -> 'range'
--     * p_clear = true writes a "no restart" mark (start null = all history counts)
--     Nothing is deleted: every mark stays in the notebook, the newest one counts.
-- ---------------------------------------------------------------------------
create or replace function public.app_dash_restart(
  p_tok   uuid,
  p_start date    default null,
  p_clear boolean default false)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $f$
declare usr app_users; td date; st date;
begin
  usr := _me(p_tok);
  if usr.id is null then raise exception 'auth'; end if;
  if not coalesce(usr.is_admin, false) then raise exception 'denied'; end if;
  td := app_today();

  if coalesce(p_clear, false) then
    insert into public.app_dash_marks (start_date, by_name) values (null, usr.username);
  else
    st := coalesce(p_start, td);
    if st > td or st < td - 1000 then raise exception 'range'; end if;
    insert into public.app_dash_marks (start_date, by_name) values (st, usr.username);
  end if;

  return jsonb_build_object('start', public.dash_start(), 'marks', public.dash_marks_json());
end
$f$;


-- ---------------------------------------------------------------------------
-- 21) LOCK THE DOORS.
--     Supabase hands out "may run this" rights to everybody by default, so we
--     take them away from EVERY dash_ helper (and from the two app_ doors),
--     then give back only what the app needs: anon may run app_dash and
--     app_dash_restart. Nothing else is callable from outside.
-- ---------------------------------------------------------------------------
do $lock$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and (p.proname like 'dash\_%' or p.proname in ('app_dash', 'app_dash_restart'))
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
  end loop;
end
$lock$;

grant execute on function public.app_dash(uuid, date, date, int[], date[]) to anon;
grant execute on function public.app_dash_restart(uuid, date, boolean) to anon;
