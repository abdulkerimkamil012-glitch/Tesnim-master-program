-- ============================================================================
-- 00_audit.sql  (Part B1)  -  READ-ONLY look around your database
-- ----------------------------------------------------------------------------
-- This file only READS. It changes nothing. Run it as ONE query: you get ONE
-- table with three columns (section, item, detail). Save the result (the Export
-- button above the result table, or copy it) and keep it. Part B5 will ask for it.
--
-- What you will see, section by section:
--   RLS             is the "row level security" lock ON or OFF for each app_ table
--   TABLE GRANTS    what the public roles (anon / authenticated) may do with each app_ table
--   FUNCTION GRANTS who may run each function in the public schema (YES = can be called from outside)
--   SOURCE          the full code of _me and app_today
--   TRIGGER         any trigger in the public schema, with its code (or "none found")
--   APP_CONFIG      each row of app_config: the key and the first 60 letters of its value
--   SESSIONS        how many login sessions exist and the oldest / newest one
--
-- PRIVACY TIP: before you paste the result anywhere, look at the APP_CONFIG rows.
-- If a value looks like a password or a secret key, replace it with *** first.
-- ============================================================================

select section, item, detail
from (

  -- 1) Row level security (RLS) for every app_ table, and how many policies exist.
  select 1 as ord, 'RLS' as section, c.relname::text as item,
         (case when c.relrowsecurity then 'ON' else 'OFF' end)
           || (case when c.relforcerowsecurity then ' (forced)' else '' end)
           || ' | policies: '
           || (select count(*) from pg_policies pp
                where pp.schemaname = 'public' and pp.tablename = c.relname)::text as detail
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relname like 'app\_%'

  union all

  -- 2) What anon and authenticated may do with each app_ table.
  select 2, 'TABLE GRANTS', c.relname::text || ' -> ' || r.rn,
         coalesce(nullif(concat_ws(', ',
           case when has_table_privilege(r.rn::name, c.oid, 'SELECT') then 'SELECT' end,
           case when has_table_privilege(r.rn::name, c.oid, 'INSERT') then 'INSERT' end,
           case when has_table_privilege(r.rn::name, c.oid, 'UPDATE') then 'UPDATE' end,
           case when has_table_privilege(r.rn::name, c.oid, 'DELETE') then 'DELETE' end), ''), 'none')
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  cross join (values ('anon'), ('authenticated')) as r(rn)
  where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relname like 'app\_%'

  union all

  -- 3) Who may run each function in the public schema.
  select 3, 'FUNCTION GRANTS', p.oid::regprocedure::text,
         'anon=' || (case when has_function_privilege('anon'::name, p.oid, 'EXECUTE') then 'YES' else 'no' end)
         || ' | authenticated=' || (case when has_function_privilege('authenticated'::name, p.oid, 'EXECUTE') then 'YES' else 'no' end)
         || ' | PUBLIC=' || (case when has_function_privilege('public'::name, p.oid, 'EXECUTE') then 'YES' else 'no' end)
         || ' | security definer=' || (case when p.prosecdef then 'yes' else 'no' end)
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prokind = 'f'
    and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')

  union all

  -- 4) The full source code of _me and app_today.
  select 4, 'SOURCE', p.oid::regprocedure::text, pg_get_functiondef(p.oid)
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in ('_me', 'app_today')

  union all

  -- 5) Triggers in the public schema (with their code), or a line saying there are none.
  select 5, 'TRIGGER', t.tgname::text || ' on ' || c.relname::text,
         pg_get_triggerdef(t.oid) || E'\n\n' || pg_get_functiondef(t.tgfoid)
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and not t.tgisinternal

  union all

  select 5, 'TRIGGER', '(none found)', ''
  where not exists (
    select 1
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and not t.tgisinternal
  )

  union all

  -- 6) app_config: every key and the first 60 letters of its value.
       select 6, 'APP_CONFIG', cfg.key, '*** hidden (' || length(coalesce(cfg.value,'')) || ' letters)'
  from public.app_config cfg

  union all

  -- 7) Login sessions: how many, the oldest and the newest.
  select 7, 'SESSIONS', 'how many sessions', count(*)::text from public.app_sessions
  union all
  select 7, 'SESSIONS', 'oldest created_at', coalesce(min(s.created_at)::text, '(none)') from public.app_sessions s
  union all
  select 7, 'SESSIONS', 'newest created_at', coalesce(max(s.created_at)::text, '(none)') from public.app_sessions s

) q
order by ord, section, item;
