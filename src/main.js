// Phase 3A part 2: results for simple activities - ✓ done, ✗ not done, 1-99% partly done. (Notes come in part 3.)
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
      programs[idx] = { ...seed, seed: true, customized: false, createdAt: programs[idx].createdAt || FIRST_RUN };
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
const savePrograms = () => localStorage.setItem(LS_PROGRAMS, JSON.stringify(programs));
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
const saveTrash = () => localStorage.setItem(LS_TRASH, JSON.stringify(trash));
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
const appliesOn = (p, d) => p.schedule === 'daily' || (Array.isArray(p.schedule) && p.schedule.includes(pDay(d)));
const tasksFor = d => programs.filter(p => appliesOn(p, d));
const disp = (p, ds) => { const o = dayOv[ds] && dayOv[ds][p.id]; return o ? { ...p, ...o } : p; };
/* ---------- RESULTS (Phase 3A part 2) ----------
   What is stored in logs[ds][id]:
     a checklist (master) activity : { subId:true,... }                   (unchanged)
     a simple activity             : false / missing   = nothing marked
                                     true              = ✓ done           (the old format - still valid)
                                     { r:'x' }         = ✗ not done
                                     { r:'p', p:60 }   = partly done, 1-99 %
                                     { n:'text' } or the forms above plus  n:'text'  = a note (part 3)
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
function isDone(ds, p) {
  const l = logs[ds] && logs[ds][p.id];
  if (!l) return false;
  if (p.type === 'checklist') return p.subItems.every(s => l[s.id] === true);
  return parseRes(l).k === 'v';
}
function resOf(ds, p) {   // what to show for this activity on this day
  if (p.type === 'checklist') return isDone(ds, p) ? { k: 'v', pct: 100 } : { k: '', pct: 0 };
  return parseRes(logs[ds] && logs[ds][p.id]);
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
const subDone = (ds, p, sid) => !!(logs[ds] && logs[ds][p.id] && logs[ds][p.id][sid]);

/* ---------- streaks & motivation ---------- */
function streakUpTo(d) { // app-wide: every applicable task done, how many days in a row
  // Today is still in progress, so an unfinished TODAY does not break the streak:
  // we simply start counting from yesterday (this fixes "streak is 0 every morning").
  let s = 0, cur = new Date(d);
  const t0 = tasksFor(cur);
  if (!t0.length || t0.some(p => !isDone(fmt(cur), p))) cur.setDate(cur.getDate() - 1);
  while (true) {
    const ds = fmt(cur), tasks = tasksFor(cur);
    if (!tasks.length || tasks.filter(p => isDone(ds, p)).length < tasks.length) break;
    s++; cur.setDate(cur.getDate() - 1);
  }
  return s;
}
function programStreak(p) { // just this one program, how many days in a row
  let s = 0, cur = today();
  const t0 = fmt(cur);
  while (fmt(cur) >= p.createdAt) {
    const ds = fmt(cur);
    if (appliesOn(p, cur)) {
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
    const na = !appliesOn(p, d) || dds < p.createdAt;
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
function cardFootHtml(p) {
  const t = today(), ds0 = fmt(t);
  const wkStart = new Date(t); wkStart.setDate(t.getDate() - ((t.getDay() + 6) % 7));
  const wk = periodStats(p, fmt(wkStart), ds0);
  return `<div class="card-foot">
    <span class="cf-stat">🔥 ${programStreak(p)}</span>
    <span class="cf-stat">✓ ${wk.total ? Math.round(wk.pct * 100) : 0}%</span>
    <span class="cf-spacer"></span>
    ${p.type !== 'checklist' ? `<button type="button" class="cf-btn cf-res" data-res="${p.id}" aria-label="ውጤት ምረጥ">ውጤት</button>` : ''}
    <button type="button" class="cf-btn" data-opencal="${p.id}" aria-label="ቀን መቁጠሪያ">📅</button>
    <button type="button" class="cf-btn" data-openstat="${p.id}" aria-label="ስታትስቲክስ">📊</button>
  </div>`;
}
function card(p, ds) {
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
        <div class="name">${esc(t.name)}${t.category ? `<span class="tag">${esc(t.category)}</span>` : ''}</div>
        <div class="desc">${descHtml(t.desc)}</div>${subHtml}
      </div>
      <div class="actions">
        <button class="tick${done ? ' done' : rs.k === 'x' ? ' fail' : rs.k === 'p' ? ' part' : ''}" data-tick="${p.id}" aria-label="${done ? 'እንደ አልተጠናቀቀ ምልክት አድርግ' : 'እንደተጠናቀቀ ምልክት አድርግ'}">${done ? '✓' : rs.k === 'x' ? '✗' : rs.k === 'p' ? rs.pct + '%' : ''}</button>
        <button class="edit" data-edit="${p.id}" aria-label="ፈጣን አርትዕ">✎</button>
        <button class="del" data-del="${p.id}" aria-label="ሰርዝ">🗑</button>
      </div>
    </div>
    ${weekStripHtml(p)}
    ${cardFootHtml(p)}
  </div>`;
}

/* ---------- main render ---------- */
function render() {
  const ds = fmt(sel), all = tasksFor(sel);
  const dayPrograms = all.filter(p => Array.isArray(p.schedule));
  const dailyPrograms = all.filter(p => p.schedule === 'daily');
  const doneAll = all.filter(p => isDone(ds, p));
  // the ring and reports count ONLY the activities this person can see
  const ringAll = all, ringDone = doneAll;
  const CIRC = 2 * Math.PI * 26, pct = ringAll.length ? ringDone.length / ringAll.length : 0;

  const editable = dayEditable(ds);
  document.body.classList.toggle('day-locked', !editable);
  $('dLbl').textContent = WD[sel.getDay()] + (editable ? '' : ' 🔒');
  $('dSub').textContent = sel.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const rf = $('ringFill'); rf.style.strokeDasharray = CIRC; rf.style.strokeDashoffset = CIRC * (1 - pct);
  $('ringText').innerHTML = `<b>${Math.round(pct * 100)}%</b><br>${ringDone.length} ከ ${ringAll.length} ተጠናቅቋል`;

  const byIncomplete = (a, b) => isDone(ds, a) - isDone(ds, b);
  $('list').innerHTML =
    (dayPrograms.length ? '<div class="sect-lbl">የቀኑ ፕሮግራም</div>' + dayPrograms.slice().sort(byIncomplete).map(p => card(p, ds)).join('') : '') +
    (dailyPrograms.length ? '<div class="sect-lbl">ዕለታዊ ማሳሰቢያ</div>' + dailyPrograms.slice().sort(byIncomplete).map(p => card(p, ds)).join('') : '') +
    (!all.length ? '<div class="sect-lbl">ምንም ፕሮግራም የለም — ከላይ ባለው ＋ ይጨምሩ</div>' : '');

  drawDayReport(ds, ringAll, ringDone, pct);
  drawWeek();

  if (lastPct !== null && pct === 1 && lastPct < 1) celebrate();
  lastPct = pct;
}

function drawDayReport(ds, all, doneAll, pct) {
  const left = all.filter(p => !isDone(ds, p));
  const streak = streakUpTo(today());
  $('dayReportPanel').innerHTML =
    `<div class="week-total">${Math.round(pct * 100)}% — ${motivate(pct)}</div>` +
    `<div class="streak">🔥 ${streak} ቀን ተከታታይ ሙሉ ማጠናቀቅ</div>` +
    (left.length
      ? `<div class="rep-h">የቀሩ (${left.length})</div><ul class="rep-list">` + left.map(p => `<li>${esc(disp(p, ds).name)}</li>`).join('') + '</ul>'
      : `<div class="rep-h done">ሁሉንም ዛሬ አጠናቅቀሃል! 🎉</div>`) +
    (doneAll.length ? `<div class="rep-h done">የተጠናቀቀ (${doneAll.length})</div><ul class="rep-list done">` + doneAll.map(p => `<li>${esc(disp(p, ds).name)}</li>`).join('') + '</ul>' : '');
}

function drawWeek() {
  const mon = new Date(sel); mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7));
  let td = 0, tt = 0, rows = '', winDays = 0;
  const stats = {};
  for (let i = 0; i < 7; i++) {
    const d = new Date(mon); d.setDate(mon.getDate() + i); const ds = fmt(d);
    const tasks = tasksFor(d), doneList = tasks.filter(p => isDone(ds, p)), n = doneList.length;
    td += n; tt += tasks.length;
    if (tasks.length && n === tasks.length) winDays++;
    const pct = tasks.length ? n / tasks.length : 0;
    const cls = pct >= 0.8 ? 'hi' : pct >= 0.4 ? 'mid' : 'lo';
    rows += `<div class="week-row"><span class="wname">${WD[d.getDay()]}</span><div class="week-bar"><i class="${cls}" style="width:${tasks.length ? 100 * n / tasks.length : 0}%"></i></div><span class="week-frac">${n}/${tasks.length}</span></div>`;
    tasks.forEach(p => {
      stats[p.id] = stats[p.id] || { name: disp(p, ds).name, done: 0, total: 0 };
      stats[p.id].total++; if (isDone(ds, p)) stats[p.id].done++;
    });
  }
  const weak = Object.values(stats).filter(s => s.total > 0 && s.done / s.total < 0.6).sort((a, b) => (a.done / a.total) - (b.done / b.total)).slice(0, 3);
  $('weekPanel').innerHTML = `<div class="week-total">ጠቅላላ የሳምንቱ ውጤት፡ ${tt ? Math.round(100 * td / tt) : 0}% · 🔥 ${winDays}/7 ሙሉ ቀናት</div>` + rows +
    (weak.length ? `<div class="rep-h">ትኩረት የሚፈልጉ</div><ul class="rep-list">` + weak.map(w => `<li>${esc(w.name)} — ${w.done}/${w.total}</li>`).join('') + '</ul>' : '');
}

function pop(sel) { const el = $('list').querySelector(sel); if (el) { el.classList.add('pop'); setTimeout(() => el.classList.remove('pop'), 350); } }

/* ---------- list clicks: open detail / tick / sub-tick / week-strip tick / quick-edit / delete / jump-to-tab ---------- */
$('list').onclick = async e => {
  const sb = e.target.closest('[data-subtick]'), tb = e.target.closest('[data-tick]'),
        eb = e.target.closest('[data-edit]'), db = e.target.closest('[data-del]'),
        ob = e.target.closest('[data-open]'), wb = e.target.closest('[data-wtick]'),
        cb = e.target.closest('[data-opencal]'), stb = e.target.closest('[data-openstat]'),
        rsb = e.target.closest('[data-res]');
  const ds = fmt(sel);

  if (wb) {
    // Tapping a day in a card's mini week-strip ticks THAT day directly —
    // independent of whichever day the ‹/› nav up top is currently on.
    const [pid, wds] = wb.dataset.wtick.split(':');
    if (!dayEditable(wds)) { lockToast(wds); return; }
    const p = programs.find(x => x.id === pid); if (!p) return;
    if (p.type === 'checklist') {
      const wasDone = isDone(wds, p);
      logs[wds] = logs[wds] || {}; logs[wds][p.id] = {};
      p.subItems.forEach(s => logs[wds][p.id][s.id] = !wasDone);
    } else {
      toggleSimple(wds, p);
    }
    persist(); render(); return;
  }
  if (rsb) {   // "ውጤት": pick ✓ / ✗ / % for the day that is on screen
    const pid = rsb.dataset.res, p0 = programs.find(x => x.id === pid);
    if (!p0 || p0.type === 'checklist') return;
    if (!dayEditable(ds)) { lockToast(ds); return; }
    const r = await resultDialog(p0, ds); if (!r) return;
    const p1 = programs.find(x => x.id === pid);
    if (!p1) return;
    if (!dayEditable(ds)) { lockToast(ds); return; }
    setRes(ds, p1, r.k, r.pct); persist(); render(); pop(`[data-tick="${pid}"]`); return;
  }
  if (cb) { openDetail(cb.dataset.opencal, 'cal'); return; }
  if (stb) { openDetail(stb.dataset.openstat, 'stat'); return; }

  if (sb) {
    if (!dayEditable(ds)) { lockToast(ds); return; }
    const [pid, sid] = sb.dataset.subtick.split(':');
    logs[ds] = logs[ds] || {}; logs[ds][pid] = logs[ds][pid] || {};
    logs[ds][pid][sid] = !logs[ds][pid][sid]; persist(); render();
    pop(`[data-subtick="${pid}:${sid}"]`); return;
  }
  if (tb) {
    if (!dayEditable(ds)) { lockToast(ds); return; }
    const id = tb.dataset.tick, p = programs.find(x => x.id === id);
    if (p.type === 'checklist') {
      const wasDone = isDone(ds, p);
      logs[ds] = logs[ds] || {}; logs[ds][p.id] = {};
      p.subItems.forEach(s => logs[ds][p.id][s.id] = !wasDone);
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
    const removed = programs.find(x => x.id === id), idx = programs.indexOf(removed);
    programs = programs.filter(x => x.id !== id); savePrograms(); render();
    markSeedRemoved('program', removed);
    const trashId = trashAdd('program', removed);
    showUndo('ፕሮግራም ወደ ቆሻሻ መጣያ ተዛወረ', () => { programs.splice(idx, 0, removed); savePrograms(); unmarkSeedRemoved('program', removed.id); trashRemove(trashId); render(); });
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
  $('eName').value = t.name; $('eDesc').value = t.desc;
  overlay.classList.add('open'); sheet.classList.add('open');
}
const closeEdit = () => { overlay.classList.remove('open'); sheet.classList.remove('open'); };
$('eCancel').onclick = closeEdit;
addEventListener('keydown', e => { if (e.key === 'Escape') { closeEdit(); closeAdd(); closePageSheet(); closeDetail(); closeTrash(); } });
$('eSave').onclick = async () => {
  const n = $('eName').value.trim(); if (!n) return;
  const desc = $('eDesc').value;
  const i = await choiceDialog('ይህን ለውጥ የት ይተግብር?', ['ለዛሬ ብቻ', 'ለሁልጊዜው']);
  if (i === -1) return;
  if (i === 0) {
    const ds = fmt(sel); dayOv[ds] = dayOv[ds] || {}; dayOv[ds][editId] = { name: n, desc };
  } else {
    const p = programs.find(x => x.id === editId); p.name = n; p.desc = desc; p.customized = true; savePrograms();
  }
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
  $('aName').value = ''; $('aDesc').value = ''; $('aCat').value = '';
  document.querySelectorAll('#addSheet .typebtn').forEach(b => b.classList.toggle('active', b.dataset.type === 'simple'));
  $('subWrap').hidden = true; renderSubEditor();
  document.querySelectorAll('#addSheet .daychip').forEach(b => b.classList.toggle('active', b.dataset.d === 'daily'));
  $('catList').innerHTML = [...new Set(programs.map(p => p.category).filter(Boolean))].map(c => `<option value="${esc(c)}">`).join('');
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
    id: uid(), name: n, desc: $('aDesc').value, category: $('aCat').value.trim(), type: addType,
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
  $('detailCat').textContent = p.category || '';
  $('detailCat').hidden = !p.category;
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
    const na = !appliesOn(p, dt) || ds < p.createdAt;
    let cls = 'na';
    if (!na) cls = isDone(ds, p) ? 'done' : (dt > t ? 'upcoming' : 'missed');
    cells += `<div class="cal-cell ${cls}${isToday ? ' today' : ''}">${d}</div>`;
  }
  let monthLabel;
  try { monthLabel = calMonth.toLocaleDateString('am-ET', { month: 'long', year: 'numeric' }); }
  catch (e) { monthLabel = `${calMonth.getFullYear()}-${pad(calMonth.getMonth() + 1)}`; }
  return `
    <div class="cal-nav"><button type="button" id="calPrev">‹</button><b>${esc(monthLabel)}</b><button type="button" id="calNext">›</button></div>
    <div class="cal-grid">${['ሰኞ', 'ማክ', 'ረቡ', 'ሐሙ', 'አር', 'ቅዳ', 'እሁ'].map(l => `<div class="cal-wd">${l}</div>`).join('')}${cells}</div>
    <div class="cal-legend"><span><i class="done"></i>ተጠናቅቋል</span><span><i class="missed"></i>አልተጠናቀቀም</span><span><i class="upcoming"></i>ገና አልደረሰም</span></div>
    <div class="detail-desc glass"><h4>ዝርዝር መግለጫ</h4>${descHtml(p.desc)}</div>`;
}

function periodStats(p, fromDs, toDs) {
  let done = 0, total = 0;
  let cur = parseDs(fromDs); const end = parseDs(toDs);
  while (cur <= end) {
    if (appliesOn(p, cur)) {
      const ds = fmt(cur);
      if (ds >= p.createdAt) { total++; if (isDone(ds, p)) done++; }
    }
    cur.setDate(cur.getDate() + 1);
  }
  return { done, total, pct: total ? done / total : 0 };
}

function statsTabHtml(p) {
  const t = today(), ds0 = fmt(t);
  let trend = '';
  for (let i = 6; i >= 0; i--) {
    const d = new Date(t); d.setDate(d.getDate() - i); const ds = fmt(d);
    const na = !appliesOn(p, d) || ds < p.createdAt;
    const cls = na ? 'na' : (isDone(ds, p) ? 'done' : (d.getTime() < t.getTime() ? 'missed' : 'na'));
    trend += `<div class="trend-cell"><span>${PDAY_LABELS[(d.getDay() + 6) % 7][0]}</span><div class="trend-dot ${cls}">${cls === 'done' ? '✓' : ''}</div></div>`;
  }
  const wkStart = new Date(t); wkStart.setDate(t.getDate() - ((t.getDay() + 6) % 7));
  const moStart = new Date(t.getFullYear(), t.getMonth(), 1);
  const yrStart = new Date(t.getFullYear(), 0, 1);
  const allTime = periodStats(p, p.createdAt, ds0);
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
      <div class="glass"><b>${Math.round(allTime.pct * 100)}%</b><span>ጠቅላላ ውጤት</span></div>
    </div>
    <div class="trend-row">${trend}</div>
    ${rows.map(([label, s]) => `
      <div class="stat-row"><div class="stat-row-h"><span>${esc(label)}</span><b>${s.total ? Math.round(s.pct * 100) + '% (' + s.done + '/' + s.total + ')' : '—'}</b></div>
      <div class="stat-bar"><i style="width:${Math.round(s.pct * 100)}%"></i></div></div>`).join('')}`;
}

function editTabHtml(p) {
  const catOptions = [...new Set(programs.map(x => x.category).filter(Boolean))];
  return `<div class="edit-tab">
    <label for="etCat">ምድብ</label>
    <input type="text" id="etCat" list="etCatList" maxlength="30" value="${esc(p.category || '')}">
    <datalist id="etCatList">${catOptions.map(c => `<option value="${esc(c)}">`).join('')}</datalist>

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

    <label for="etName">ስም</label><input type="text" id="etName" maxlength="60" value="${esc(p.name)}">
    <label for="etDesc">ዝርዝር</label><textarea id="etDesc" maxlength="2000">${esc(p.desc)}</textarea>

    <label>መቼ ይታይ</label>
    <div class="daychips" id="etDayChips">
      <button type="button" class="daychip${etState.days === 'daily' ? ' active' : ''}" data-etd="daily">ዕለታዊ</button>
      ${PDAY_LABELS.map((l, i) => `<button type="button" class="daychip${Array.isArray(etState.days) && etState.days.includes(i + 1) ? ' active' : ''}" data-etd="${i + 1}">${l}</button>`).join('')}
    </div>

    <button type="button" class="savebtn" id="etSave">ለውጦችን አስቀምጥ</button>
    <button type="button" class="delbtn" id="etDelete">ይህን ፕሮግራም ሰርዝ</button>
  </div>`;
}
function editTabRender(p) {
  etState = { type: p.type, days: Array.isArray(p.schedule) ? p.schedule.slice() : 'daily', subItems: p.type === 'checklist' ? p.subItems.map(s => ({ ...s })) : [] };
  $('detailBody').innerHTML = editTabHtml(p);
}
async function editTabClick(e) {
  const p = programs.find(x => x.id === detailId); if (!p) return;
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
    p.name = name; p.desc = $('etDesc').value; p.category = $('etCat').value.trim();
    p.type = etState.type; p.schedule = etState.days === 'daily' ? 'daily' : etState.days.slice();
    if (etState.type === 'checklist') p.subItems = validSubs.map(s => ({ id: s.id, name: s.name.trim() }));
    else delete p.subItems;
    p.customized = true;
    savePrograms(); toast('ተቀምጧል።'); render(); return;
  }
  if (e.target.closest('#etDelete')) {
    const i = await choiceDialog('ይህን ፕሮግራም ወደ ቆሻሻ መጣያ ማዛወር ይፈልጋሉ?', ['አዎ፣ ሰርዝ', 'አይ']);
    if (i !== 0) return;
    const removed = programs.find(x => x.id === detailId), idx = programs.indexOf(removed);
    programs = programs.filter(x => x.id !== detailId);
    savePrograms(); closeDetail(); render();
    markSeedRemoved('program', removed);
    const trashId = trashAdd('program', removed);
    showUndo('ፕሮግራም ወደ ቆሻሻ መጣያ ተዛወረ', () => { programs.splice(idx, 0, removed); savePrograms(); unmarkSeedRemoved('program', removed.id); trashRemove(trashId); render(); });
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
      programs.push(t.data); unmarkSeedRemoved('program', t.data.id); savePrograms(); render();
    } else {
      if (pages.some(p => p.id === t.data.id)) { toast('ይህ ገፅ አስቀድሞ አለ'); return; }
      pages.push(t.data); unmarkSeedRemoved('page', t.data.id); savePages(); renderPages();
    }
    trashRemove(t.id); renderTrashView(); toast('ተመልሷል!');
    return;
  }
  if (pb) {
    const i = await choiceDialog('ይህን ለዘላለም መሰረዝ ይፈልጋሉ? መመለስ አይቻልም።', ['አዎ፣ ለዘላለም ሰርዝ', 'አይ']);
    if (i !== 0) return;
    trashRemove(pb.dataset.purge); renderTrashView(); toast('ለዘላለም ተሰርዟል።');
  }
});
$('trashClearAll').onclick = async () => {
  const i = await choiceDialog('ቆሻሻ መጣያውን ሙሉ በሙሉ ባዶ ማድረግ ይፈልጋሉ? መመለስ አይቻልም።', ['አዎ፣ ባዶ አድርግ', 'አይ']);
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
      if (Array.isArray(data.programs)) programs = data.programs;
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
