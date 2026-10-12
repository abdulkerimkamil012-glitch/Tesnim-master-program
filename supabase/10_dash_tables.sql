-- ============================================================================
-- 10_dash_tables.sql  (Part B1)  -  the ONE new table for the Dashboard
-- ----------------------------------------------------------------------------
-- What it does: creates app_dash_marks, a small notebook where the admin's
-- "start counting from today" marks are written down (one line per mark).
-- Safe to run twice. It does not touch any existing table or function.
-- ============================================================================

-- 1) The notebook itself.
--    start_date = the day counting restarts from.  NULL means "no restart:
--    count all history".  The newest line is the one that counts.
create table if not exists public.app_dash_marks (
  id          bigint generated always as identity primary key,
  start_date  date null,
  by_name     text,
  created_at  timestamptz default now()
);

-- 2) Lock the door: Row Level Security ON, and we add NO policies on purpose.
--    That means nobody using the public key can read or write this table
--    directly. Only our own server functions (which run as the owner) can.
alter table public.app_dash_marks enable row level security;

-- 3) Take away every permission the public roles might have received by default.
revoke all on table public.app_dash_marks from public, anon, authenticated;

-- 4) The numbering machine (sequence) behind the id column gets the same lock.
do $lock$
declare sq text;
begin
  sq := pg_get_serial_sequence('public.app_dash_marks', 'id');
  if sq is not null then
    execute format('revoke all on sequence %s from public, anon, authenticated', sq);
  end if;
end
$lock$;
