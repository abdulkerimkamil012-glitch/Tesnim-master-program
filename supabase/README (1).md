# supabase/ — the server side of the Dashboard (Part B1)

This folder holds SQL files. You paste them into **Supabase > SQL Editor**; they are not part of the website build.
Part B1 builds only the **calculation engine**. The Dashboard page itself comes in Part B2.

## The files, in the order you run them

| File | What it does | What you should see |
|---|---|---|
| `00_audit.sql` | Only READS. Shows locks (RLS), permissions, the code of `_me` and `app_today`, `app_config` and the sessions. | One result table. Save it (Export) — Part B5 needs it. |
| `10_dash_tables.sql` | Creates the small table `app_dash_marks` (restart notebook) and locks it. | `Success. No rows returned` |
| `11_dash_functions.sql` | Creates the calculator, `app_dash` and `app_dash_restart`, and locks every helper. | `Success. No rows returned` |
| `12_dash_selftest.sql` | The exam: 19 made-up situations + the percent rule + the lock check. Touches no data. | A result row: **ALL PASS** |
| `19_rollback_dash.sql` | Removes only what B1 added. | `Success. No rows returned` |

Run `10`, then `11`, then `12`. Running a file twice is safe.

## Compare with the app (after ALL PASS)

Paste this ONE line alone in a new query and Run, then open the app as the admin and compare today's ring:

```sql
select d as day, t as total, dn as done, pt as partly, fl as not_done, sp, public.dash_pct(sp, t, dn) as pct, public.dash_skipped() as skipped_activities from public.dash_calc(null, array[app_today()::date]);
```

`total / done / partly / not_done` should match the numbers behind the admin ring. `skipped_activities` should be 0.

## What the engine returns (for Part B2)

`app_dash(token, from, to, weekdays, dates)` returns JSON: `today`, `scope` (`all` or `own`), `start`, `marks`, `days`, `sum`, `since`.

* Admin or an "all programs" user: scope `all`, full counts for everything.
* A restricted member: scope `own`. The overall picture `o` has ONLY `pct`, `full`, `has` (no counts, no names). `m` holds the member's own activities in full.
* Errors come back as the text `auth` (bad token), `denied` (not admin) or `range` (bad or too large range).
* Limits: at most 120 exact dates, or at most 400 days in a range. Days after today are dropped.
* `app_dash_restart(token, start, clear)`: admin only. No start = today. A start in the future or more than 1000 days back gives `range`. `clear = true` means "count all history again". Marks are never deleted; the newest one counts.

## Where to change things

* **Time zone** used to find the day an activity was deleted: the function `dash_tz()` at the top of `11_dash_functions.sql` (now `Africa/Addis_Ababa`). Change it there and run the file again.
* **"Today"** always comes from your existing `app_today()`.

## Three things that differ from the phone on purpose (please read)

1. **Deleted activities of a restricted member.** `app_get` sends an EMPTY recycle bin to restricted phones, so their own deleted activities never show on the phone. The Dashboard follows the shared contract instead: it counts a member's own deleted activities on the days before they were deleted. So a member's past-day percent on the Dashboard can be slightly different from their phone.
2. **No start day.** The phone uses "the day this phone first ran" for an activity without `createdAt`. The server cannot know that, so it uses the activity's first day with a real entry; an activity with no start day and no entry at all is left out. `dash_skipped()` tells you how many (normally 0).
3. **Deletion day.** The phone uses its own local date; the server uses `dash_tz()`. They agree when the phone is in the same time zone.

## Safety notes

* Nothing here changes an existing table or function (`admin_*`, `app_get`, `app_login`, `app_put`, `app_put_log`, `_me`, `app_today`).
* Every `dash_` helper is locked: it cannot be called from the website or the app. Only `app_dash` and `app_dash_restart` are open to the public key, and both check the login token first.
* The `marks` list shows the admin's username (field `by`). That is part of the shared contract.
* Before you paste the `00_audit.sql` result anywhere, hide any secret that appears in the `APP_CONFIG` rows.

## If something fails

* An error that starts with `SELFTEST FAILED` or `LOCK CHECK FAILED`: copy the whole message and send it to me. Nothing in your data was changed.
* `relation "app_dash_marks" does not exist`: run `10_dash_tables.sql` first.
* To undo everything: run `19_rollback_dash.sql`.
