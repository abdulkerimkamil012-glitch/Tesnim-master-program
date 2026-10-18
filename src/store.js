/* ============================================================
   STORE (Bundle C) — the ONE place where the app keeps its data on this phone.

   Before: everything lived in localStorage (a small ~5 MB notebook), the whole tick history was ONE value, and
   public/cloud.js kept a SECOND full copy of it (tesnim_prev) and patched localStorage.setItem to notice changes.
   Now:
     * Data lives in IndexedDB (the browser's big drawer). The tick history is split BY MONTH (one record per
       month), so saving a tick rewrites one month, not years of history.
     * Instead of a second full copy, an OUTBOX keeps only the ticks not yet sent to the server.
     * Everything is also kept in memory, so the app reads synchronously (fast) and writes in the background.
     * Every change sends an event: 'change' (a key), 'log' (ticks), 'remote' (server data arrived),
       'error' (could not save). public/cloud.js no longer needs to patch anything.
     * If IndexedDB is not available (some private windows), it falls back to localStorage, then to memory only,
       and says so on the profile page. A failed save is never silent: it is kept and retried.
   Small per-phone settings (theme, folded groups, auto-logout, the login token) stay in localStorage on purpose.
   ============================================================ */

const DB_NAME = 'tesnim', DB_VER = 1, KV = 'kv', MONTHS = 'months';
const OUTBOX = '_outbox';
// The old localStorage keys that move into the store on first start (then they are removed from localStorage).
const MIGRATE = ['tesnim_programs', 'tesnim_pages', 'tesnim_trash', 'tesnim_removed_seeds', 'tesnim_dayov', 'tesnim_first',
  'tesnim_me', 'tesnim_role', 'tesnim_curv', 'tesnim_dirty'];
const MIGRATE_DROP = MIGRATE.concat(['tesnim_log', 'tesnim_prev', 'tesnim_cv', 'tesnim_allprogs']);

const kv = new Map();        // key -> JSON text of the value (the text is what we compare and store)
let days = {};               // the tick history: days['2026-10-18'][activityId] = value
const dayTxt = new Map();    // ds -> JSON text of that day (to find what changed quickly)
let outbox = {};             // unsent ticks: outbox[ds][activityId] = value, or null = "remove this tick"
const listeners = {};
const st = { backend: 'memory', err: null, errAt: 0, persisted: false, opened: false };
const q = { kv: new Map(), m: new Set() };   // waiting to be written: kv keys (null = delete), months
let backend = null, flushing = null, flushTimer = null, retryTimer = null;
let frozen = false;   // after a logout wipe nothing may be written any more (a sync still in flight must not bring data back)

const isDay = ds => /^\d{4}-\d{2}-\d{2}$/.test(ds);
const monthOf = ds => isDay(ds) ? ds.slice(0, 7) : '_';
const txt = v => JSON.stringify(v === undefined ? null : v);
const parse = t => (t == null ? null : JSON.parse(t));
function parseOld(raw) { if (raw == null) return null; try { return JSON.parse(raw); } catch (e) { return raw; } }   // tesnim_first was saved as plain text

function emit(type, detail) { (listeners[type] || []).slice().forEach(fn => { try { fn(detail || {}); } catch (e) { console.error(e); } }); }
function fail(e) {
  const msg = (e && (e.name === 'QuotaExceededError' ? 'ማከማቻው ሞልቷል (QuotaExceededError)' : (e.message || e.name))) || String(e);
  const first = !st.err; st.err = msg; st.errAt = Date.now();
  emit('error', { message: msg, first });
}

/* ---------------- the three backends ---------------- */
function idbReq(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
function openIdb() {
  return new Promise((res, rej) => {
    if (!('indexedDB' in self) || !self.indexedDB) return rej(new Error('no IndexedDB'));
    let done = false; const t = setTimeout(() => { if (!done) { done = true; rej(new Error('IndexedDB timeout')); } }, 4000);   // some private windows never answer
    let r; try { r = indexedDB.open(DB_NAME, DB_VER); } catch (e) { clearTimeout(t); return rej(e); }
    r.onupgradeneeded = () => { const db = r.result; if (!db.objectStoreNames.contains(KV)) db.createObjectStore(KV); if (!db.objectStoreNames.contains(MONTHS)) db.createObjectStore(MONTHS); };
    r.onsuccess = () => { if (done) { try { r.result.close(); } catch (e) { /* late */ } return; } done = true; clearTimeout(t); res(r.result); };
    r.onerror = () => { if (!done) { done = true; clearTimeout(t); rej(r.error); } };
    r.onblocked = () => { /* another tab holds an old version: wait (the timeout decides) */ };
  });
}
function idbBackend(db) {
  db.onversionchange = () => { try { db.close(); } catch (e) { /* closing */ } };
  return {
    name: 'IndexedDB',
    async load() {
      const tx = db.transaction([KV, MONTHS], 'readonly'), a = tx.objectStore(KV), b = tx.objectStore(MONTHS);
      const [ak, av, bk, bv] = await Promise.all([idbReq(a.getAllKeys()), idbReq(a.getAll()), idbReq(b.getAllKeys()), idbReq(b.getAll())]);
      const out = { kv: {}, months: {} };
      ak.forEach((k, i) => { out.kv[k] = av[i]; }); bk.forEach((k, i) => { out.months[k] = bv[i]; });
      return out;
    },
    write(kvPut, monthPut) {   // kvPut: [[key, text|null]], monthPut: [[month, text|null]] - ONE transaction (all or nothing)
      return new Promise((res, rej) => {
        let tx; try { tx = db.transaction([KV, MONTHS], 'readwrite'); } catch (e) { return rej(e); }
        tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error || new Error('aborted'));
        try {
          const a = tx.objectStore(KV), b = tx.objectStore(MONTHS);
          kvPut.forEach(([k, v]) => { if (v == null) a.delete(k); else a.put(v, k); });
          monthPut.forEach(([m, v]) => { if (v == null) b.delete(m); else b.put(v, m); });
        } catch (e) { try { tx.abort(); } catch (x) { /* already over */ } rej(e); }
      });
    },
    clear() { return new Promise((res, rej) => { const tx = db.transaction([KV, MONTHS], 'readwrite'); tx.objectStore(KV).clear(); tx.objectStore(MONTHS).clear(); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); }); }
  };
}
function lsBackend() {   // fallback: the same records, as localStorage keys "tdb:k:<key>" and "tdb:m:<month>"
  const ls = self.localStorage, K = 'tdb:k:', M = 'tdb:m:';
  return {
    name: 'localStorage',
    async load() {
      const out = { kv: {}, months: {} };
      for (let i = 0; i < ls.length; i++) { const k = ls.key(i); if (k.startsWith(K)) out.kv[k.slice(K.length)] = ls.getItem(k); else if (k.startsWith(M)) out.months[k.slice(M.length)] = ls.getItem(k); }
      return out;
    },
    async write(kvPut, monthPut) {
      kvPut.forEach(([k, v]) => { if (v == null) ls.removeItem(K + k); else ls.setItem(K + k, v); });
      monthPut.forEach(([m, v]) => { if (v == null) ls.removeItem(M + m); else ls.setItem(M + m, v); });
    },
    async clear() { const ks = []; for (let i = 0; i < ls.length; i++) { const k = ls.key(i); if (k.startsWith(K) || k.startsWith(M)) ks.push(k); } ks.forEach(k => ls.removeItem(k)); }
  };
}
const memBackend = { name: 'memory', async load() { return { kv: {}, months: {} }; }, async write() { }, async clear() { } };

/* ---------------- writing in the background ---------------- */
function queueKv(k) { q.kv.set(k, true); schedule(); }
function queueMonth(m) { q.m.add(m); schedule(); }
function schedule() { if (!flushTimer) flushTimer = setTimeout(() => { flushTimer = null; flush(); }, 0); }
function flush() {
  if (!backend) return Promise.resolve();
  if (flushing) return flushing.then(() => (q.kv.size || q.m.size) ? flush() : undefined);
  if (!q.kv.size && !q.m.size) return Promise.resolve();
  const ks = [...q.kv.keys()], ms = [...q.m]; q.kv.clear(); q.m.clear();
  const kvPut = ks.map(k => [k, kv.has(k) ? kv.get(k) : null]);
  const monthPut = ms.map(m => [m, monthText(m)]);
  flushing = backend.write(kvPut, monthPut).then(() => {
    if (st.err) { st.err = null; emit('saved', {}); }   // a save worked again: the warning goes away
  }, e => {
    ks.forEach(k => q.kv.set(k, true)); ms.forEach(m => q.m.add(m));   // keep them, try again soon - nothing is dropped
    fail(e); clearTimeout(retryTimer); retryTimer = setTimeout(schedule, 15000);
  }).then(() => { flushing = null; });
  return flushing;
}
function monthText(m) {   // the days of one month as one JSON text (null when the month is empty)
  const o = {}; let any = false;
  Object.keys(days).forEach(ds => { if (monthOf(ds) === m) { o[ds] = days[ds]; any = true; } });
  return any ? JSON.stringify(o) : null;
}

/* ---------------- moving the old localStorage data in (runs once) ---------------- */
function oldDiff(now, prev) {   // exactly the old cloud.js logDiff: which ticks this phone changed since the server last had them
  const ch = {};
  Object.keys(now).concat(Object.keys(prev)).forEach(d => {
    const a = now[d] || {}, b = prev[d] || {};
    Object.keys(a).concat(Object.keys(b)).forEach(p => { if (JSON.stringify(a[p]) !== JSON.stringify(b[p])) (ch[d] = ch[d] || {})[p] = a[p] === undefined ? null : a[p]; });
  });
  return ch;
}
function migrateFromLocalStorage() {
  const ls = self.localStorage; let moved = false;
  try {
    MIGRATE.forEach(k => { const v = parseOld(ls.getItem(k)); if (v != null) { kv.set(k, txt(v)); queueKv(k); moved = true; } });
    const log = parseOld(ls.getItem('tesnim_log'));
    if (log && typeof log === 'object') { setDaysRaw(log); Object.keys(log).forEach(ds => q.m.add(monthOf(ds))); moved = true; }
    const prev = parseOld(ls.getItem('tesnim_prev'));
    if (prev && typeof prev === 'object' && log && typeof log === 'object') {   // unsent ticks from the old version are kept and sent later
      outbox = oldDiff(log, prev); kv.set(OUTBOX, txt(outbox)); queueKv(OUTBOX);
    }
    const cur = parseOld(ls.getItem('tesnim_curv'));
    if (cur && typeof cur === 'object') { kv.set('_sync', txt({ sv: cur.sv, mv: cur.mv, lv: cur.lv, hashes: {} })); queueKv('_sync'); }
    if (ls.getItem('tesnim_prev') != null) { kv.set('_synced', 'true'); queueKv('_synced'); }   // this phone had synced before
  } catch (e) { fail(e); }
  return moved;
}
function setDaysRaw(log) {
  days = {}; dayTxt.clear();
  Object.keys(log).forEach(ds => { if (log[ds] && typeof log[ds] === 'object') { days[ds] = JSON.parse(JSON.stringify(log[ds])); dayTxt.set(ds, JSON.stringify(days[ds])); } });
}

/* ---------------- the public API ---------------- */
export const store = {
  on(type, fn) { (listeners[type] = listeners[type] || []).push(fn); return () => { listeners[type] = (listeners[type] || []).filter(f => f !== fn); }; },
  emit,

  async open() {
    if (st.opened) return;
    try { backend = idbBackend(await openIdb()); }
    catch (e) {
      try { const t = '__tesnim_test'; self.localStorage.setItem(t, '1'); self.localStorage.removeItem(t); backend = lsBackend(); }
      catch (x) { backend = memBackend; }
    }
    st.backend = backend.name;
    let data = { kv: {}, months: {} };
    try { data = await backend.load(); } catch (e) { fail(e); }
    Object.keys(data.kv).forEach(k => kv.set(k, data.kv[k]));
    const all = {}; Object.keys(data.months).forEach(m => { try { Object.assign(all, JSON.parse(data.months[m]) || {}); } catch (e) { /* a broken month is skipped */ } });
    setDaysRaw(all);
    try { outbox = parse(kv.get(OUTBOX)) || {}; } catch (e) { outbox = {}; }
    if (!kv.has('_v')) {   // first start of Bundle C on this phone: bring the old data in
      migrateFromLocalStorage();
      kv.set('_v', '1'); queueKv('_v');
      await flush();
      if (!st.err && backend !== memBackend) { try { MIGRATE_DROP.forEach(k => self.localStorage.removeItem(k)); } catch (e) { /* nothing to free */ } }   // only after it is safely written
    }
    st.opened = true;
    try { if (navigator.storage && navigator.storage.persist) st.persisted = await navigator.storage.persist(); } catch (e) { /* not supported */ }
    const bye = () => { flush(); };
    addEventListener('pagehide', bye); document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') bye(); });
  },

  // ---- simple values (programs, pages, recycle bin, settings ...). get() returns a COPY you may change freely. ----
  get(k) { const t = kv.get(k); if (t == null) return null; try { return JSON.parse(t); } catch (e) { return null; } },
  has(k) { return kv.has(k); },
  set(k, v, from = 'local') {
    if (frozen) return false;
    if (v === undefined || v === null) return this.remove(k, from);
    const t = JSON.stringify(v); if (kv.get(k) === t) return false;   // nothing changed: no save, no event
    kv.set(k, t); queueKv(k); emit('change', { key: k, from }); return true;
  },
  remove(k, from = 'local') { if (frozen || !kv.has(k)) return false; kv.delete(k); queueKv(k); emit('change', { key: k, from }); return true; },

  // ---- the tick history ----
  getLog() { const o = {}; Object.keys(days).forEach(ds => { o[ds] = JSON.parse(dayTxt.get(ds)); }); return o; },
  setLog(log, from = 'local') {   // the app saves its whole history object; only the days that really changed are written
    if (frozen) return false;
    const ch = {}; let any = false;
    const keys = new Set(Object.keys(log || {}).concat(Object.keys(days)));
    keys.forEach(ds => {
      const a = log && log[ds], na = (a && typeof a === 'object') ? a : undefined;
      const ta = na === undefined ? undefined : JSON.stringify(na);
      if (ta === dayTxt.get(ds)) return;
      const b = days[ds] || {}, aa = na || {};
      Object.keys(aa).concat(Object.keys(b)).forEach(p => { if (JSON.stringify(aa[p]) !== JSON.stringify(b[p])) { (ch[ds] = ch[ds] || {})[p] = aa[p] === undefined ? null : aa[p]; any = true; } });
      if (na === undefined) { delete days[ds]; dayTxt.delete(ds); } else { days[ds] = JSON.parse(ta); dayTxt.set(ds, ta); }
      queueMonth(monthOf(ds));
    });
    if (!any) return false;
    if (from === 'local') { mergeOutbox(ch); }
    emit('log', { from, changes: ch }); return true;
  },
  // ---- unsent ticks ----
  pendingTicks() { return JSON.parse(JSON.stringify(outbox)); },
  pendingCount() { let n = 0; Object.keys(outbox).forEach(d => { n += Object.keys(outbox[d]).length; }); return n; },
  ackTicks(sent) {   // the server saved these: forget them (unless the person changed them again meanwhile)
    if (frozen) return;
    let ch = false;
    Object.keys(sent).forEach(d => Object.keys(sent[d]).forEach(p => {
      if (outbox[d] && Object.prototype.hasOwnProperty.call(outbox[d], p) && JSON.stringify(outbox[d][p]) === JSON.stringify(sent[d][p])) { delete outbox[d][p]; if (!Object.keys(outbox[d]).length) delete outbox[d]; ch = true; }
    }));
    if (ch) saveOutbox();
  },
  dropTicks(sent) {   // the server REFUSED (locked day): forget them; the true copy comes with the next sync
    if (frozen) return;
    let ch = false;
    Object.keys(sent).forEach(d => Object.keys(sent[d]).forEach(p => { if (outbox[d] && Object.prototype.hasOwnProperty.call(outbox[d], p)) { delete outbox[d][p]; if (!Object.keys(outbox[d]).length) delete outbox[d]; ch = true; } }));
    if (ch) saveOutbox();
  },
  // ---- server data arrives ----
  // months = { '2026-10': {days of that month}, ... } (only the months that changed)
  // all    = list of every month the server has (months not in it are removed here), or null = do not remove any
  applyServerMonths(months, all) {
    if (frozen) return false;
    const touched = new Set(Object.keys(months || {}));
    if (Array.isArray(all)) { const keep = new Set(all); Object.keys(days).forEach(ds => { const m = monthOf(ds); if (!keep.has(m)) touched.add(m); }); }
    if (!touched.size) return false;
    let changed = false;
    touched.forEach(m => {
      const srv = (months && months[m] && typeof months[m] === 'object') ? months[m] : {};
      Object.keys(days).forEach(ds => { if (monthOf(ds) === m && !Object.prototype.hasOwnProperty.call(srv, ds)) { delete days[ds]; dayTxt.delete(ds); changed = true; } });
      Object.keys(srv).forEach(ds => {
        if (!srv[ds] || typeof srv[ds] !== 'object') return;
        const t = JSON.stringify(srv[ds]); if (dayTxt.get(ds) !== t) { days[ds] = JSON.parse(t); dayTxt.set(ds, t); changed = true; }
      });
      queueMonth(m);
    });
    // my unsent ticks always win over what the server had (they are sent next)
    Object.keys(outbox).forEach(ds => {
      if (!touched.has(monthOf(ds))) return;
      const day = days[ds] ? days[ds] : {};
      Object.keys(outbox[ds]).forEach(p => { if (outbox[ds][p] === null) delete day[p]; else day[p] = JSON.parse(JSON.stringify(outbox[ds][p])); });
      if (Object.keys(day).length) { days[ds] = day; dayTxt.set(ds, JSON.stringify(day)); } else { delete days[ds]; dayTxt.delete(ds); }
      changed = true;
    });
    if (changed) emit('log', { from: 'remote' });
    return changed;
  },
  replaceLog(log) {   // the whole history from the server (the old app_get way)
    const months = {};
    Object.keys(log || {}).forEach(ds => { const m = monthOf(ds); (months[m] = months[m] || {})[ds] = log[ds]; });
    return this.applyServerMonths(months, Object.keys(months));
  },

  async wipe(opts) {   // opts.freeze = this is a logout: nothing may be written again until the page reloads
    if (opts && opts.freeze) frozen = true;
    kv.clear(); days = {}; dayTxt.clear(); outbox = {}; q.kv.clear(); q.m.clear(); if (flushing) { try { await flushing; } catch (e) { /* ignore */ } } try { await backend.clear(); } catch (e) { fail(e); } kv.set('_v', '1'); queueKv('_v'); await flush(); },
  flush,
  status() { return { backend: st.backend, err: st.err, errAt: st.errAt, persisted: st.persisted, waiting: q.kv.size + q.m.size, months: new Set(Object.keys(days).map(monthOf)).size, days: Object.keys(days).length, pending: this.pendingCount() }; },
  async estimate() { try { return navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null; } catch (e) { return null; } },
  monthList() { return [...new Set(Object.keys(days).map(monthOf))]; },
  monthOf
};
function mergeOutbox(ch) { Object.keys(ch).forEach(d => Object.keys(ch[d]).forEach(p => { (outbox[d] = outbox[d] || {})[p] = ch[d][p]; })); saveOutbox(); }
function saveOutbox() { kv.set(OUTBOX, JSON.stringify(outbox)); queueKv(OUTBOX); }
