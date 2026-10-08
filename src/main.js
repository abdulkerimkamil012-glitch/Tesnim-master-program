// Categories (Bundle A part 4): one canonical name per category, a picker instead of free typing, rename / merge / delete for a whole category, grouped list. History safety (Bundle A parts 1-2): adding, deleting, restoring, re-scheduling, adding/removing sub-items or switching single <-> master never changes a day that is already over. Phase 3A part 4: the ring, reports, statistics and calendar understand ✗ / % / notes (60% counts as 60; the streak still needs a full ✓). Part 3: a note per activity per day (📝). Part 2: results ✓ done, ✗ not done, 1-99% partly done.
import './style.css';
import { MEALS as SEED_MEALS, DAILY as SEED_DAILY, INFO_PAGES as SEED_PAGES, WD } from './data.js';

/* ============================================================
   STORAGE KEYS — everything the app remembers lives under these.
   ============================================================ */
const LS_PROGRAMS = 'tesnim_programs', LS_LOG = 'tesnim_log', LS_DOV = 'tesnim_dayov',
      LS_TH = 'tesnim_theme', LS_REM = 'tesnim_reminder', LS_PAGES = 'tesnim_pages', LS_FIRST = 'tesnim_first',
      LS_TRASH = 'tesnim_trash', LS_REMOVEDSEEDS = 'tesnim_removed_seeds';

/* ---- tiny helpers ---- */
const pad = n => String(n).padStart(2, '0');
const fmt = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseDs = ds => { const [y, m, d] = ds.split('-').map(Number); return new Date(y, m - 1, d); };
const today = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pDay = d => { const g = d.getDay(); return g === 0 ? 7 : g; }; // 1=Mon..7=Sun
const uid = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const $ = id => document.getElementById(id);
let ghostCache = null;   // deleted activities that still count on the days before they were deleted (see countsOn)
const PDAY_LABELS = ['ሰኞ', 'ማክሰኞ', 'ረቡዕ', 'ሐሙስ', 'አርብ', 'ቅዳሜ', 'እሁድ'];

// The date this app first ever ran on this phone/browser. Used as the
// "started on" date for seed programs, so all-time statistics have a
// sensible starting point instead of counting days before they existed.
let FIRST_RUN = localStorage.getItem(LS_FIRST);
if (!FIRST_RUN) { FIRST_RUN = fmt(today()); localStorage.setItem(LS_FIRST, FIRST_RUN); }

/* ============================================================
   ROLE + DAY LOCK (written by public/cloud.js after login).
   ROLE.r    = restricted user: sees ONLY the activities the server sent
               (we must never re-add built-in activities for them).
   ROLE.tick = may tick at all.   ROLE.past = may change PAST days.
   Rule: everyone edits only TODAY; past days only with ROLE.past;
   future days never. The server enforces the same rule (app_put_log).
   ============================================================ */
const ROLE = { r: false, past: false, tick: true };
try { Object.assign(ROLE, JSON.parse(localStorage.getItem('tesnim_role') || '{}')); } catch (e) { /* keep safe defaults */ }
const dayEditable = ds => { const t = fmt(today()); return ds === t ? ROLE.tick : (ds < t && ROLE.past && ROLE.tick); };
const lockToast = ds => toast(!ROLE.tick ? '🔒 ምልክት የማድረግ ፈቃድ የለዎትም' : (ds > fmt(today()) ? '🔒 የወደፊት ቀን ምልክት ማድረግ አይቻልም' : '🔒 ያለፈ ቀን ማስተካከል አይቻልም'));

// Ids of seed (data.js-sourced) programs/pages the person has deliberately
// deleted from within the app. Without this set, syncSeedPrograms/
// syncSeedPages below would silently re-add a deleted-but-never-customized
// seed item the next time the app loads — this is what makes a Recycle Bin
// deletion (and its Restore button, further down) actually mean something
// for the built-in meals/reminders/pages, not just for ones you added.
let removedSeedIds = new Set(JSON.parse(localStorage.getItem(LS_REMOVEDSEEDS) || '[]'));
const saveRemovedSeeds = () => localStorage.setItem(LS_REMOVEDSEEDS, JSON.stringify([...removedSeedIds]));
const markSeedRemoved = (kind, item) => { if (item.seed && !item.customized) { removedSeedIds.add(kind + ':' + item.id); saveRemovedSeeds(); } };
const unmarkSeedRemoved = (kind, id) => { if (removedSeedIds.delete(kind + ':' + id)) saveRemovedSeeds(); };

/* ---- bullet renderer: "+" separates items on one line, "\n" starts a new line/section ----
   Turns a wall-of-text ingredient line into a scannable bullet list. Only
   touches how text is DISPLAYED — editing still uses plain "+"/"\n" text. */
function descHtml(desc) {
  return String(desc ?? '').split('\n').map(line => {
    const items = line.split('+').map(s => s.trim()).filter(Boolean);
    if (items.length > 1) return '<ul class="ing-list">' + items.map(i => `<li>${esc(i)}</li>`).join('') + '</ul>';
    return line.trim() ? `<div class="ing-line">${esc(line.trim())}</div>` : '';
  }).join('');
}

/* ============================================================
   PROGRAMS: everything you can tick is a "program" object, stored in
   localStorage so add/edit/delete all work from the UI:
   { id, name, desc, category, type:'simple'|'checklist',
     subItems:[{id,name}] (checklist only), schedule:'daily'|[1..7],
     seed, customized, createdAt }
   `seed:true`      = originally came from data.js (a meal or reminder).
   `customized:true`= you've permanently edited it from within the app —
                       from then on, fixing the text in data.js will NOT
                       silently overwrite your own wording (see
                       syncSeedPrograms below, which is the fix for the
                       "editing data.js doesn't reach phones that already
                       used the app" issue).
   ============================================================ */
function buildSeedPrograms() {
  const arr = [];
  for (const day in SEED_MEALS) {
    SEED_MEALS[day].forEach(t => arr.push({ id: t.id, name: t.name, desc: t.desc, type: 'simple', category: 'ምግብ', schedule: [Number(day)] }));
  }
  SEED_DAILY.forEach(t => arr.push({ id: t.id, name: t.name, desc: t.desc, type: 'simple', category: 'ማሳሰቢያ', schedule: 'daily' }));
  return arr;
}

let programs = JSON.parse(localStorage.getItem(LS_PROGRAMS) || 'null');
const isFirstRun = !programs;
if (!programs) programs = [];

function syncSeedPrograms() {
  const seedList = buildSeedPrograms();
  const seedIds = new Set(seedList.map(s => s.id));
  seedList.forEach(seed => {
    if (removedSeedIds.has('program:' + seed.id)) return; // deliberately deleted — stays gone until restored from the Recycle Bin
    const idx = programs.findIndex(p => p.id === seed.id);
    if (idx === -1) {
      // Brand-new seed item (first run, or added to data.js later) — add it.
      programs.push({ ...seed, seed: true, customized: false, createdAt: FIRST_RUN });
    } else if (!programs[idx].customized) {
      // Not personally edited yet — safe to refresh its text/fields from data.js.
      const old = programs[idx];
      // data.js moved this meal to other weekdays: days that are already over keep the old weekdays.
      const sh = Array.isArray(old.sh) ? old.sh.slice() : [];
      if (!sameSched(old.schedule, seed.schedule) && (old.createdAt || FIRST_RUN) < fmt(today()) && !(sh.length && sh[sh.length - 1].u === fmt(today()))) sh.push({ u: fmt(today()), s: copySched(old.schedule) });
      programs[idx] = { ...seed, ...(old.catSet ? { category: old.category, catSet: true } : {}), seed: true, customized: false, createdAt: old.createdAt || FIRST_RUN, ...(sh.length ? { sh } : {}), ...(Array.isArray(old.off) ? { off: old.off } : {}), ...(Array.isArray(old.vh) ? { vh: old.vh } : {}) };
    }
    // If customized, it's the person's own now — data.js no longer touches it.
  });
  // A seed item removed from data.js, and never customized, quietly disappears too.
  programs = programs.filter(p => !(p.seed && !p.customized && !seedIds.has(p.id)));
}
if (!ROLE.r) syncSeedPrograms(); // restricted users get exactly the list the server sends — never re-add built-ins

if (isFirstRun) {
  // Carry over permanent text edits from a much older single-file version, if any.
  try {
    const oldOv = JSON.parse(localStorage.getItem('tesnim_ov') || '{}');
    Object.keys(oldOv).forEach(id => {
      const p = programs.find(x => x.id === id);
      if (p) {
        if (oldOv[id].name) p.name = oldOv[id].name;
        if (oldOv[id].desc !== undefined) p.desc = oldOv[id].desc;
        p.customized = true;
      }
    });
  } catch (e) { /* ignore malformed old data */ }
}
programs.forEach(p => { if (p && !p.createdAt) p.createdAt = FIRST_RUN; });   // an activity with no start day starts on the day the app first ran (never "since the beginning of time")
const savePrograms = () => { ghostCache = null; localStorage.setItem(LS_PROGRAMS, JSON.stringify(programs)); };
savePrograms();

let logs = JSON.parse(localStorage.getItem(LS_LOG) || '{}');       // logs[ds][id]: see "RESULTS" below
let dayOv = JSON.parse(localStorage.getItem(LS_DOV) || '{}');      // "today only" edit overrides: dayOv[ds][id] = {name,desc}
let sel = today(), editId = null, lastPct = null;
const persist = () => { localStorage.setItem(LS_LOG, JSON.stringify(logs)); localStorage.setItem(LS_DOV, JSON.stringify(dayOv)); };
const toast = m => { const t = $('toast'); t.textContent = m; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2200); };

/* ============================================================
   RECYCLE BIN (ቆሻሻ መጣያ): every deleted program/page is kept here
   FOREVER (in localStorage), until you Restore it or delete it
   forever from the dedicated Recycle Bin view (⚙ Settings → 🗑).
   This sits underneath the 5-second Undo bar below: Undo removes the
   entry here too, the moment you use it, so nothing is ever double-kept.
   trash[i] = { id, kind:'program'|'page', data:<full saved object>, deletedAt }
   ============================================================ */
let trash = JSON.parse(localStorage.getItem(LS_TRASH) || '[]');
/* ---------- CATEGORIES (Bundle A part 4) ----------
   A category is the name written on its activities (it travels with them to every phone, so no server change is needed).
   Two spellings that differ only by spaces / capital letters ("ምግብ" and "ምግብ ") are ONE category: catKey() is what is compared.
   Everything that writes a category goes through canonCat(), so a duplicate can never be created again. */
const LS_CATFOLD = 'tesnim_catfold';
function catClean(s) { return String(s == null ? '' : s).normalize('NFC').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim().slice(0, 30); }
const catKey = s => catClean(s).toLowerCase();
function categories() {   // [{key, name, count}] in order of first appearance; name = the spelling used most
  const map = new Map();
  programs.forEach(p => {
    const k = catKey(p.category); if (!k) return;
    let g = map.get(k); if (!g) map.set(k, g = { key: k, sp: {}, count: 0 });
    const n = catClean(p.category); g.count++; g.sp[n] = (g.sp[n] || 0) + 1;
  });
  return [...map.values()].map(g => ({ key: g.key, count: g.count, name: Object.entries(g.sp).sort((a, b) => b[1] - a[1])[0][0] }));
}
function canonCat(input) {   // what to store: the existing spelling if this category already exists, else the cleaned new name
  const c = catClean(input); if (!c) return '';
  const f = categories().find(x => x.key === catKey(c)); return f ? f.name : c;
}
let catFold = new Set(); try { catFold = new Set(JSON.parse(localStorage.getItem(LS_CATFOLD) || '[]')); } catch (e) { catFold = new Set(); }   // folded groups on THIS phone
const saveFold = () => { try { localStorage.setItem(LS_CATFOLD, JSON.stringify([...catFold])); } catch (e) { /* storage full: folding just is not remembered */ } };
function catPickInner(cur) {
  const cats = categories(), key = catKey(cur), isNew = !!key && !cats.some(c => c.key === key);
  return `<button type="button" class="catchip${!key ? ' active' : ''}" data-cat="">ያለ ምድብ</button>` +
    cats.map(c => `<button type="button" class="catchip${c.key === key ? ' active' : ''}" data-cat="${esc(c.name)}">${esc(c.name)}</button>`).join('') +
    `<button type="button" class="catchip${isNew ? ' active' : ''}" data-catnew="1">＋ አዲስ ምድብ</button>` +
    `<input type="text" class="catnew" maxlength="30" placeholder="የአዲሱ ምድብ ስም" aria-label="የአዲሱ ምድብ ስም" value="${isNew ? esc(catClean(cur)) : ''}"${isNew ? '' : ' hidden'}>`;
}
const catPickHtml = (id, cur) => `<div class="catpick" id="${id}">${catPickInner(cur)}</div>`;
const fillCat = (id, cur) => { $(id).innerHTML = catPickInner(cur); };
function getCat(id) {   // the category chosen in the picker, ready to store ('' = none)
  const box = $(id); if (!box) return '';
  const on = box.querySelector('.catchip.active'); if (!on) return '';
  return on.dataset.catnew !== undefined ? canonCat(box.querySelector('.catnew').value) : canonCat(on.dataset.cat || '');
}
document.addEventListener('click', e => {   // tapping a category chip (works in the add sheet, the quick edit and the Edit tab)
  const ch = e.target.closest('.catpick .catchip'); if (!ch) return;
  const box = ch.closest('.catpick'); box.querySelectorAll('.catchip').forEach(b => b.classList.toggle('active', b === ch));
  const inp = box.querySelector('.catnew'), isNew = ch.dataset.catnew !== undefined; inp.hidden = !isNew; if (isNew) inp.focus();
});
function renameCat(key, to) {   // rename / merge / delete a whole category (to = '' moves its activities to "no category"); returns how many activities changed
  const name = catClean(to); let target = name;
  if (name) { const ex = categories().find(c => c.key === catKey(name)); if (ex && ex.key !== key) target = ex.name; }   // already exists: merge into its spelling
  let n = 0;
  const upd = (p, live) => { if (catKey(p.category) === key) { p.category = target; p.catSet = true; if (live) n++; } };   // catSet: a data.js refresh must never put the old category back
  programs.forEach(p => upd(p, true));
  trash.forEach(t => { if (t && t.kind === 'program' && t.data) upd(t.data, false); });   // so a restored activity does not bring back the old name
  if (n) { savePrograms(); saveTrash(); }
  return n;
}
const saveTrash = () => { ghostCache = null; localStorage.setItem(LS_TRASH, JSON.stringify(trash)); };
function trashAdd(kind, data) {
  const entry = { id: uid(), kind, data, deletedAt: new Date().toISOString() };
  trash.unshift(entry); saveTrash(); updateTrashBadge();
  return entry.id;
}
function trashRemove(entryId) { trash = trash.filter(t => t.id !== entryId); saveTrash(); updateTrashBadge(); }
// Shows a live count on the ⚙ Settings "Recycle Bin" row, e.g. "🗑 ቆሻሻ መጣያ (3)".
function updateTrashBadge() {
  const b = $('trashBtn'); if (!b) return;
  b.textContent = trash.length ? `🗑 ቆሻሻ መጣያ (${trash.length})` : '🗑 ቆሻሻ መጣያ';
}

/* ---- undo bar, shown for ~5s after deleting a program or a page ---- */
let undoData = null, undoEl = null;
function showUndo(message, restoreFn) {
  undoData = restoreFn;
  if (!undoEl) {
    undoEl = document.createElement('div'); undoEl.className = 'undo glass';
    undoEl.innerHTML = `<span id="undoMsg"></span><button type="button" id="undoBtn">ቀልብስ</button>`;
    document.body.appendChild(undoEl);
    $('undoBtn').onclick = () => { if (undoData) { undoData(); undoData = null; } hideUndo(); };
  }
  $('undoMsg').textContent = message;
  undoEl.classList.add('show');
  clearTimeout(undoEl.t); undoEl.t = setTimeout(hideUndo, 5000);
}
function hideUndo() { if (undoEl) undoEl.classList.remove('show'); }

/* ---------- schedule / completion helpers ---------- */
/* ---------- WHICH ACTIVITIES COUNT ON WHICH DAY (one rule, used by the list, ring, reports, streaks, calendar and statistics) ----------
   An activity counts on a day only if ALL of these are true:
     1. its weekdays (as they were ON THAT DAY - see p.sh) include that weekday;
     2. the day is on/after the day it was created - or something was really ticked / noted on that day (real history is never hidden);
     3. it was not in the Recycle Bin that day (deleted activities keep counting on the days BEFORE they were deleted - see ghosts;
        p.off = days it spent in the bin before being restored).
   So adding, deleting, restoring or re-scheduling an activity never changes a day that is already over. */
function copySched(s) { return Array.isArray(s) ? s.slice() : s; }
function sameSched(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return a === b;
  const x = a.map(Number).sort(), y = b.map(Number).sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}
const schedOn = (p, ds) => { if (Array.isArray(p.sh)) for (const h of p.sh) if (h && ds < h.u) return h.s; return p.schedule; };   // p.sh = [{u:'2026-10-04', s:<weekdays before that day>}] oldest first
const appliesOn = (p, d) => { const s = schedOn(p, fmt(d)); return s === 'daily' || (Array.isArray(s) && s.includes(pDay(d))); };
function hasEntry(ds, p) {   // did the person really tick / mark / note this activity on this day?
  const l = logs[ds] && logs[ds][p.id];
  if (!l) return false;
  return typeof l === 'object' ? Object.keys(l).some(k => l[k]) : true;
}
function assignedIds() {   // the activity ids the server gave this restricted user
  try { const m = JSON.parse(localStorage.getItem('tesnim_me') || 'null'); if (m && Array.isArray(m.programs)) return new Set(m.programs); } catch (e) { /* none */ }
  return new Set();
}
function ghosts() {   // activities that are in the Recycle Bin: they still count on the days before the day they were deleted
  if (ghostCache) return ghostCache;
  const live = new Set(programs.map(p => p.id)), seen = new Set(), mine = ROLE.r ? assignedIds() : null, out = [];
  for (const t of trash) {   // newest deletion first
    const p = t && t.kind === 'program' && t.data;
    if (!p || !p.id || live.has(p.id) || seen.has(p.id)) continue;
    seen.add(p.id);
    const end = new Date(t.deletedAt); if (isNaN(end)) continue;
    if (mine && !mine.has(p.id)) continue;   // a restricted phone must never show someone else's activity
    out.push({ ...p, createdAt: p.createdAt || FIRST_RUN, ghost: true, endsOn: fmt(end) });
  }
  return ghostCache = out;
}
function countsOn(p, d) {
  if (!appliesOn(p, d)) return false;
  const ds = fmt(d);
  if (p.endsOn && ds >= p.endsOn) return false;
  if (Array.isArray(p.off) && p.off.some(g => g && ds >= g[0] && ds < g[1])) return false;
  return ds >= p.createdAt || hasEntry(ds, p);
}
function firstDayOf(p) {   // the first day this activity can count: its start day, or an earlier day that really has a tick / note
  let f = p.createdAt;
  for (const ds in logs) if (ds < f && /^\d{4}-\d{2}-\d{2}$/.test(ds) && hasEntry(ds, p)) f = ds;
  return f;
}
function reinstate(p, delDs) {   // put a deleted activity back: the days it spent in the bin stay "not counted"
  const t = fmt(today());
  if (delDs < t) p.off = (Array.isArray(p.off) ? p.off : []).concat([[delDs, t]]);
}
const tasksFor = d => programs.concat(ghosts()).filter(p => countsOn(p, d));
const disp = (p, ds) => { const o = dayOv[ds] && dayOv[ds][p.id]; return o ? { ...p, ...o } : p; };
/* ---------- RESULTS (Phase 3A part 2) ----------
   What is stored in logs[ds][id]:
     a checklist (master) activity : { subId:true,... }                   (unchanged)
     a simple activity             : false / missing   = nothing marked
                                     true              = ✓ done           (the old format - still valid)
                                     { r:'x' }         = ✗ not done
                                     { r:'p', p:60 }   = partly done, 1-99 %
                                     { n:'text' } or the forms above plus  n:'text'  = a note (part 3, 📝)
                                     a checklist (master) activity keeps its note as  n:'text'  next to its sub-item keys
   Only a full ✓ counts as "done" for the ring, the reports and the streak.
   The server stores any value as-is, so no database change is needed. */
function parseRes(l) {   // one stored value -> { k: '' | 'v' | 'x' | 'p', pct }
  if (!l) return { k: '', pct: 0 };
  if (l === true) return { k: 'v', pct: 100 };
  if (typeof l === 'object') {
    if (l.r === 'x') return { k: 'x', pct: 0 };
    if (l.r === 'v') return { k: 'v', pct: 100 };
    if (l.r === 'p') { const n = Math.round(Number(l.p)); return n >= 100 ? { k: 'v', pct: 100 } : n >= 1 ? { k: 'p', pct: n } : { k: '', pct: 0 }; }
    if (l.r === undefined && Object.prototype.hasOwnProperty.call(l, 'n')) return { k: '', pct: 0 };   // a note with no result yet
  }
  return { k: 'v', pct: 100 };   // any other stored value counts as done, exactly like before
}
/* ---------- THE SHAPE OF AN ACTIVITY ON A DAY (Bundle A part 2) ----------
   An activity is either single (one ✓ / ✗ / %) or a master with sub-items. When the person adds or removes a sub-item, or
   switches single <-> master, the NEW shape starts TODAY: p.vh keeps the shape the activity had before ("vh" = [{u:'2026-10-04', t:'checklist', s:[subItems]}],
   oldest first; every day BEFORE u used that shape). at(p, ds) returns the activity as it was on that day, so old days are judged by their own sub-items.
   Renaming a sub-item is not a change of shape. */
function shapeOn(p, ds) { if (Array.isArray(p.vh)) for (const h of p.vh) if (h && ds < h.u) return h; return p; }
function at(p, ds) {
  const h = shapeOn(p, ds); if (h === p) return p;
  const q = { ...p, type: h.t }; if (h.t === 'checklist') q.subItems = h.s; else delete q.subItems;
  return q;
}
function subsObj(l, q) {   // a master day's value as an object of sub-ticks (a leftover single ✓ means every sub-item was done)
  if (l && typeof l === 'object' && l.r === undefined) return l;
  const o = {};
  if (l === true || (l && l.r === 'v')) (q.subItems || []).forEach(s => { o[s.id] = true; });
  if (l && typeof l === 'object' && typeof l.n === 'string') o.n = l.n;
  return o;
}
function isDone(ds, p) {
  p = at(p, ds);
  const l = logs[ds] && logs[ds][p.id];
  if (!l) return false;
  if (p.type === 'checklist') {
    if (l === true || l.r === 'v') return true;   // a leftover single ✓ from when this was one activity
    return Array.isArray(p.subItems) && p.subItems.length > 0 && p.subItems.every(s => l[s.id] === true);
  }
  return resOf(ds, p).k === 'v';
}
function resOf(ds, p) {   // what to show for this activity on this day
  p = at(p, ds);
  if (p.type === 'checklist') return isDone(ds, p) ? { k: 'v', pct: 100 } : { k: '', pct: 0 };
  const l = logs[ds] && logs[ds][p.id];
  if (l && typeof l === 'object' && l.r === undefined) {   // a leftover master value on a single activity: done only if every sub-tick that was saved is on
    const ks = Object.keys(l).filter(k => k !== 'n');
    if (ks.length) return ks.every(k => l[k] === true) ? { k: 'v', pct: 100 } : { k: '', pct: 0 };
  }
  return parseRes(l);
}
/* ---------- SCORE (Phase 3A part 4) ----------
   How much was really done, as a percent: ✓ = 100, 60% = 60, ✗ or nothing = 0.
   The ring, the day / week reports and the statistics ADD these up, so a 60% counts as 60.
   The STREAK is the one exception: it still needs a full ✓ (isDone), so a ✗ or a % breaks it.
   A note alone never counts for anything. */
function mkStat(sumPct, total, done, part, fail) {   // sumPct = the percents added up; done = full ✓ only; part = 1-99 %; fail = ✗
  const frac = total ? sumPct / (100 * total) : 0;   // 0..1, exact
  // 100% is shown ONLY when every single activity is a full ✓ (99.6% must never round up to 100)
  const pct = !total ? 0 : done === total ? 100 : Math.min(99, Math.round(sumPct / total));   // sumPct / total (not frac * 100): 0.285 * 100 is 28.499999999999996 in JavaScript and would round the wrong way
  return { total, done, part, fail, sumPct, frac, pct };
}
function tally(ds, list) {   // one day: how much of this list was done?
  let sum = 0, done = 0, part = 0, fail = 0;
  list.forEach(p => { const r = resOf(ds, p); sum += r.pct; if (r.k === 'v') done++; else if (r.k === 'p') part++; else if (r.k === 'x') fail++; });
  return mkStat(sum, list.length, done, part, fail);
}
const fracTxt = (done, total, part) => `${done}/${total}` + (part ? ` +${part}◐` : '');   // "3/5", or "3/5 +1◐" when one more was done in part
function itemMark(ds, p) {   // small marks after an activity's name in the day report: 60% / ✗ / 📝
  const r = resOf(ds, p), hasNote = !!noteOf(ds, p);
  return (r.k === 'p' ? ` <b class="rp-m part">${r.pct}%</b>` : r.k === 'x' ? ' <b class="rp-m fail">✗</b>' : '') + (hasNote ? ' <span class="rp-n" aria-hidden="true">📝</span>' : '');
}
function setRes(ds, p, k, pct) {   // k: 'v' | 'x' | 'p' | '' (clear). A note already saved on this day is always kept.
  logs[ds] = logs[ds] || {};
  const old = logs[ds][p.id], n = (old && typeof old === 'object' && typeof old.n === 'string') ? old.n : '';
  let v;
  if (k === 'v') v = n ? { r: 'v', n } : true;
  else if (k === 'x') v = n ? { r: 'x', n } : { r: 'x' };
  else if (k === 'p') v = n ? { r: 'p', p: pct, n } : { r: 'p', p: pct };
  else v = n ? { n } : false;
  logs[ds][p.id] = v;
}
function toggleSimple(ds, p) { setRes(ds, p, parseRes(logs[ds] && logs[ds][p.id]).k === 'v' ? '' : 'v'); }   // a tap: ✓ on; if already ✓ then off; ✗ or % becomes ✓
/* ---------- NOTES (Phase 3A part 3) ----------
   One short note per activity per day, stored INSIDE the same value as the result (see RESULTS above),
   so it syncs, backs up and obeys the day-lock exactly like a tick. Saving a note never changes the result. */
const NOTE_MAX = 500;
const cleanNote = t => Array.from(String(t == null ? '' : t).replace(/\r\n?/g, '\n').trim()).slice(0, NOTE_MAX).join('');
function noteOf(ds, p) {
  const l = logs[ds] && logs[ds][p.id];
  return (l && typeof l === 'object' && typeof l.n === 'string') ? l.n : '';
}
function setNote(ds, p, text) {   // text '' = remove the note. The ✓ / ✗ / % result (or the checklist ticks) is always kept.
  p = at(p, ds);
  const t = cleanNote(text);
  logs[ds] = logs[ds] || {};
  const old = logs[ds][p.id];
  if (p.type === 'checklist') {
    const o = { ...subsObj(old, p) };
    delete o.n; if (t) o.n = t;
    logs[ds][p.id] = (t || Object.keys(o).length) ? o : false;
    return;
  }
  const r = parseRes(old);
  let v;
  if (r.k === 'v') v = t ? { r: 'v', n: t } : true;
  else if (r.k === 'x') v = t ? { r: 'x', n: t } : { r: 'x' };
  else if (r.k === 'p') v = t ? { r: 'p', p: r.pct, n: t } : { r: 'p', p: r.pct };
  else v = t ? { n: t } : false;
  logs[ds][p.id] = v;
}
const dayLabel = ds => {
  const d = parseDs(ds);
  return WD[d.getDay()] + ' · ' + d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};
const subDone = (ds, p, sid) => !!(logs[ds] && logs[ds][p.id] && logs[ds][p.id][sid]);

/* ---------- streaks & motivation ---------- */
// Both streaks use isDone = a FULL ✓ only. A ✗ or a 1-99% result breaks the streak (Phase 3A part 4: confirmed, no change needed).
function streakUpTo(d) { // app-wide: every applicable task done, how many days in a row
  // Today is still in progress, so an unfinished TODAY does not break the streak:
  // we simply start counting from yesterday (this fixes "streak is 0 every morning").
  let s = 0, cur = new Date(d);
  const t0 = tasksFor(cur);
  if (!t0.length || t0.some(p => !isDone(fmt(cur), p))) cur.setDate(cur.getDate() - 1);
  for (let guard = 0; guard < 3660; guard++) {   // (10 years) the loop always ends at the first day with nothing to do
    const ds = fmt(cur), tasks = tasksFor(cur);
    if (!tasks.length || tasks.filter(p => isDone(ds, p)).length < tasks.length) break;
    s++; cur.setDate(cur.getDate() - 1);
  }
  return s;
}
function programStreak(p) { // just this one program, how many days in a row
  let s = 0, cur = today();
  const t0 = fmt(cur), first = firstDayOf(p);
  while (fmt(cur) >= first) {
    const ds = fmt(cur);
    if (countsOn(p, cur)) {
      if (isDone(ds, p)) s++;
      else if (ds !== t0) break; // an unfinished TODAY is skipped, not counted as a break
    }
    cur.setDate(cur.getDate() - 1);
  }
  return s;
}
function motivate(pct) {
  if (pct >= 1) return '🎉 100%! ግሩም ቀን!';
  if (pct >= 0.8) return '🔥 በጣም ጥሩ እየሄድክ ነው!';
  if (pct >= 0.5) return '💪 ገፋ በለው!';
  if (pct > 0) return '🌱 ጀምረሃል፣ ቀጥል!';
  return '✨ ዛሬን ጀምር!';
}
function celebrate() {
  document.body.classList.add('celebrate');
  setTimeout(() => document.body.classList.remove('celebrate'), 1000);
  toast('🎉 100% ቀን — ግሩም ስራ!');
}

/* ---------- generic yes/no dialog (edit-scope & delete confirm) ---------- */
function choiceDialog(title, choices) {
  return new Promise(resolve => {
    const ov = document.createElement('div'); ov.className = 'overlay open';
    const box = document.createElement('div'); box.className = 'choice glass';
    box.innerHTML = `<p>${esc(title)}</p>` + choices.map((c, i) => `<button type="button" data-i="${i}">${esc(c)}</button>`).join('');
    document.body.append(ov, box);
    const done = i => { ov.remove(); box.remove(); resolve(i); };
    box.onclick = e => { const b = e.target.closest('button'); if (b) done(Number(b.dataset.i)); };
    ov.onclick = () => done(-1);
  });
}

/* ---------- result picker (✓ / ✗ / %) - resolves { k, pct }, or null if closed ---------- */
function resultDialog(p, ds) {
  return new Promise(resolve => {
    const cur = resOf(ds, p);
    const ov = document.createElement('div'); ov.className = 'overlay open';   // 'overlay open' also stops the cloud sync from reloading the page under the dialog
    const box = document.createElement('div'); box.className = 'resbox glass';
    box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true');
    box.innerHTML = `<p class="res-t">${esc(disp(p, ds).name)}</p>
      <div class="res-row">
        <button type="button" class="res-b ok${cur.k === 'v' ? ' on' : ''}" data-rk="v">✓ ተጠናቅቋል</button>
        <button type="button" class="res-b no${cur.k === 'x' ? ' on' : ''}" data-rk="x">✗ አልተጠናቀቀም</button>
      </div>
      <div class="res-lbl">በከፊል (መቶኛ)</div>
      <div class="res-row">${[25, 50, 75].map(n => `<button type="button" class="res-b pc${cur.k === 'p' && cur.pct === n ? ' on' : ''}" data-rp="${n}">${n}%</button>`).join('')}</div>
      <div class="res-row"><input type="number" class="res-num" inputmode="numeric" min="1" max="99" step="1" placeholder="1 – 99" value="${cur.k === 'p' ? cur.pct : ''}"><button type="button" class="res-b pc" data-rgo="1">አስቀምጥ</button></div>
      <div class="res-row"><button type="button" class="res-b gh" data-rk="">ምልክቱን አጥፋ</button><button type="button" class="res-b gh" data-rclose="1">ዝጋ</button></div>`;
    document.body.append(ov, box);
    const onKey = e => { if (e.key === 'Escape') finish(null); };
    const finish = v => { document.removeEventListener('keydown', onKey); ov.remove(); box.remove(); resolve(v); };
    document.addEventListener('keydown', onKey);
    ov.onclick = () => finish(null);
    const num = box.querySelector('.res-num');
    const save = () => {
      const raw = num.value.trim(), n = Number(raw);
      if (raw === '' || !Number.isInteger(n) || n < 1 || n > 99) { toast('ከ 1 እስከ 99 ያለ ቁጥር ያስገቡ'); return; }
      finish({ k: 'p', pct: n });
    };
    num.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); save(); } };
    box.onclick = e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.rclose !== undefined) return finish(null);
      if (b.dataset.rk !== undefined) return finish({ k: b.dataset.rk, pct: 0 });
      if (b.dataset.rp !== undefined) return finish({ k: 'p', pct: Number(b.dataset.rp) });
      if (b.dataset.rgo !== undefined) save();
    };
  });
}

/* ---------- note dialog (Phase 3A part 3) - resolves { text } to save, { del:true } to remove the note, or null if closed ---------- */
function noteDialog(p, ds) {
  return new Promise(resolve => {
    const old = noteOf(ds, p);
    const ov = document.createElement('div'); ov.className = 'overlay open';   // 'overlay open' also stops the cloud sync from reloading the page while you type
    const box = document.createElement('div'); box.className = 'notebox glass';
    box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true');
    box.innerHTML = `<p class="res-t">${esc(disp(p, ds).name)}</p>
      <div class="res-lbl">📝 ማስታወሻ · ${esc(dayLabel(ds))}</div>
      <textarea class="note-ta" maxlength="${NOTE_MAX}" rows="5" placeholder="እዚህ ይጻፉ…">${esc(old)}</textarea>
      <div class="note-cnt"></div>
      <div class="res-row"><button type="button" class="res-b ok" data-nsave="1">አስቀምጥ</button><button type="button" class="res-b gh" data-nclose="1">ዝጋ</button></div>
      ${old ? '<div class="res-row"><button type="button" class="res-b gh note-del" data-ndel="1">🗑 ማስታወሻውን ሰርዝ</button></div>' : ''}`;
    document.body.append(ov, box);
    const ta = box.querySelector('.note-ta'), cnt = box.querySelector('.note-cnt');
    const dirty = () => cleanNote(ta.value) !== old;
    const upd = () => { cnt.textContent = ta.value.length + ' / ' + NOTE_MAX; };
    const onKey = e => { if (e.key === 'Escape') finish(null); };
    const finish = v => { document.removeEventListener('keydown', onKey); ov.remove(); box.remove(); resolve(v); };
    document.addEventListener('keydown', onKey);
    ov.onclick = () => { if (!dirty()) finish(null); };   // a stray tap outside must never throw away what you typed
    ta.oninput = upd; upd();
    box.onclick = e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.nclose !== undefined) return finish(null);
      if (b.dataset.ndel !== undefined) return finish({ del: true });
      if (b.dataset.nsave !== undefined) {
        if (!dayEditable(ds)) { lockToast(ds); return; }   // the day got locked while typing (e.g. midnight): keep the text on screen
        const t = cleanNote(ta.value);
        finish(t ? { text: t } : { del: true });
      }
    };
    ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
  });
}

/* ---------- theme ---------- */
const root = document.documentElement;
const savedTh = localStorage.getItem(LS_TH); if (savedTh) root.dataset.theme = savedTh;
$('themeBtn').onclick = () => {
  const dark = (root.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')) === 'dark';
  root.dataset.theme = dark ? 'light' : 'dark'; localStorage.setItem(LS_TH, root.dataset.theme);
};

/* ---------- card rendering ---------- */
// Mini weekly overview shown on every card in the main list (like the
// reference screenshots): always the REAL current Mon–Sun week, so it
// doesn't shift when you use the ‹/› day-nav arrows at the top of the
// page. Tapping any applicable day toggles that day's tick directly,
// without opening the program's detail view.
function weekStripHtml(p) {
  const t = today(), ds0 = fmt(t);
  const mon = new Date(t); mon.setDate(t.getDate() - ((t.getDay() + 6) % 7));
  let cells = '';
  for (let i = 0; i < 7; i++) {
    const d = new Date(mon); d.setDate(mon.getDate() + i);
    const dds = fmt(d), isToday = dds === ds0;
    const na = !countsOn(p, d);
    const rk = na ? '' : resOf(dds, p).k;
    const cls = na ? 'na' : (rk === 'v' ? 'done' : rk === 'x' ? 'fail' : rk === 'p' ? 'part' : 'due');
    cells += `<button type="button" class="wd-cell ${cls}${isToday ? ' today' : ''}"${na ? ' disabled' : ` data-wtick="${p.id}:${dds}"`} aria-label="${esc(PDAY_LABELS[i])}">${d.getDate()}</button>`;
  }
  return `<div class="week-strip">
    <div class="week-strip-hd">${PDAY_LABELS.map(l => `<span>${esc(l[0])}</span>`).join('')}</div>
    <div class="week-strip-row">${cells}</div>
  </div>`;
}
// Quick-access footer row: this program's streak + this week's %, plus
// shortcuts straight into its Calendar/Statistics tabs (📅/📊) without
// having to tap the card's name first.
function cardFootHtml(p, ds) {
  const t = today(), ds0 = fmt(t);
  const wkStart = new Date(t); wkStart.setDate(t.getDate() - ((t.getDay() + 6) % 7));
  const wk = periodStats(p, fmt(wkStart), ds0);
  return `<div class="card-foot">
    <span class="cf-stat">🔥 ${programStreak(p)}</span>
    <span class="cf-stat">✓ ${wk.pct}%</span>
    <span class="cf-spacer"></span>
    ${p.type !== 'checklist' ? `<button type="button" class="cf-btn cf-res" data-res="${p.id}" aria-label="ውጤት ምረጥ">ውጤት</button>` : ''}
    <button type="button" class="cf-btn cf-note${noteOf(ds, p) ? ' has-note' : ''}" data-note="${p.id}" aria-label="ማስታወሻ">📝</button>
    <button type="button" class="cf-btn" data-opencal="${p.id}" aria-label="ቀን መቁጠሪያ">📅</button>
    <button type="button" class="cf-btn" data-openstat="${p.id}" aria-label="ስታትስቲክስ">📊</button>
  </div>`;
}
function card(p, ds) {
  p = at(p, ds);   // a past day is drawn the way the activity looked on that day
  const t = disp(p, ds), done = isDone(ds, p), rs = resOf(ds, p);
  let subHtml = '';
  if (p.type === 'checklist') {
    const doneCt = p.subItems.filter(s => subDone(ds, p, s.id)).length;
    subHtml = '<div class="sublist">' + p.subItems.map(s => {
      const sd = subDone(ds, p, s.id);
      return `<div class="subrow"><button class="subtick${sd ? ' done' : ''}" data-subtick="${p.id}:${s.id}">${sd ? '✓' : ''}</button><span>${esc(s.name)}</span></div>`;
    }).join('') + `</div><div class="subcount">${doneCt} ከ ${p.subItems.length} ንዑስ ተጠናቅቋል</div>`;
  }
  return `<div class="card glass${done ? ' done-card' : ''}${p.type === 'checklist' ? ' master' : ''}">
    <div class="card-top">
      <div class="info opens-detail" data-open="${p.id}">
        <div class="name">${esc(t.name)}</div>
        <div class="desc">${descHtml(t.desc)}</div>${subHtml}
      </div>
      <div class="actions">
        <button class="tick${done ? ' done' : rs.k === 'x' ? ' fail' : rs.k === 'p' ? ' part' : ''}" data-tick="${p.id}" aria-label="${done ? 'እንደ አልተጠናቀቀ ምልክት አድርግ' : 'እንደተጠናቀቀ ምልክት አድርግ'}">${done ? '✓' : rs.k === 'x' ? '✗' : rs.k === 'p' ? rs.pct + '%' : ''}</button>
        <button class="edit" data-edit="${p.id}" aria-label="ፈጣን አርትዕ">✎</button>
        <button class="del" data-del="${p.id}" aria-label="ሰርዝ">🗑</button>
      </div>
    </div>
    ${noteOf(ds, p) ? `<div class="card-note"><span class="cn-i" aria-hidden="true">📝</span><span class="cn-t">${esc(noteOf(ds, p))}</span></div>` : ''}
    ${weekStripHtml(p)}
    ${cardFootHtml(p, ds)}
  </div>`;
}

function groupedList(items, ds, byIncomplete) {   // the day's activities under their category headers (done/total + a fold arrow)
  const cards = l => l.slice().sort(byIncomplete).map(p => card(p, ds)).join('');
  const groups = categories().map(c => ({ key: c.key, name: c.name, items: items.filter(p => catKey(p.category) === c.key) })).filter(g => g.items.length);
  if (!groups.length) return cards(items);   // nobody uses categories: a plain list, no headers
  const none = items.filter(p => !catKey(p.category)); if (none.length) groups.push({ key: '', name: 'ያለ ምድብ', items: none });
  return groups.map(g => {
    const open = !catFold.has(g.key), done = g.items.filter(p => isDone(ds, p)).length;
    return `<button type="button" class="cat-h" data-catfold="${esc(g.key)}" aria-expanded="${open}"><span class="cat-car" aria-hidden="true">${open ? '▾' : '▸'}</span><b>${esc(g.name)}</b><small>${done}/${g.items.length}</small></button>` +
      (open ? `<div class="cat-body">${cards(g.items)}</div>` : '');
  }).join('');
}

// A deleted activity on a day before it was deleted: shown read-only, so the day's numbers still add up.
function ghostCard(p, ds) {
  const t = disp(p, ds), r = resOf(ds, p), done = isDone(ds, p), note = noteOf(ds, p);
  const mark = done ? '✓' : r.k === 'x' ? '✗' : r.k === 'p' ? r.pct + '%' : '—';
  return `<div class="card glass ghost-card${done ? ' done-card' : ''}"><div class="card-top"><div class="info"><div class="name">${esc(t.name)}<span class="tag">🗑 ተሰርዟል</span></div></div><div class="ghost-mark">${mark}</div></div>${note ? `<div class="card-note"><span class="cn-i" aria-hidden="true">📝</span><span class="cn-t">${esc(note)}</span></div>` : ''}</div>`;
}

/* ---------- main render ---------- */
function render() {
  const ds = fmt(sel), all = tasksFor(sel);
  const live = all.filter(p => !p.ghost), gone = all.filter(p => p.ghost);   // gone = deleted later, but they counted on this day
  // the ring and reports count ONLY the activities this person can see
  const T = tally(ds, all), pct = T.frac;   // Phase 3A part 4: the real percent (60% counts as 60); pct is exactly 1 only when every activity is a full ✓
  const CIRC = 2 * Math.PI * 26;

  const editable = dayEditable(ds);
  document.body.classList.toggle('day-locked', !editable);
  $('dLbl').textContent = WD[sel.getDay()] + (editable ? '' : ' 🔒');
  $('dSub').textContent = sel.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const rf = $('ringFill'); rf.style.strokeDasharray = CIRC; rf.style.strokeDashoffset = CIRC * (1 - pct);
  $('ringText').innerHTML = `<b>${T.pct}%</b><br>${T.done} ከ ${T.total} ተጠናቅቋል${T.part ? ` · ${T.part} በከፊል` : ''}`;

  const byIncomplete = (a, b) => isDone(ds, a) - isDone(ds, b);
  $('list').innerHTML =
    groupedList(live, ds, byIncomplete) +
    (gone.length ? '<div class="sect-lbl">🗑 የተሰረዙ (ለታሪክ ብቻ)</div>' + gone.map(p => ghostCard(p, ds)).join('') : '') +
    (!all.length ? '<div class="sect-lbl">ምንም ፕሮግራም የለም — ከላይ ባለው ＋ ይጨምሩ</div>' : '');

  drawDayReport(ds, all, T);
  drawWeek();

  if (lastPct !== null && pct === 1 && lastPct < 1) celebrate();
  lastPct = pct;
}

function drawDayReport(ds, all, T) {
  const left = all.filter(p => !isDone(ds, p)), doneAll = all.filter(p => isDone(ds, p));   // "left" = not a full ✓ yet (✗, a % and untouched ones)
  const streak = streakUpTo(today());
  const li = p => `<li>${esc(disp(p, ds).name)}${itemMark(ds, p)}</li>`;
  $('dayReportPanel').innerHTML =
    `<div class="week-total">${T.pct}% — ${motivate(T.frac)}</div>` +
    `<div class="streak">🔥 ${streak} ቀን ተከታታይ ሙሉ ማጠናቀቅ</div>` +
    (left.length
      ? `<div class="rep-h">የቀሩ (${left.length})</div><ul class="rep-list">` + left.map(li).join('') + '</ul>'
      : `<div class="rep-h done">ሁሉንም ዛሬ አጠናቅቀሃል! 🎉</div>`) +
    (doneAll.length ? `<div class="rep-h done">የተጠናቀቀ (${doneAll.length})</div><ul class="rep-list done">` + doneAll.map(li).join('') + '</ul>' : '');
}

function drawWeek() {
  const mon = new Date(sel); mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7));
  let sumAll = 0, tt = 0, dn = 0, pt = 0, winDays = 0;
  const stats = {}, days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(mon); d.setDate(mon.getDate() + i); const ds = fmt(d);
    const tasks = tasksFor(d), T = tally(ds, tasks);
    sumAll += T.sumPct; tt += T.total; dn += T.done; pt += T.part;
    if (T.total && T.done === T.total) winDays++;   // a "full day" needs every activity a full ✓
    days.push({ name: WD[d.getDay()], T });
    tasks.forEach(p => {
      const r = resOf(ds, p);
      const st = stats[p.id] = stats[p.id] || { name: disp(p, ds).name, done: 0, part: 0, total: 0, sum: 0 };
      st.total++; st.sum += r.pct; if (r.k === 'v') st.done++; else if (r.k === 'p') st.part++;
    });
  }
  const wide = pt > 0 ? ' wide' : '';   // a day with a partial result needs a little more room for its "+1◐"
  const rows = days.map(({ name, T }) => {
    const cls = T.frac >= 0.8 ? 'hi' : T.frac >= 0.4 ? 'mid' : 'lo';
    return `<div class="week-row${wide}"><span class="wname">${name}</span><div class="week-bar"><i class="${cls}" style="width:${100 * T.frac}%"></i></div><span class="week-frac">${fracTxt(T.done, T.total, T.part)}</span></div>`;
  }).join('');
  const W = mkStat(sumAll, tt, dn, pt, 0);
  const weak = Object.values(stats).filter(s => s.total > 0 && s.sum / (100 * s.total) < 0.6).sort((a, b) => (a.sum / a.total) - (b.sum / b.total)).slice(0, 3);
  $('weekPanel').innerHTML = `<div class="week-total">ጠቅላላ የሳምንቱ ውጤት፡ ${W.pct}% · 🔥 ${winDays}/7 ሙሉ ቀናት</div>` + rows +
    (pt ? `<div class="rep-note">◐ = በከፊል የተሰራ (መቶኛ)</div>` : '') +
    (weak.length ? `<div class="rep-h">ትኩረት የሚፈልጉ</div><ul class="rep-list">` + weak.map(w => `<li>${esc(w.name)} — ${fracTxt(w.done, w.total, w.part)}</li>`).join('') + '</ul>' : '');
}

function pop(sel) { const el = $('list').querySelector(sel); if (el) { el.classList.add('pop'); setTimeout(() => el.classList.remove('pop'), 350); } }

/* ---------- list clicks: open detail / tick / sub-tick / week-strip tick / quick-edit / delete / jump-to-tab ---------- */
$('list').onclick = async e => {
  const fb = e.target.closest('[data-catfold]');
  if (fb) { const k = fb.dataset.catfold; if (catFold.has(k)) catFold.delete(k); else catFold.add(k); saveFold(); render(); return; }
  const sb = e.target.closest('[data-subtick]'), tb = e.target.closest('[data-tick]'),
        eb = e.target.closest('[data-edit]'), db = e.target.closest('[data-del]'),
        ob = e.target.closest('[data-open]'), wb = e.target.closest('[data-wtick]'),
        cb = e.target.closest('[data-opencal]'), stb = e.target.closest('[data-openstat]'),
        rsb = e.target.closest('[data-res]'), nb = e.target.closest('[data-note]');
  const ds = fmt(sel);

  if (wb) {
    // Tapping a day in a card's mini week-strip ticks THAT day directly —
    // independent of whichever day the ‹/› nav up top is currently on.
    const [pid, wds] = wb.dataset.wtick.split(':');
    if (!dayEditable(wds)) { lockToast(wds); return; }
    const p = programs.find(x => x.id === pid); if (!p) return;
    const qw = at(p, wds);
    if (qw.type === 'checklist') {
      const wasDone = isDone(wds, p), keepN = noteOf(wds, p);   // the day's note must survive a master tap
      logs[wds] = logs[wds] || {}; logs[wds][p.id] = {};
      qw.subItems.forEach(s => logs[wds][p.id][s.id] = !wasDone);
      if (keepN) logs[wds][p.id].n = keepN;
    } else {
      toggleSimple(wds, p);
    }
    persist(); render(); return;
  }
  if (rsb) {   // "ውጤት": pick ✓ / ✗ / % for the day that is on screen
    const pid = rsb.dataset.res, p0 = programs.find(x => x.id === pid);
    if (!p0 || at(p0, ds).type === 'checklist') return;
    if (!dayEditable(ds)) { lockToast(ds); return; }
    const r = await resultDialog(p0, ds); if (!r) return;
    const p1 = programs.find(x => x.id === pid);
    if (!p1) return;
    if (!dayEditable(ds)) { lockToast(ds); return; }
    setRes(ds, p1, r.k, r.pct); persist(); render(); pop(`[data-tick="${pid}"]`); return;
  }
  if (nb) {   // "📝": write, change or remove the note for the day that is on screen
    const pid = nb.dataset.note, p0 = programs.find(x => x.id === pid); if (!p0) return;
    if (!dayEditable(ds)) { lockToast(ds); return; }
    const before = noteOf(ds, p0);
    const r = await noteDialog(p0, ds); if (!r) return;
    const p1 = programs.find(x => x.id === pid); if (!p1) return;
    if (!dayEditable(ds)) { lockToast(ds); return; }
    if (r.del) {
      if (!before) return;
      setNote(ds, p1, ''); persist(); render();
      showUndo('ማስታወሻ ተሰርዟል', () => {
        if (!dayEditable(ds)) { lockToast(ds); return; }
        const q = programs.find(x => x.id === pid); if (!q) return;
        setNote(ds, q, before); persist(); render();
      });
      return;
    }
    if (r.text === before) return;
    setNote(ds, p1, r.text); persist(); render(); toast('ማስታወሻ ተቀምጧል።'); return;
  }
  if (cb) { openDetail(cb.dataset.opencal, 'cal'); return; }
  if (stb) { openDetail(stb.dataset.openstat, 'stat'); return; }

  if (sb) {
    if (!dayEditable(ds)) { lockToast(ds); return; }
    const [pid, sid] = sb.dataset.subtick.split(':');
    const ps = programs.find(x => x.id === pid); if (!ps) return;
    logs[ds] = logs[ds] || {}; logs[ds][pid] = subsObj(logs[ds][pid], at(ps, ds));
    logs[ds][pid][sid] = !logs[ds][pid][sid]; persist(); render();
    pop(`[data-subtick="${pid}:${sid}"]`); return;
  }
  if (tb) {
    if (!dayEditable(ds)) { lockToast(ds); return; }
    const id = tb.dataset.tick, p = programs.find(x => x.id === id); if (!p) return;
    const qt = at(p, ds);
    if (qt.type === 'checklist') {
      const wasDone = isDone(ds, p), keepN = noteOf(ds, p);   // the day's note must survive a master tap
      logs[ds] = logs[ds] || {}; logs[ds][p.id] = {};
      qt.subItems.forEach(s => logs[ds][p.id][s.id] = !wasDone);
      if (keepN) logs[ds][p.id].n = keepN;
    } else {
      toggleSimple(ds, p);
    }
    persist(); render();
    pop(`[data-tick="${id}"]`); return;
  }
  if (eb) { openEdit(eb.dataset.edit); return; }
  if (db) {
    const id = db.dataset.del;
    const i = await choiceDialog('ይህን ፕሮግራም ወደ ቆሻሻ መጣያ ማዛወር ይፈልጋሉ?', ['አዎ፣ ሰርዝ', 'አይ']);
    if (i !== 0) return;
    const removed = programs.find(x => x.id === id); if (!removed) return;
    const idx = programs.indexOf(removed), delDs = fmt(today());
    programs = programs.filter(x => x.id !== id); savePrograms();
    markSeedRemoved('program', removed);
    const trashId = trashAdd('program', removed); render();
    showUndo('ፕሮግራም ወደ ቆሻሻ መጣያ ተዛወረ', () => { reinstate(removed, delDs); programs.splice(idx, 0, removed); savePrograms(); unmarkSeedRemoved('program', removed.id); trashRemove(trashId); render(); });
    return;
  }
  if (ob) { openDetail(ob.dataset.open); return; }
};

$('prevDay').onclick = () => { sel.setDate(sel.getDate() - 1); render(); };
$('nextDay').onclick = () => { sel.setDate(sel.getDate() + 1); render(); };
$('weekBtn').onclick = e => e.currentTarget.setAttribute('aria-expanded', $('weekPanel').classList.toggle('open'));
$('dayRepBtn').onclick = e => e.currentTarget.setAttribute('aria-expanded', $('dayReportPanel').classList.toggle('open'));
$('settingsBtn').onclick = e => e.currentTarget.setAttribute('aria-expanded', $('settingsPanel').classList.toggle('open'));

/* ---------- edit sheet: quick edit (name + desc only); asks today-only vs every-time ---------- */
const overlay = $('overlay'), sheet = $('sheet'), addSheet = $('addSheet'), pageSheet = $('pageSheet');
function openEdit(id) {
  editId = id; const ds = fmt(sel); const p = programs.find(x => x.id === id); const t = disp(p, ds);
  $('eName').value = t.name; $('eDesc').value = t.desc; fillCat('eCat', canonCat(p.category));
  overlay.classList.add('open'); sheet.classList.add('open');
}
const closeEdit = () => { overlay.classList.remove('open'); sheet.classList.remove('open'); };
$('eCancel').onclick = closeEdit;
addEventListener('keydown', e => { if (e.key === 'Escape') { closeEdit(); closeAdd(); closePageSheet(); closeDetail(); closeTrash(); closeCats(); } });
$('eSave').onclick = async () => {
  const n = $('eName').value.trim(); if (!n) return;
  const desc = $('eDesc').value, p = programs.find(x => x.id === editId); if (!p) { closeEdit(); return; }
  const ds = fmt(sel), t = disp(p, ds), cat = getCat('eCat');
  const textChanged = n !== t.name || desc !== t.desc, catChanged = catKey(cat) !== catKey(p.category);
  if (!textChanged && !catChanged) { closeEdit(); return; }
  let i = 1;   // 0 = today only, 1 = every time
  if (textChanged) { i = await choiceDialog(catChanged ? 'የስም / የዝርዝር ለውጥ የት ይተግብር? (ምድብ ሁልጊዜ ይቀየራል)' : 'ይህን ለውጥ የት ይተግብር?', ['ለዛሬ ብቻ', 'ለሁልጊዜው']); if (i === -1) return; }
  if (catChanged) { p.category = cat; p.catSet = true; }   // a category is never "today only"; catSet also stops a data.js refresh from undoing it
  if (textChanged) {
    if (i === 0) { dayOv[ds] = dayOv[ds] || {}; dayOv[ds][editId] = { name: n, desc }; }
    else { p.name = n; p.desc = desc; p.customized = true; }
  }
  if (catChanged || (textChanged && i === 1)) savePrograms();
  persist(); closeEdit(); render(); toast('ተቀምጧል።');
};

/* ---------- add-program sheet. Field order: category → type (+ sub-items) → name → description → days ---------- */
let addType = 'simple', addDays = 'daily', subItemsTemp = [];
function renderSubEditor() {
  $('subList').innerHTML = subItemsTemp.map((s, i) => `<div class="subedit"><input data-si="${i}" value="${esc(s.name)}" placeholder="ንዑስ ስም"><button type="button" class="subdel" data-sdi="${i}">✕</button></div>`).join('');
}
$('dayChips').innerHTML = `<button type="button" class="daychip active" data-d="daily">ዕለታዊ</button>` +
  PDAY_LABELS.map((l, i) => `<button type="button" class="daychip" data-d="${i + 1}">${l}</button>`).join('');

function openAdd() {
  addType = 'simple'; addDays = 'daily'; subItemsTemp = [];
  $('aName').value = ''; $('aDesc').value = ''; fillCat('aCat', '');
  document.querySelectorAll('#addSheet .typebtn').forEach(b => b.classList.toggle('active', b.dataset.type === 'simple'));
  $('subWrap').hidden = true; renderSubEditor();
  document.querySelectorAll('#addSheet .daychip').forEach(b => b.classList.toggle('active', b.dataset.d === 'daily'));
  overlay.classList.add('open'); addSheet.classList.add('open');
}
const closeAdd = () => { overlay.classList.remove('open'); addSheet.classList.remove('open'); };
$('addBtn').onclick = openAdd;
$('aCancel').onclick = closeAdd;
overlay.onclick = () => { closeEdit(); closeAdd(); closePageSheet(); };

addSheet.addEventListener('click', e => {
  const tbn = e.target.closest('.typebtn');
  if (tbn) {
    addType = tbn.dataset.type;
    document.querySelectorAll('#addSheet .typebtn').forEach(b => b.classList.toggle('active', b === tbn));
    $('subWrap').hidden = addType !== 'checklist';
  }
  const dc = e.target.closest('.daychip');
  if (dc) {
    if (dc.dataset.d === 'daily') {
      addDays = 'daily';
      document.querySelectorAll('#addSheet .daychip').forEach(b => b.classList.toggle('active', b.dataset.d === 'daily'));
    } else {
      if (addDays === 'daily') addDays = [];
      const dnum = Number(dc.dataset.d), idx = addDays.indexOf(dnum);
      if (idx > -1) addDays.splice(idx, 1); else addDays.push(dnum);
      dc.classList.toggle('active');
      if (addDays.length === 0) { addDays = 'daily'; document.querySelectorAll('#addSheet .daychip').forEach(b => b.classList.toggle('active', b.dataset.d === 'daily')); }
      else $('dayChips').querySelector('[data-d="daily"]').classList.remove('active');
    }
  }
  const sdi = e.target.closest('[data-sdi]');
  if (sdi) { subItemsTemp.splice(Number(sdi.dataset.sdi), 1); renderSubEditor(); }
});
$('addSub').onclick = () => { subItemsTemp.push({ id: uid(), name: '' }); renderSubEditor(); };
$('subList').addEventListener('input', e => { const i = e.target.dataset.si; if (i !== undefined) subItemsTemp[i].name = e.target.value; });

$('aSave').onclick = () => {
  const n = $('aName').value.trim(); if (!n) { toast('ስም ያስፈልጋል'); return; }
  const validSubs = subItemsTemp.filter(s => s.name.trim());
  if (addType === 'checklist' && validSubs.length < 1) { toast('ቢያንስ አንድ ንዑስ ዝርዝር ጨምር'); return; }
  const p = {
    id: uid(), name: n, desc: $('aDesc').value, category: getCat('aCat'), type: addType,
    schedule: addDays === 'daily' ? 'daily' : addDays.slice(), seed: false, customized: true, createdAt: fmt(today())
  };
  if (addType === 'checklist') p.subItems = validSubs.map(s => ({ id: s.id, name: s.name.trim() }));
  programs.push(p); savePrograms(); closeAdd(); render(); toast('ፕሮግራም ታክሏል!');
};

/* ============================================================
   PAGES: read-only reference content (prohibited foods, notices, and
   anything you add) — never tickable, but fully editable via ✎.
   Same seed/customized sync pattern as programs, see syncSeedPages.
   ============================================================ */
let pages = JSON.parse(localStorage.getItem(LS_PAGES) || 'null');
if (!pages) pages = [];
function syncSeedPages() {
  const seedIds = new Set(SEED_PAGES.map(s => s.id));
  SEED_PAGES.forEach(seed => {
    if (removedSeedIds.has('page:' + seed.id)) return; // deliberately deleted — stays gone until restored from the Recycle Bin
    const idx = pages.findIndex(x => x.id === seed.id);
    if (idx === -1) pages.push({ ...seed, seed: true, customized: false });
    else if (!pages[idx].customized) pages[idx] = { ...seed, seed: true, customized: false };
  });
  pages = pages.filter(p => !(p.seed && !p.customized && !seedIds.has(p.id)));
}
syncSeedPages();
const savePages = () => localStorage.setItem(LS_PAGES, JSON.stringify(pages));
savePages();

let openPageId = null, editPageId = null;
function renderPages() {
  $('pagesRow').innerHTML = pages.map(p => `<button type="button" class="pagepill${openPageId === p.id ? ' active' : ''}" data-pg="${p.id}">${esc(p.title)}</button>`).join('') +
    `<button type="button" class="pagepill addpage" id="addPageBtn">＋ ገፅ</button>`;
  $('pagesPanels').innerHTML = pages.map(p => `
    <div class="pagepanel glass${openPageId === p.id ? ' open' : ''}">
      <div class="pagepanel-head"><h3>${esc(p.title)}</h3>
        <div class="pagepanel-tools">
          <button type="button" data-pgedit="${p.id}" aria-label="አርትዕ">✎</button>
          <button type="button" data-pgdel="${p.id}" aria-label="ሰርዝ">🗑</button>
        </div></div>
      <ul>${String(p.body || '').split('\n').filter(l => l.trim()).map(l => `<li>${esc(l.trim())}</li>`).join('')}</ul>
    </div>`).join('');
  $('addPageBtn').onclick = () => openPageSheet(null);
}
$('pagesRow').onclick = e => {
  const b = e.target.closest('[data-pg]'); if (!b) return;
  openPageId = openPageId === b.dataset.pg ? null : b.dataset.pg;
  renderPages();
};
$('pagesPanels').onclick = async e => {
  const eb = e.target.closest('[data-pgedit]'), db = e.target.closest('[data-pgdel]');
  if (eb) { openPageSheet(eb.dataset.pgedit); return; }
  if (db) {
    const id = db.dataset.pgdel;
    const i = await choiceDialog('ይህን ገፅ ወደ ቆሻሻ መጣያ ማዛወር ይፈልጋሉ?', ['አዎ፣ ሰርዝ', 'አይ']);
    if (i !== 0) return;
    const removed = pages.find(x => x.id === id), idx = pages.indexOf(removed);
    pages = pages.filter(x => x.id !== id); if (openPageId === id) openPageId = null;
    savePages(); renderPages();
    markSeedRemoved('page', removed);
    const trashId = trashAdd('page', removed);
    showUndo('ገፅ ወደ ቆሻሻ መጣያ ተዛወረ', () => { pages.splice(idx, 0, removed); savePages(); unmarkSeedRemoved('page', removed.id); trashRemove(trashId); renderPages(); });
  }
};
function openPageSheet(id) {
  editPageId = id;
  const p = id ? pages.find(x => x.id === id) : null;
  $('pageSheetTitle').textContent = p ? 'ገፅ አርትዕ' : 'አዲስ ገፅ';
  $('pTitle').value = p ? p.title : '';
  $('pBody').value = p ? p.body : '';
  overlay.classList.add('open'); pageSheet.classList.add('open');
}
const closePageSheet = () => { overlay.classList.remove('open'); pageSheet.classList.remove('open'); };
$('pCancel').onclick = closePageSheet;
$('pSave').onclick = () => {
  const title = $('pTitle').value.trim(); if (!title) { toast('ርዕስ ያስፈልጋል'); return; }
  const body = $('pBody').value;
  if (editPageId) {
    const p = pages.find(x => x.id === editPageId);
    p.title = title; p.body = body; p.customized = true;
  } else {
    pages.push({ id: uid(), title, body, seed: false, customized: true });
  }
  savePages(); closePageSheet(); renderPages(); toast('ገፅ ተቀምጧል።');
};

/* ============================================================
   PROGRAM DETAIL VIEW — Calendar / Statistics / Edit tabs
   (opened by tapping a program's name/description on the main list)
   ============================================================ */
let detailId = null, detailTab = 'cal', calMonth = today(), etState = null;
const detailView = $('detailView');
function openDetail(id, tab = 'cal') {
  detailId = id; detailTab = tab; calMonth = today();
  document.querySelectorAll('.dtab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  renderDetail();
  detailView.classList.add('open');
}
function closeDetail() { detailView.classList.remove('open'); detailId = null; }
$('detailBack').onclick = closeDetail;
$('detailTabs').onclick = e => {
  const b = e.target.closest('.dtab'); if (!b) return;
  detailTab = b.dataset.tab;
  document.querySelectorAll('.dtab').forEach(x => x.classList.toggle('active', x === b));
  if (detailTab === 'cal') calMonth = today();
  renderDetail();
};

function renderDetail() {
  const p = programs.find(x => x.id === detailId);
  if (!p) { closeDetail(); return; }
  $('detailTitle').textContent = p.name;
  $('detailCat').textContent = catClean(p.category) ? canonCat(p.category) : '';
  $('detailCat').hidden = !catClean(p.category);
  if (detailTab === 'cal') $('detailBody').innerHTML = calendarTabHtml(p);
  else if (detailTab === 'stat') $('detailBody').innerHTML = statsTabHtml(p);
  else editTabRender(p);
}

function calendarTabHtml(p) {
  const y = calMonth.getFullYear(), m = calMonth.getMonth();
  const first = new Date(y, m, 1);
  const startOffset = (first.getDay() + 6) % 7; // Monday-first grid
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const ds0 = fmt(today()), t = today();
  let cells = '';
  for (let i = 0; i < startOffset; i++) cells += '<div></div>';
  for (let d = 1; d <= daysInMonth; d++) {
    const dt = new Date(y, m, d), ds = fmt(dt);
    const isToday = ds === ds0;
    const na = !countsOn(p, dt);
    let cls = 'na', sty = '';
    if (!na) {
      const r = resOf(ds, p);   // ✓ done · % partly (the circle fills up to that percent) · ✗ marked not done · nothing marked
      if (r.k === 'v') cls = 'done';
      else if (r.k === 'p') { cls = 'part'; sty = ` style="--p:${r.pct}"`; }
      else if (r.k === 'x') cls = 'fail';
      else cls = dt > t ? 'upcoming' : 'missed';
    }
    cells += `<div class="cal-cell ${cls}${isToday ? ' today' : ''}${noteOf(ds, p) ? ' has-note' : ''}"${sty}>${d}</div>`;
  }
  let monthLabel;
  try { monthLabel = calMonth.toLocaleDateString('am-ET', { month: 'long', year: 'numeric' }); }
  catch (e) { monthLabel = `${calMonth.getFullYear()}-${pad(calMonth.getMonth() + 1)}`; }
  return `
    <div class="cal-nav"><button type="button" id="calPrev">‹</button><b>${esc(monthLabel)}</b><button type="button" id="calNext">›</button></div>
    <div class="cal-grid">${['ሰኞ', 'ማክ', 'ረቡ', 'ሐሙ', 'አር', 'ቅዳ', 'እሁ'].map(l => `<div class="cal-wd">${l}</div>`).join('')}${cells}</div>
    <div class="cal-legend"><span><i class="done"></i>ተጠናቅቋል</span><span><i class="part"></i>በከፊል</span><span><i class="fail"></i>✗ አልተጠናቀቀም</span><span><i class="missed"></i>ምልክት አልተደረገም</span><span><i class="upcoming"></i>ገና አልደረሰም</span><span><i class="note"></i>📝 ማስታወሻ</span></div>
    <div class="detail-desc glass"><h4>ዝርዝር መግለጫ</h4>${descHtml(p.desc)}</div>${notesHistoryHtml(p)}`;
}

// All notes ever written for this activity, newest first (shown under the calendar).
function notesHistoryHtml(p) {
  const rows = Object.keys(logs).filter(ds => /^\d{4}-\d{2}-\d{2}$/.test(ds) && noteOf(ds, p)).sort().reverse();
  if (!rows.length) return '';
  const SHOW = 30;
  const mark = ds => { const r = resOf(ds, p); return r.k === 'v' ? '✓' : r.k === 'x' ? '✗' : r.k === 'p' ? r.pct + '%' : ''; };
  return `<div class="detail-desc glass notes-hist"><h4>📝 ማስታወሻዎች (${rows.length})</h4>` +
    rows.slice(0, SHOW).map(ds => `<div class="nh-row"><div class="nh-d">${esc(dayLabel(ds))}${mark(ds) ? ` <b>${esc(mark(ds))}</b>` : ''}</div><div class="nh-t">${esc(noteOf(ds, p))}</div></div>`).join('') +
    (rows.length > SHOW ? `<div class="nh-more">… +${rows.length - SHOW}</div>` : '') + `</div>`;
}

function periodStats(p, fromDs, toDs) {   // -> mkStat(): total days, full ✓ days, partly days, ✗ days, and the real percent (pct = whole number to show)
  let sum = 0, done = 0, part = 0, fail = 0, total = 0;
  let cur = parseDs(fromDs); const end = parseDs(toDs);
  while (cur <= end) {
    if (countsOn(p, cur)) {
      const ds = fmt(cur);
      total++; const r = resOf(ds, p); sum += r.pct;
      if (r.k === 'v') done++; else if (r.k === 'p') part++; else if (r.k === 'x') fail++;
    }
    cur.setDate(cur.getDate() + 1);
  }
  return mkStat(sum, total, done, part, fail);
}

function statsTabHtml(p) {
  const t = today(), ds0 = fmt(t);
  let trend = '';
  for (let i = 6; i >= 0; i--) {
    const d = new Date(t); d.setDate(d.getDate() - i); const ds = fmt(d);
    const na = !countsOn(p, d);
    const r = na ? { k: '', pct: 0 } : resOf(ds, p);
    const cls = na ? 'na' : r.k === 'v' ? 'done' : r.k === 'x' ? 'fail' : r.k === 'p' ? 'part' : (d.getTime() < t.getTime() ? 'missed' : 'na');
    trend += `<div class="trend-cell"><span>${PDAY_LABELS[(d.getDay() + 6) % 7][0]}</span><div class="trend-dot ${cls}">${cls === 'done' ? '✓' : cls === 'fail' ? '✗' : cls === 'part' ? r.pct : ''}</div></div>`;
  }
  const wkStart = new Date(t); wkStart.setDate(t.getDate() - ((t.getDay() + 6) % 7));
  const moStart = new Date(t.getFullYear(), t.getMonth(), 1);
  const yrStart = new Date(t.getFullYear(), 0, 1);
  const allTime = periodStats(p, firstDayOf(p), ds0);
  const rows = [
    ['ዛሬ', periodStats(p, ds0, ds0)],
    ['ይህ ሳምንት', periodStats(p, fmt(wkStart), ds0)],
    ['ይህ ወር', periodStats(p, fmt(moStart), ds0)],
    ['ይህ ዓመት', periodStats(p, fmt(yrStart), ds0)],
    ['ጠቅላላ (ካስጀመሩበት)', allTime],
  ];
  return `
    <div class="streak-card">
      <div class="glass"><b>${programStreak(p)}</b><span>🔥 ተከታታይ ቀናት</span></div>
      <div class="glass"><b>${allTime.pct}%</b><span>ጠቅላላ ውጤት</span></div>
    </div>
    <div class="trend-row">${trend}</div>
    ${rows.map(([label, s]) => `
      <div class="stat-row"><div class="stat-row-h"><span>${esc(label)}</span><b>${s.total ? s.pct + '% (' + fracTxt(s.done, s.total, s.part) + ')' : '—'}</b></div>
      <div class="stat-bar"><i style="width:${s.pct}%"></i></div></div>`).join('')}
    ${rows.some(([, s]) => s.part) ? '<div class="rep-note">◐ = በከፊል የተሰራ (መቶኛ)</div>' : ''}`;
}

function etKeep() {   // the tab redraws when you change type / days / sub-items: keep what was already typed
  if ($('etName')) etState.name = $('etName').value;
  if ($('etDesc')) etState.desc = $('etDesc').value;
  if ($('etCat')) etState.cat = getCat('etCat');
}
function editTabHtml(p) {
  const vName = etState.name !== undefined ? etState.name : p.name, vDesc = etState.desc !== undefined ? etState.desc : p.desc, vCat = etState.cat !== undefined ? etState.cat : canonCat(p.category);
  return `<div class="edit-tab">
    <label>ምድብ</label>
    ${catPickHtml('etCat', vCat)}

    <label>ዓይነት</label>
    <div class="typerow">
      <button type="button" class="typebtn${etState.type === 'simple' ? ' active' : ''}" data-ettype="simple">ነጠላ ✓ (ቀላል)</button>
      <button type="button" class="typebtn${etState.type === 'checklist' ? ' active' : ''}" data-ettype="checklist">ማስተር (ንዑስ ዝርዝር)</button>
    </div>
    <div id="etSubWrap" ${etState.type !== 'checklist' ? 'hidden' : ''}>
      <label>ንዑስ ዝርዝሮች — ሁሉም ሲጠናቀቁ ማስተር ራሱ ✓ ይሆናል</label>
      <div id="etSubList">${etState.subItems.map((s, i) => `<div class="subedit"><input data-etsi="${i}" value="${esc(s.name)}" placeholder="ንዑስ ስም"><button type="button" class="subdel" data-etsdi="${i}">✕</button></div>`).join('')}</div>
      <button type="button" class="addsub" id="etAddSub">+ ንዑስ ጨምር</button>
    </div>

    <label for="etName">ስም</label><input type="text" id="etName" maxlength="60" value="${esc(vName)}">
    <label for="etDesc">ዝርዝር</label><textarea id="etDesc" maxlength="2000">${esc(vDesc)}</textarea>

    <label>መቼ ይታይ</label>
    <div class="daychips" id="etDayChips">
      <button type="button" class="daychip${etState.days === 'daily' ? ' active' : ''}" data-etd="daily">ዕለታዊ</button>
      ${PDAY_LABELS.map((l, i) => `<button type="button" class="daychip${Array.isArray(etState.days) && etState.days.includes(i + 1) ? ' active' : ''}" data-etd="${i + 1}">${l}</button>`).join('')}
    </div>

    <button type="button" class="savebtn" id="etSave">ለውጦችን አስቀምጥ</button>
    <button type="button" class="delbtn" id="etDelete">ይህን ፕሮግራም ሰርዝ</button>
  </div>`;
}
function convertToday(p, ds, wasDone) {   // the type just changed: today's saved value must fit the new type (a ✓ stays a ✓; the note is always kept)
  const old = logs[ds] && logs[ds][p.id];
  if (old === undefined || old === null || old === false) return false;
  const note = (old && typeof old === 'object' && typeof old.n === 'string') ? old.n : '';
  let v;
  if (p.type === 'checklist') {
    if (wasDone) { v = {}; p.subItems.forEach(s => { v[s.id] = true; }); if (note) v.n = note; } else v = note ? { n: note } : false;
  } else v = wasDone ? (note ? { r: 'v', n: note } : true) : (note ? { n: note } : false);
  if (JSON.stringify(v) === JSON.stringify(old)) return false;
  logs[ds][p.id] = v; persist(); return true;
}
function editTabRender(p) {
  etState = { type: p.type, days: Array.isArray(p.schedule) ? p.schedule.slice() : 'daily', subItems: p.type === 'checklist' ? p.subItems.map(s => ({ ...s })) : [] };
  $('detailBody').innerHTML = editTabHtml(p);
}
async function editTabClick(e) {
  const p = programs.find(x => x.id === detailId); if (!p) return;
  if (e.target.closest('[data-ettype],[data-etd],[data-etsdi],#etAddSub')) etKeep();
  const tbn = e.target.closest('[data-ettype]');
  if (tbn) { etState.type = tbn.dataset.ettype; $('detailBody').innerHTML = editTabHtml(p); return; }
  const dc = e.target.closest('[data-etd]');
  if (dc) {
    const val = dc.dataset.etd;
    if (val === 'daily') etState.days = 'daily';
    else {
      if (etState.days === 'daily') etState.days = [];
      const n = Number(val), idx = etState.days.indexOf(n);
      if (idx > -1) etState.days.splice(idx, 1); else etState.days.push(n);
      if (etState.days.length === 0) etState.days = 'daily';
    }
    $('detailBody').innerHTML = editTabHtml(p); return;
  }
  const sdi = e.target.closest('[data-etsdi]');
  if (sdi) { etState.subItems.splice(Number(sdi.dataset.etsdi), 1); $('detailBody').innerHTML = editTabHtml(p); return; }
  if (e.target.closest('#etAddSub')) { etState.subItems.push({ id: uid(), name: '' }); $('detailBody').innerHTML = editTabHtml(p); return; }
  if (e.target.closest('#etSave')) {
    const name = $('etName').value.trim(); if (!name) { toast('ስም ያስፈልጋል'); return; }
    const validSubs = etState.subItems.filter(s => s.name.trim());
    if (etState.type === 'checklist' && validSubs.length < 1) { toast('ቢያንስ አንድ ንዑስ ዝርዝር ጨምር'); return; }
    const newCat = getCat('etCat');
    if (catKey(newCat) !== catKey(p.category)) p.catSet = true;   // so a data.js refresh never undoes the category you picked
    p.name = name; p.desc = $('etDesc').value; p.category = newCat;
    const newSched = etState.days === 'daily' ? 'daily' : etState.days.slice(), tdy = fmt(today());
    if (!sameSched(p.schedule, newSched) && p.createdAt < tdy) {   // new weekdays start TODAY; days already over keep the old ones
      p.sh = Array.isArray(p.sh) ? p.sh : [];
      if (!p.sh.length || p.sh[p.sh.length - 1].u !== tdy) p.sh.push({ u: tdy, s: copySched(p.schedule) });
    }
    // sub-items / single <-> master: the new shape starts TODAY; days already over keep the old shape (see "THE SHAPE OF AN ACTIVITY")
    const oldType = p.type, oldSubs = oldType === 'checklist' && Array.isArray(p.subItems) ? p.subItems.map(s => ({ id: s.id, name: s.name })) : [];
    const newSubs = etState.type === 'checklist' ? validSubs.map(s => ({ id: s.id, name: s.name.trim() })) : [];
    const shapeChanged = oldType !== etState.type || oldSubs.map(s => s.id).join('|') !== newSubs.map(s => s.id).join('|');
    const wasDoneToday = shapeChanged && isDone(tdy, p);   // read BEFORE the change
    if (shapeChanged && p.createdAt < tdy) {
      p.vh = Array.isArray(p.vh) ? p.vh : [];
      if (!p.vh.length || p.vh[p.vh.length - 1].u !== tdy) p.vh.push({ u: tdy, t: oldType, s: oldSubs });
    }
    p.type = etState.type; p.schedule = newSched;
    if (etState.type === 'checklist') p.subItems = newSubs; else delete p.subItems;
    p.customized = true;
    const conv = oldType !== p.type && dayEditable(tdy) && convertToday(p, tdy, wasDoneToday);
    savePrograms(); toast(conv ? 'ተቀምጧል። የዛሬው ምልክት ከአዲሱ ዓይነት ጋር ተስተካክሏል።' : 'ተቀምጧል።'); render(); return;
  }
  if (e.target.closest('#etDelete')) {
    const i = await choiceDialog('ይህን ፕሮግራም ወደ ቆሻሻ መጣያ ማዛወር ይፈልጋሉ?', ['አዎ፣ ሰርዝ', 'አይ']);
    if (i !== 0) return;
    const removed = programs.find(x => x.id === detailId); if (!removed) return;
    const idx = programs.indexOf(removed), delDs = fmt(today());
    programs = programs.filter(x => x.id !== removed.id);
    savePrograms(); closeDetail();
    markSeedRemoved('program', removed);
    const trashId = trashAdd('program', removed); render();
    showUndo('ፕሮግራም ወደ ቆሻሻ መጣያ ተዛወረ', () => { reinstate(removed, delDs); programs.splice(idx, 0, removed); savePrograms(); unmarkSeedRemoved('program', removed.id); trashRemove(trashId); render(); });
  }
}
$('detailBody').addEventListener('click', e => {
  if (detailTab === 'cal') {
    if (e.target.closest('#calPrev')) { calMonth.setMonth(calMonth.getMonth() - 1); renderDetail(); return; }
    if (e.target.closest('#calNext')) { calMonth.setMonth(calMonth.getMonth() + 1); renderDetail(); return; }
  }
  if (detailTab === 'edit') editTabClick(e);
});
$('detailBody').addEventListener('input', e => {
  if (detailTab !== 'edit') return;
  const i = e.target.closest('[data-etsi]');
  if (i) etState.subItems[i.dataset.etsi].name = e.target.value;
});

/* ============================================================
   RECYCLE BIN VIEW — a full-screen page (same look as the program
   detail view) listing every trashed program/page, each with its own
   ♻ Restore and 🗑 "delete forever" buttons. Opened from ⚙ Settings.
   ============================================================ */
/* ---------- category manager: rename / merge / delete a whole category ---------- */
const catView = $('catView'); let catEdit = null;   // catEdit = { mode:'ren'|'del', key }
function renderCatView() {
  const cats = categories(), none = programs.filter(p => !catKey(p.category)).length;
  const row = c => {
    if (catEdit && catEdit.key === c.key && catEdit.mode === 'ren') return `<div class="cat-row glass editing"><input type="text" id="catRenInput" maxlength="30" value="${esc(c.name)}" aria-label="አዲስ ስም"><div class="cat-hint" id="catRenHint"></div><div class="cat-acts"><button type="button" class="cat-save" data-catok="${esc(c.key)}">አስቀምጥ</button><button type="button" class="cat-cancel" data-catno="1">ተው</button></div></div>`;
    if (catEdit && catEdit.key === c.key && catEdit.mode === 'del') return `<div class="cat-row glass editing"><div class="cat-q">«${esc(c.name)}» ሲሰረዝ ${c.count} ፕሮግራሞች ወዴት ይዛወሩ?</div><select id="catMoveTo" class="clp-sel"><option value="">ያለ ምድብ</option>${cats.filter(x => x.key !== c.key).map(x => `<option value="${esc(x.name)}">${esc(x.name)}</option>`).join('')}</select><div class="cat-acts"><button type="button" class="cat-save danger" data-catdelok="${esc(c.key)}">አዛውር እና ምድቡን ሰርዝ</button><button type="button" class="cat-cancel" data-catno="1">ተው</button></div></div>`;
    return `<div class="cat-row glass"><div class="cat-main"><b>${esc(c.name)}</b><small>${c.count} ፕሮግራም</small></div><button type="button" class="cat-btn" data-catren="${esc(c.key)}" aria-label="ስም ቀይር">✎</button><button type="button" class="cat-btn" data-catdel="${esc(c.key)}" aria-label="ምድቡን ሰርዝ">🗑</button></div>`;
  };
  $('catBody').innerHTML = '<p class="cat-help">ስም ሲቀይሩ በዚያ ምድብ ውስጥ ያሉ ሁሉም ፕሮግራሞች ይቀየራሉ። ከሌላ ምድብ ስም ጋር ካስተካከሉ ሁለቱ ይዋሃዳሉ።</p>' +
    (cats.length ? cats.map(row).join('') : '<p class="cat-help">ገና ምድብ የለም። ፕሮግራም ሲጨምሩ ወይም ሲያስተካክሉ ምድብ ይምረጡ ወይም አዲስ ይፍጠሩ።</p>') +
    (none ? `<div class="cat-row none"><div class="cat-main"><b>ያለ ምድብ</b><small>${none} ፕሮግራም</small></div></div>` : '');
}
function openCats() { if (ROLE.r) return; catEdit = null; renderCatView(); catView.classList.add('open'); }
function closeCats() { catView.classList.remove('open'); catEdit = null; }
$('catBack').onclick = closeCats;
$('catsBtn').onclick = () => { $('settingsPanel').classList.remove('open'); $('settingsBtn').setAttribute('aria-expanded', 'false'); openCats(); };
$('catBody').addEventListener('input', e => {
  if (e.target.id !== 'catRenInput') return;
  const k = catKey(e.target.value), ex = categories().find(c => c.key === k && catEdit && c.key !== catEdit.key);
  $('catRenHint').textContent = ex ? `⚠ «${ex.name}» አስቀድሞ አለ — ሁለቱ ይዋሃዳሉ` : '';
});
$('catBody').addEventListener('click', e => {
  const r = e.target.closest('[data-catren]'), d = e.target.closest('[data-catdel]'), ok = e.target.closest('[data-catok]'), dok = e.target.closest('[data-catdelok]'), no = e.target.closest('[data-catno]');
  if (r) { catEdit = { mode: 'ren', key: r.dataset.catren }; renderCatView(); const i = $('catRenInput'); if (i) { i.focus(); i.select(); } return; }
  if (d) { catEdit = { mode: 'del', key: d.dataset.catdel }; renderCatView(); return; }
  if (no) { catEdit = null; renderCatView(); return; }
  if (ok) {
    const to = catClean($('catRenInput').value); if (!to) { toast('ስም ያስፈልጋል'); return; }
    const n = renameCat(ok.dataset.catok, to); catEdit = null; renderCatView(); render(); toast(n ? 'ተቀይሯል።' : 'ተቀምጧል።'); return;
  }
  if (dok) { const n = renameCat(dok.dataset.catdelok, $('catMoveTo').value); catEdit = null; renderCatView(); render(); toast(`ምድቡ ተሰርዟል · ${n} ፕሮግራም ተዛውሯል።`); }
});

const trashView = $('trashView');
function openTrash() { renderTrashView(); trashView.classList.add('open'); }
function closeTrash() { trashView.classList.remove('open'); }
$('trashBack').onclick = closeTrash;
$('trashBtn').onclick = () => {
  $('settingsPanel').classList.remove('open'); $('settingsBtn').setAttribute('aria-expanded', 'false');
  openTrash();
};

function renderTrashView() {
  updateTrashBadge();
  $('trashClearAll').hidden = !trash.length;
  $('trashBody').innerHTML = trash.length ? trash.map(t => {
    const name = t.kind === 'program' ? t.data.name : t.data.title;
    const sub = t.kind === 'program' ? (t.data.category || 'ፕሮግራም') : 'ገፅ';
    let when; try { when = new Date(t.deletedAt).toLocaleDateString('am-ET', { month: 'short', day: 'numeric', year: 'numeric' }); }
    catch (e) { when = new Date(t.deletedAt).toLocaleDateString(); }
    return `<div class="trash-card glass">
      <div class="trash-info">
        <div class="name">${esc(name)}<span class="tag">${esc(sub)}</span></div>
        <div class="trash-when">የተሰረዘው፡ ${when}</div>
      </div>
      <div class="trash-actions">
        <button type="button" class="trash-restore" data-restore="${t.id}">♻ መልስ</button>
        <button type="button" class="trash-purge" data-purge="${t.id}">🗑 ለዘላለም ሰርዝ</button>
      </div></div>`;
  }).join('') : `<div class="trash-empty">ቆሻሻ መጣያ ባዶ ነው።</div>`;
}
$('trashBody').addEventListener('click', async e => {
  const rb = e.target.closest('[data-restore]'), pb = e.target.closest('[data-purge]');
  if (rb) {
    const t = trash.find(x => x.id === rb.dataset.restore); if (!t) return;
    if (t.kind === 'program') {
      if (programs.some(p => p.id === t.data.id)) { toast('ይህ ፕሮግራም አስቀድሞ አለ'); return; }
      const back = t.data, was = new Date(t.deletedAt);
      reinstate(back, isNaN(was) ? fmt(today()) : fmt(was));   // the days it spent in the bin do not suddenly count again
      programs.push(back); unmarkSeedRemoved('program', back.id); savePrograms(); render();
    } else {
      if (pages.some(p => p.id === t.data.id)) { toast('ይህ ገፅ አስቀድሞ አለ'); return; }
      pages.push(t.data); unmarkSeedRemoved('page', t.data.id); savePages(); renderPages();
    }
    trashRemove(t.id); renderTrashView(); toast('ተመልሷል!');
    return;
  }
  if (pb) {
    const i = await choiceDialog('ይህን ለዘላለም መሰረዝ ይፈልጋሉ? ፕሮግራም ከሆነ ያለፉ ቀናት ውጤቱም ይጠፋል። መመለስ አይቻልም።', ['አዎ፣ ለዘላለም ሰርዝ', 'አይ']);
    if (i !== 0) return;
    trashRemove(pb.dataset.purge); renderTrashView(); toast('ለዘላለም ተሰርዟል።');
  }
});
$('trashClearAll').onclick = async () => {
  const i = await choiceDialog('ቆሻሻ መጣያውን ሙሉ በሙሉ ባዶ ማድረግ ይፈልጋሉ? የተሰረዙ ፕሮግራሞች ያለፉ ቀናት ውጤትም ይጠፋል። መመለስ አይቻልም።', ['አዎ፣ ባዶ አድርግ', 'አይ']);
  if (i !== 0) return;
  trash = []; saveTrash(); renderTrashView(); updateTrashBadge(); toast('ቆሻሻ መጣያ ባዶ ሆኗል።');
};

/* ---------- backup / restore (now includes pages, trash too) ---------- */
$('exportBtn').onclick = async () => {
  const data = { programs, logs, dayOv, pages, trash, removedSeedIds: [...removedSeedIds], exportedAt: new Date().toISOString() };
  const json = JSON.stringify(data, null, 2);
  const filename = 'tesnim-backup-' + fmt(new Date()) + '.json';
  // When running inside a Claude-hosted page, a plain <a download> link is
  // inert — use the platform's downloads capability instead. When running
  // as a normal deployed site (Netlify/Vercel/etc.), window.claude doesn't
  // exist, so this falls straight through to the plain browser download.
  try {
    const downloads = window.claude ? await window.claude.use('downloads') : null;
    if (downloads) { await downloads.save({ filename, data: json }); toast('ምትኬ ወርዷል!'); return; }
  } catch (e) { /* declined/unavailable — fall back below */ }
  const blob = new Blob([json], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
};
$('importBtn').onclick = () => $('importFile').click();
$('importFile').onchange = e => {
  const f = e.target.files[0]; if (!f) return;
  const r = new FileReader();
  r.onload = () => {
    try {
      const data = JSON.parse(r.result);
      if (Array.isArray(data.programs)) { programs = data.programs; programs.forEach(p => { if (p && !p.createdAt) p.createdAt = FIRST_RUN; }); }
      if (data.logs) logs = data.logs;
      if (data.dayOv) dayOv = data.dayOv;
      if (Array.isArray(data.pages)) pages = data.pages;
      if (Array.isArray(data.trash)) trash = data.trash;
      if (Array.isArray(data.removedSeedIds)) removedSeedIds = new Set(data.removedSeedIds);
      savePrograms(); savePages(); saveTrash(); saveRemovedSeeds(); persist(); render(); renderPages(); updateTrashBadge(); toast('ምትኬ ተመልሷል!');
    } catch (err) { toast('ፋይሉ ትክክል አይደለም'); }
  };
  r.readAsText(f); e.target.value = '';
};

/* ---------- optional daily reminder (works only while this tab/app is open) ---------- */
function startReminderWatch() {
  if (localStorage.getItem(LS_REM) !== '1') return;
  setInterval(() => {
    const n = new Date();
    if (n.getHours() === 8 && n.getMinutes() === 0) {
      const ds = fmt(today()), tasks = tasksFor(today());
      if (tasks.filter(p => isDone(ds, p)).length < tasks.length) {
        new Notification('የተስኒም ማስተር ፕሮግራም', { body: 'የዛሬ ፕሮግራምዎን ይመልከቱ 💪' });
      }
    }
  }, 60000);
}
$('remindBtn').onclick = async () => {
  if (!('Notification' in window)) { toast('ይህ አሳሻ ማሳወቂያ አይደግፍም'); return; }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') { toast('ማሳወቂያ አልተፈቀደም'); return; }
  localStorage.setItem(LS_REM, '1'); toast('ዕለታዊ ማሳወቂያ ነቅቷል (መተግበሪያው ክፍት ሆኖ ሳለ)'); startReminderWatch();
};
startReminderWatch();

// Registers public/sw.js - the offline-first worker (it saves the app on the
// phone so it opens with no internet, but always asks the internet first).
// Only in the built/deployed app, not while developing with `npm run dev`.
if ('serviceWorker' in navigator && import.meta.env.PROD) navigator.serviceWorker.register('/sw.js').catch(() => {});

renderPages();
render();
updateTrashBadge();
