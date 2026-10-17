-- ============================================================================
-- 12_dash_selftest.sql  (Part B1)  -  the exam for the Dashboard engine
-- ----------------------------------------------------------------------------
-- Run this AFTER 10_dash_tables.sql and 11_dash_functions.sql.
-- It feeds made-up activities and ticks to the pure calculator dash_calc_core()
-- and checks every answer against numbers produced by the REAL counting
-- functions of the app (src/main.js, run in Node with the time zone set to
-- Africa/Addis_Ababa). It reads and writes NO table, so it cannot hurt your data.
--
--   * Everything correct -> you see a result row: ALL PASS
--   * Anything wrong     -> a red error that says which fixture failed, what was
--                           expected and what came back. Send me that message.
--
-- How to read a "want" text:  date=t/dn/pt/fl/sp
--   t = activities counted that day, dn = full ticks (100), pt = partly done,
--   fl = not done (cross), sp = the percents added up.
-- ============================================================================

do $selftest$
declare
  fx        jsonb := '[]'::jsonb;   -- the list of exam questions
  f         jsonb;
  ids_arr   text[];
  dates_arr date[];
  got       text;
  want      text;
  n_run     int := 0;
  r         record;
begin

  -- Fixture 01 plain daily tick
  --   One daily activity, ticked on 5 Oct. On 6 Oct nothing is ticked, but the activity still counts (1 to do, 0 done).
  fx := fx || '{
      "name": "01 plain daily tick",
      "progs": [{"type":"simple","schedule":"daily","createdAt":"2026-10-01","id":"a","name":"A"}],
      "trash": [],
      "log": {"2026-10-05":{"a":true}},
      "ids": null,
      "dates": ["2026-10-05","2026-10-06"],
      "want": "2026-10-05=1/1/0/0/100; 2026-10-06=1/0/0/0/0"
    }'::jsonb;

  -- Fixture 02 cross (not done) counts as 0
  --   A cross (not done) counts as an activity, adds 0 percent and goes in the "not done" column.
  fx := fx || '{
      "name": "02 cross (not done) counts as 0",
      "progs": [{"type":"simple","schedule":"daily","createdAt":"2026-10-01","id":"a"}],
      "trash": [],
      "log": {"2026-10-05":{"a":{"r":"x"}}},
      "ids": null,
      "dates": ["2026-10-05"],
      "want": "2026-10-05=1/0/0/1/0"
    }'::jsonb;

  -- Fixture 03 percent: 60 partial, 100 = done, 0 = nothing
  --   60% is partly done and adds 60. 100% is a full tick. 0% is the same as nothing. So: 3 activities, 1 done, 1 partly, sum 160.
  fx := fx || '{
      "name": "03 percent: 60 partial, 100 = done, 0 = nothing",
      "progs": [{"type":"simple","schedule":"daily","createdAt":"2026-10-01","id":"a"},{"type":"simple","schedule":"daily","createdAt":"2026-10-01","id":"b"},{"type":"simple","schedule":"daily","createdAt":"2026-10-01","id":"c"}],
      "trash": [],
      "log": {"2026-10-05":{"a":{"r":"p","p":60},"b":{"r":"p","p":100},"c":{"r":"p","p":0}}},
      "ids": null,
      "dates": ["2026-10-05"],
      "want": "2026-10-05=3/1/1/0/160"
    }'::jsonb;

  -- Fixture 04 checklist: all sub-items ticked
  --   A checklist with every sub-item ticked is a full tick.
  fx := fx || '{
      "name": "04 checklist: all sub-items ticked",
      "progs": [{"type":"checklist","schedule":"daily","createdAt":"2026-10-01","id":"k","subItems":[{"id":"s1","name":"x"},{"id":"s2","name":"y"}]}],
      "trash": [],
      "log": {"2026-10-05":{"k":{"s1":true,"s2":true}}},
      "ids": null,
      "dates": ["2026-10-05"],
      "want": "2026-10-05=1/1/0/0/100"
    }'::jsonb;

  -- Fixture 05 checklist: only some ticked is NOT partial
  --   A checklist with only some sub-items ticked is NOT partial: it counts as 0.
  fx := fx || '{
      "name": "05 checklist: only some ticked is NOT partial",
      "progs": [{"type":"checklist","schedule":"daily","createdAt":"2026-10-01","id":"k","subItems":[{"id":"s1","name":"x"},{"id":"s2","name":"y"}]}],
      "trash": [],
      "log": {"2026-10-05":{"k":{"s1":true}}},
      "ids": null,
      "dates": ["2026-10-05"],
      "want": "2026-10-05=1/0/0/0/0"
    }'::jsonb;

  -- Fixture 06 leftover single tick on a checklist (and leftover sub-ticks on a single)
  --   Day 1: a leftover single tick (true) on a checklist is done; sub-ticks that are all true on a single activity are done. Day 2: {r:"v"} on a checklist is done; sub-ticks with one false on a single activity are not.
  fx := fx || '{
      "name": "06 leftover single tick on a checklist (and leftover sub-ticks on a single)",
      "progs": [{"type":"checklist","schedule":"daily","createdAt":"2026-10-01","id":"k","subItems":[{"id":"s1","name":"x"},{"id":"s2","name":"y"}]},{"type":"simple","schedule":"daily","createdAt":"2026-10-01","id":"m"}],
      "trash": [],
      "log": {"2026-10-05":{"k":true,"m":{"s1":true,"s2":true}},"2026-10-06":{"k":{"r":"v"},"m":{"s1":true,"s2":false}}},
      "ids": null,
      "dates": ["2026-10-05","2026-10-06"],
      "want": "2026-10-05=2/2/0/0/200; 2026-10-06=2/1/0/0/100"
    }'::jsonb;

  -- Fixture 07 weekday-only activity (Mon + Wed)
  --   An activity for Monday + Wednesday only: counts on Mon 5 Oct and Wed 7 Oct, not on Tue 6 Oct.
  fx := fx || '{
      "name": "07 weekday-only activity (Mon + Wed)",
      "progs": [{"type":"simple","schedule":[1,3],"createdAt":"2026-10-01","id":"w"}],
      "trash": [],
      "log": {},
      "ids": null,
      "dates": ["2026-10-05","2026-10-06","2026-10-07"],
      "want": "2026-10-05=1/0/0/0/0; 2026-10-06=0/0/0/0/0; 2026-10-07=1/0/0/0/0"
    }'::jsonb;

  -- Fixture 08 schedule history (sh): old weekdays kept for old days
  --   Schedule history (sh). "s" was Mon+Wed before 7 Oct and is Tue from 7 Oct on. "q" had two old schedules (Sunday only before 3 Oct, Monday only before 7 Oct, daily after). The FIRST entry whose day is later than the date wins.
  fx := fx || '{
      "name": "08 schedule history (sh): old weekdays kept for old days",
      "progs": [{"type":"simple","schedule":[2],"createdAt":"2026-10-01","id":"s","sh":[{"u":"2026-10-07","s":[1,3]}]},{"type":"simple","schedule":"daily","createdAt":"2026-10-01","id":"q","sh":[{"u":"2026-10-03","s":[7]},{"u":"2026-10-07","s":[1]}]}],
      "trash": [],
      "log": {},
      "ids": null,
      "dates": ["2026-10-02","2026-10-04","2026-10-05","2026-10-06","2026-10-07","2026-10-12","2026-10-13"],
      "want": "2026-10-02=0/0/0/0/0; 2026-10-04=0/0/0/0/0; 2026-10-05=2/0/0/0/0; 2026-10-06=0/0/0/0/0; 2026-10-07=1/0/0/0/0; 2026-10-12=1/0/0/0/0; 2026-10-13=2/0/0/0/0"
    }'::jsonb;

  -- Fixture 09 shape history (vh): old days judged by their own shape
  --   Shape history (vh). v1 is single now but was a checklist before 7 Oct; v2 is a checklist now but was single before 7 Oct. Old days are judged by their own shape.
  fx := fx || '{
      "name": "09 shape history (vh): old days judged by their own shape",
      "progs": [{"type":"simple","schedule":"daily","createdAt":"2026-10-01","id":"v1","vh":[{"u":"2026-10-07","t":"checklist","s":[{"id":"s1"},{"id":"s2"}]}]},{"type":"checklist","schedule":"daily","createdAt":"2026-10-01","id":"v2","subItems":[{"id":"s1"},{"id":"s2"}],"vh":[{"u":"2026-10-07","t":"simple"}]}],
      "trash": [],
      "log": {"2026-10-05":{"v1":{"s1":true,"s2":true},"v2":{"r":"p","p":60}},"2026-10-06":{"v1":{"s1":true},"v2":{"s1":true,"s2":true}},"2026-10-07":{"v1":true,"v2":{"s1":true,"s2":true}}},
      "ids": null,
      "dates": ["2026-10-05","2026-10-06","2026-10-07"],
      "want": "2026-10-05=2/1/1/0/160; 2026-10-06=2/1/0/0/100; 2026-10-07=2/2/0/0/200"
    }'::jsonb;

  -- Fixture 10 createdAt later than the day: not counted
  --   An activity created on 8 Oct does not count on 5 Oct (nothing ticked then) but counts on 8 Oct.
  fx := fx || '{
      "name": "10 createdAt later than the day: not counted",
      "progs": [{"type":"simple","schedule":"daily","createdAt":"2026-10-08","id":"a"}],
      "trash": [],
      "log": {},
      "ids": null,
      "dates": ["2026-10-05","2026-10-08"],
      "want": "2026-10-05=0/0/0/0/0; 2026-10-08=1/0/0/0/0"
    }'::jsonb;

  -- Fixture 11 tick/note before createdAt: real history still counts
  --   Real history is never hidden: a tick (5 Oct) or a note (6 Oct) before the start day makes the day count. An erased note ("") is not an entry (7 Oct).
  fx := fx || '{
      "name": "11 tick/note before createdAt: real history still counts",
      "progs": [{"type":"simple","schedule":"daily","createdAt":"2026-10-08","id":"a"}],
      "trash": [],
      "log": {"2026-10-05":{"a":true},"2026-10-06":{"a":{"n":"hello"}},"2026-10-07":{"a":{"n":""}}},
      "ids": null,
      "dates": ["2026-10-05","2026-10-06","2026-10-07"],
      "want": "2026-10-05=1/1/0/0/100; 2026-10-06=1/0/0/0/0; 2026-10-07=0/0/0/0/0"
    }'::jsonb;

  -- Fixture 12 ghost: counted before endsOn, not on or after it
  --   A deleted activity (ghost) counts before the day it was deleted (7 Oct, 12:00 local) and not on or after that day, even if it was ticked on 7 Oct.
  fx := fx || '{
      "name": "12 ghost: counted before endsOn, not on or after it",
      "progs": [{"type":"simple","schedule":"daily","createdAt":"2026-10-01","id":"a"}],
      "trash": [{"id":"t1","kind":"program","data":{"type":"simple","schedule":"daily","createdAt":"2026-10-01","id":"g1"},"deletedAt":"2026-10-07T09:00:00.000Z"}],
      "log": {"2026-10-06":{"g1":true},"2026-10-07":{"g1":true}},
      "ids": null,
      "dates": ["2026-10-06","2026-10-07","2026-10-08"],
      "want": "2026-10-06=2/1/0/0/100; 2026-10-07=1/0/0/0/0; 2026-10-08=1/0/0/0/0"
    }'::jsonb;

  -- Fixture 13 ghost: deleted at 22:30 UTC = next local day; newest trash entry wins; live id is not a ghost
  --   Deleted at 22:30 UTC = 01:30 the NEXT day in Addis Ababa, so it stops on 8 Oct. When one id is in the bin twice, the first (newest) entry wins (g3 ends 9 Oct). A bin entry whose id is live (live1) or a page entry is not a ghost.
  fx := fx || '{
      "name": "13 ghost: deleted at 22:30 UTC = next local day; newest trash entry wins; live id is not a ghost",
      "progs": [{"type":"simple","schedule":"daily","createdAt":"2026-10-01","id":"live1"}],
      "trash": [{"id":"t2","kind":"program","data":{"type":"simple","schedule":"daily","createdAt":"2026-10-01","id":"g2"},"deletedAt":"2026-10-07T22:30:00.000Z"},{"id":"t3","kind":"program","data":{"type":"simple","schedule":"daily","createdAt":"2026-10-01","id":"g3"},"deletedAt":"2026-10-09T08:00:00.000Z"},{"id":"t4","kind":"program","data":{"type":"simple","schedule":"daily","createdAt":"2026-10-01","id":"g3"},"deletedAt":"2026-10-03T08:00:00.000Z"},{"id":"t5","kind":"program","data":{"type":"simple","schedule":"daily","createdAt":"2026-10-01","id":"live1"},"deletedAt":"2026-10-02T08:00:00.000Z"},{"id":"t6","kind":"page","data":{"id":"pg"},"deletedAt":"2026-10-02T08:00:00.000Z"}],
      "log": {},
      "ids": null,
      "dates": ["2026-10-05","2026-10-07","2026-10-08","2026-10-09"],
      "want": "2026-10-05=3/0/0/0/0; 2026-10-07=3/0/0/0/0; 2026-10-08=2/0/0/0/0; 2026-10-09=1/0/0/0/0"
    }'::jsonb;

  -- Fixture 14 off range [from, to) = days spent in the bin
  --   Days spent in the bin before a restore ("off" = [5 Oct, 8 Oct)): 5, 6, 7 Oct do not count; 8 Oct counts again.
  fx := fx || '{
      "name": "14 off range [from, to) = days spent in the bin",
      "progs": [{"type":"simple","schedule":"daily","createdAt":"2026-10-01","id":"a","off":[["2026-10-05","2026-10-08"]]}],
      "trash": [],
      "log": {},
      "ids": null,
      "dates": ["2026-10-04","2026-10-05","2026-10-07","2026-10-08"],
      "want": "2026-10-04=1/0/0/0/0; 2026-10-05=0/0/0/0/0; 2026-10-07=0/0/0/0/0; 2026-10-08=1/0/0/0/0"
    }'::jsonb;

  -- Fixture 15a scope by ids: only b
  --   Only activity b is asked for: a and the ghost ga are left out.
  fx := fx || '{
      "name": "15a scope by ids: only b",
      "progs": [{"type":"simple","schedule":"daily","createdAt":"2026-10-01","id":"a"},{"type":"simple","schedule":"daily","createdAt":"2026-10-01","id":"b"}],
      "trash": [{"id":"t1","kind":"program","data":{"type":"simple","schedule":"daily","createdAt":"2026-10-01","id":"ga"},"deletedAt":"2026-10-09T08:00:00.000Z"}],
      "log": {"2026-10-05":{"a":true,"b":true,"ga":true}},
      "ids": ["b"],
      "dates": ["2026-10-05"],
      "want": "2026-10-05=1/1/0/0/100"
    }'::jsonb;

  -- Fixture 15b scope by ids: b and the ghost ga
  --   b and the ghost ga are asked for: a is left out.
  fx := fx || '{
      "name": "15b scope by ids: b and the ghost ga",
      "progs": [{"type":"simple","schedule":"daily","createdAt":"2026-10-01","id":"a"},{"type":"simple","schedule":"daily","createdAt":"2026-10-01","id":"b"}],
      "trash": [{"id":"t1","kind":"program","data":{"type":"simple","schedule":"daily","createdAt":"2026-10-01","id":"ga"},"deletedAt":"2026-10-09T08:00:00.000Z"}],
      "log": {"2026-10-05":{"a":true,"b":true,"ga":true}},
      "ids": ["b","ga"],
      "dates": ["2026-10-05"],
      "want": "2026-10-05=2/2/0/0/200"
    }'::jsonb;

  -- Fixture 15c scope by ids: everybody (null)
  --   Nobody filtered (null): a, b and the ghost ga all count.
  fx := fx || '{
      "name": "15c scope by ids: everybody (null)",
      "progs": [{"type":"simple","schedule":"daily","createdAt":"2026-10-01","id":"a"},{"type":"simple","schedule":"daily","createdAt":"2026-10-01","id":"b"}],
      "trash": [{"id":"t1","kind":"program","data":{"type":"simple","schedule":"daily","createdAt":"2026-10-01","id":"ga"},"deletedAt":"2026-10-09T08:00:00.000Z"}],
      "log": {"2026-10-05":{"a":true,"b":true,"ga":true}},
      "ids": null,
      "dates": ["2026-10-05"],
      "want": "2026-10-05=3/3/0/0/300"
    }'::jsonb;

  -- Fixture 16 note-only counts 0 (but the activity is counted)
  --   A note alone counts as an activity of the day but adds nothing (0 done).
  fx := fx || '{
      "name": "16 note-only counts 0 (but the activity is counted)",
      "progs": [{"type":"simple","schedule":"daily","createdAt":"2026-10-01","id":"a"}],
      "trash": [],
      "log": {"2026-10-05":{"a":{"n":"only a note"}}},
      "ids": null,
      "dates": ["2026-10-05"],
      "want": "2026-10-05=1/0/0/0/0"
    }'::jsonb;

  -- Fixture 17 99.6 percent (4 done + one 98%)
  --   4 activities done + one at 98%: 498 / 5 = 99.6 and the real numbers are t=5, dn=4, sp=498 (the percent itself, 99, is checked below).
  fx := fx || '{
      "name": "17 99.6 percent (4 done + one 98%)",
      "progs": [{"type":"simple","schedule":"daily","createdAt":"2026-10-01","id":"a"},{"type":"simple","schedule":"daily","createdAt":"2026-10-01","id":"b"},{"type":"simple","schedule":"daily","createdAt":"2026-10-01","id":"c"},{"type":"simple","schedule":"daily","createdAt":"2026-10-01","id":"d"},{"type":"simple","schedule":"daily","createdAt":"2026-10-01","id":"e"}],
      "trash": [],
      "log": {"2026-10-05":{"a":true,"b":true,"c":true,"d":true,"e":{"r":"p","p":98}}},
      "ids": null,
      "dates": ["2026-10-05"],
      "want": "2026-10-05=5/4/1/0/498"
    }'::jsonb;

  -- Fixture 18 half rounds up (100 + 49 over 2 = 74.5)
  --   100% + 49%: sum 149 over 2 activities (74.5, which shows as 75 below).
  fx := fx || '{
      "name": "18 half rounds up (100 + 49 over 2 = 74.5)",
      "progs": [{"type":"simple","schedule":"daily","createdAt":"2026-10-01","id":"a"},{"type":"simple","schedule":"daily","createdAt":"2026-10-01","id":"b"}],
      "trash": [],
      "log": {"2026-10-05":{"a":true,"b":{"r":"p","p":49}}},
      "ids": null,
      "dates": ["2026-10-05"],
      "want": "2026-10-05=2/1/1/0/149"
    }'::jsonb;

  -- Fixture 19 no createdAt: starts at the first real entry; one with no entry at all is skipped
  --   Hand calculation: n1 has no start day, so it starts on its first real entry, 6 Oct. 5 Oct: not counted. 6 Oct: ticked = 1 done (100). 7 Oct: counts, nothing ticked. 8 Oct: counts, cross = 1 not done. n2 has no start day and no entry at all, so it is skipped (reported as 1).
  fx := fx || '{
      "name": "19 no createdAt: starts at the first real entry; one with no entry at all is skipped",
      "progs": [{"id":"n1","type":"simple","schedule":"daily"},{"id":"n2","type":"simple","schedule":"daily"}],
      "trash": [],
      "log": {"2026-10-06":{"n1":true},"2026-10-08":{"n1":{"r":"x"}}},
      "ids": null,
      "dates": ["2026-10-05","2026-10-06","2026-10-07","2026-10-08"],
      "skipped": 1,
      "want": "2026-10-05=0/0/0/0/0; 2026-10-06=1/1/0/0/100; 2026-10-07=1/0/0/0/0; 2026-10-08=1/0/0/1/0"
    }'::jsonb;

  -- ------------------------------------------------------------------------
  -- Run every fixture through the calculator and compare.
  -- ------------------------------------------------------------------------
  for f in select x.e from jsonb_array_elements(fx) as x(e) loop
    ids_arr   := case when jsonb_typeof(f -> 'ids') = 'array'
                      then array(select jsonb_array_elements_text(f -> 'ids'))
                      else null end;
    dates_arr := array(select jsonb_array_elements_text(f -> 'dates')::date);

    select coalesce(string_agg(format('%s=%s/%s/%s/%s/%s', c.d, c.t, c.dn, c.pt, c.fl, c.sp), '; ' order by c.d), '(no rows)')
      into got
      from public.dash_calc_core(f -> 'progs', f -> 'trash', f -> 'log', ids_arr, dates_arr) c;
    want := f ->> 'want';

    if got is distinct from want then
      raise exception 'SELFTEST FAILED in fixture "%": expected [%] but got [%]', f ->> 'name', want, got;
    end if;

    -- fixtures that also state how many activities must be skipped (no start day, no entry)
    if f ? 'skipped' then
      if public.dash_skipped_count(f -> 'progs', f -> 'trash', f -> 'log') is distinct from (f ->> 'skipped')::int then
        raise exception 'SELFTEST FAILED in fixture "%": expected % skipped activities but got %',
          f ->> 'name', f ->> 'skipped', public.dash_skipped_count(f -> 'progs', f -> 'trash', f -> 'log');
      end if;
    end if;

    n_run := n_run + 1;
  end loop;

  -- ------------------------------------------------------------------------
  -- The percent rule: [sum of percents, activities, full ticks, expected percent].
  -- Expected values come from the real mkStat() of main.js.
  -- 498 over 5 with 4 done is 99.6 and must show 99, never 100.
  -- ------------------------------------------------------------------------
  for f in select x.e from jsonb_array_elements('[[498,5,4,99],[500,5,5,100],[149,2,1,75],[57,2,0,29],[160,3,1,53],[0,3,0,0],[100,1,1,100],[199,2,1,99],[1,1,0,1]]'::jsonb) as x(e) loop
    if public.dash_pct((f ->> 0)::numeric, (f ->> 1)::int, (f ->> 2)::int) is distinct from (f ->> 3)::int then
      raise exception 'SELFTEST FAILED in the percent rule for %: expected %, got %',
        f, f ->> 3, public.dash_pct((f ->> 0)::numeric, (f ->> 1)::int, (f ->> 2)::int);
    end if;
    n_run := n_run + 1;
  end loop;
  -- nothing to do at all shows no percent (null), not 0
  if public.dash_pct(0, 0, 0) is not null then
    raise exception 'SELFTEST FAILED: a day with nothing to do must give a null percent';
  end if;

  -- ------------------------------------------------------------------------
  -- The locks: no helper may be callable from outside, the table must be closed,
  -- and only app_dash / app_dash_restart may be open to the app (anon).
  -- ------------------------------------------------------------------------
  for r in
    select p.oid, p.oid::regprocedure::text as sig
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname like 'dash\_%'
  loop
    if has_function_privilege('anon', r.oid, 'EXECUTE')
       or has_function_privilege('authenticated', r.oid, 'EXECUTE')
       or has_function_privilege('public', r.oid, 'EXECUTE') then
      raise exception 'LOCK CHECK FAILED: % can still be run from outside', r.sig;
    end if;
  end loop;

  if not has_function_privilege('anon', 'public.app_dash(uuid,date,date,integer[],date[])'::regprocedure::oid, 'EXECUTE')
     or not has_function_privilege('anon', 'public.app_dash_restart(uuid,date,boolean)'::regprocedure::oid, 'EXECUTE') then
    raise exception 'LOCK CHECK FAILED: the app (anon) cannot run app_dash / app_dash_restart';
  end if;

  if has_table_privilege('anon', 'public.app_dash_marks', 'SELECT')
     or has_table_privilege('anon', 'public.app_dash_marks', 'INSERT')
     or has_table_privilege('authenticated', 'public.app_dash_marks', 'SELECT')
     or has_table_privilege('authenticated', 'public.app_dash_marks', 'INSERT') then
    raise exception 'LOCK CHECK FAILED: app_dash_marks can be reached from outside';
  end if;

  if not (select c.relrowsecurity from pg_class c where c.oid = 'public.app_dash_marks'::regclass) then
    raise exception 'LOCK CHECK FAILED: row level security is OFF on app_dash_marks';
  end if;

  raise notice 'ALL PASS (% checks)', n_run;
end
$selftest$;

-- If the exam above passed, this line shows up as the result (an exam that fails stops before it).
select 'ALL PASS' as selftest_result;

-- ============================================================================
-- COMPARE WITH THE APP (run this ONE line on its own, after ALL PASS):
-- It shows today's overall numbers for everybody, straight from the real data.
-- Open the app as the admin and compare:  total = how many activities today,
-- done = full ticks, partly = 1-99%, not_done = crosses, pct = the ring percent.
-- skipped_activities should be 0 (those are activities with no start day and no entry).
--
-- select d as day, t as total, dn as done, pt as partly, fl as not_done, sp, public.dash_pct(sp, t, dn) as pct, public.dash_skipped() as skipped_activities from public.dash_calc(null, array[app_today()::date]);
-- ============================================================================
