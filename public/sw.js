// Offline-first service worker (Phase 2, improved in Bundle C).
// Rule: ask the internet FIRST for the page, so a new version always reaches the phone.
// If there is no internet (or it answers too slowly), use the copy saved on the phone.
// Only this app's own files and its Google Fonts are saved. Supabase (login, ticks, sync) is never touched here.
//
// Bundle C changes:
//  * Works inside a sub-folder too: every address is taken from this worker's own folder (its "scope"),
//    not from the domain root. (main.js registers it as './sw.js'.)
//  * Build files (assets/...) never change once published (their names contain a fingerprint), so they are
//    answered from the phone first - faster - and the network only when missing.
//  * Old build files no longer pile up: a file not used for 14 days is removed. The files the app uses are
//    "touched" every time it opens, so nothing in use is ever removed - even when offline for months.
//  * The app tells the worker which files it loaded ("warm"), so even the parts loaded later are saved for offline.
const CACHE = 'tesnim-v4';                          // a new name = everything from older versions is cleared once
const SLOW_MS = 3000;                               // network slower than this -> use the saved copy
const KEEP_MS = 14 * 24 * 3600 * 1000;              // remove saved build files not used for 14 days
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];
const BASE = new URL('./', self.registration.scope).href;   // e.g. https://site/ or https://site/sub/
const ASSETS = BASE + 'assets/';
const META = BASE + '__tesnim_meta.json';          // when each build file was last used (kept inside the cache)

self.addEventListener('install', e => { self.skipWaiting(); e.waitUntil(precache()); });
self.addEventListener('activate', e => e.waitUntil(
  caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim())
));

// ---- last-used notebook ----
let meta = null, metaTimer = null;
async function loadMeta(cache) {
  if (meta) return meta;
  try { const r = await cache.match(META); meta = r ? await r.json() : {}; } catch (err) { meta = {}; }
  return meta;
}
function saveMeta(cache) {
  clearTimeout(metaTimer);
  return new Promise(res => { metaTimer = setTimeout(() => { cache.put(META, new Response(JSON.stringify(meta || {}), { headers: { 'Content-Type': 'application/json' } })).catch(() => {}).then(res); }, 1500); });
}
async function touch(cache, url) { await loadMeta(cache); meta[url] = Date.now(); return saveMeta(cache); }
async function prune(cache) {   // at most twice a day
  await loadMeta(cache);
  const now = Date.now();
  if (meta.__pruned && now - meta.__pruned < 12 * 3600 * 1000) return;
  meta.__pruned = now;
  for (const req of await cache.keys()) {
    const u = req.url; if (u.indexOf(ASSETS) !== 0) continue;   // only fingerprinted build files are ever removed
    if (!meta[u]) meta[u] = now;                                   // first time seen: start counting today
    else if (now - meta[u] > KEEP_MS) { await cache.delete(req); delete meta[u]; }
  }
  return saveMeta(cache);
}

// ---- first install: save the page and everything it loads, so the next start works with no internet ----
function refs(text, from) {   // addresses inside an HTML / CSS / JS file
  const out = new Set();
  const add = s => { if (!s || s[0] === '#' || /^(data|blob|javascript|mailto):/i.test(s)) return; try { const u = new URL(s, from); u.hash = ''; out.add(u.href); } catch (err) { /* odd text */ } };
  for (const m of text.matchAll(/(?:src|href)="([^"#]+)"/g)) add(m[1]);
  for (const m of text.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) add(m[1]);
  for (const m of text.matchAll(/["'`](\.\/[\w.-]+\.(?:js|css|woff2?))["'`]/g)) add(m[1]);                   // build chunks next to this file
  for (const m of text.matchAll(/["'`](assets\/[\w.-]+\.(?:js|css|woff2?))["'`]/g)) { try { out.add(new URL(m[1], BASE).href); } catch (err) { /* ignore */ } }
  return out;
}
async function saveOne(cache, u, seen) {
  if (seen.has(u)) return; seen.add(u);
  try {
    const host = new URL(u).hostname;
    if (host !== self.location.hostname && !FONT_HOSTS.includes(host)) return;
    if (host === self.location.hostname && u.indexOf(BASE) !== 0) return;
    const r = await fetch(u); if (!r.ok) return;
    await cache.put(u, r.clone());
    if (host === 'fonts.googleapis.com') {             // also keep the Latin font files
      const css = await r.text();
      for (const f of css.matchAll(/\/\* latin \*\/\s*@font-face\s*\{[^}]*?url\((https:[^)]+)\)/g)) {
        try { const fr = await fetch(f[1]); if (fr.ok) await cache.put(f[1], fr); } catch (err) { /* fonts are optional */ }
      }
      return;
    }
    if (/\.(css|js)(\?|$)/.test(u)) { const t = await r.text(); await Promise.all([...refs(t, u)].map(x => saveOne(cache, x, seen))); }
  } catch (err) { /* one missing file must not break the install */ }
}
async function precache() {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(BASE, { cache: 'reload' });
    if (!res.ok) return;
    const html = await res.clone().text();
    await cache.put(BASE, res);
    const seen = new Set([BASE]);
    await Promise.all([...refs(html, BASE)].map(u => saveOne(cache, u, seen)));
  } catch (err) { /* installing while offline: runtime saving below still works */ }
}

// ---- the app says which files it loaded: make sure all of them are saved ----
self.addEventListener('message', e => {
  const d = e.data || {};
  if (d.type !== 'warm' || !Array.isArray(d.urls)) return;
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    for (const u of d.urls.slice(0, 200)) {
      if (typeof u !== 'string' || u.indexOf(BASE) !== 0 || u === META) continue;
      try {
        if (!(await cache.match(u))) { const r = await fetch(u); if (r.ok) await cache.put(u, r); }
        if (u.indexOf(ASSETS) === 0) { await loadMeta(cache); meta[u] = Date.now(); }
      } catch (err) { /* offline now: next time */ }
    }
    await saveMeta(cache);
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || req.headers.has('range')) return;
  const url = new URL(req.url);
  if (FONT_HOSTS.includes(url.hostname)) { e.respondWith(fonts(url)); return; }
  if (url.origin !== self.location.origin || url.href.indexOf(BASE) !== 0) return;   // Supabase, or outside the app's folder: leave alone
  if (url.href === META) return;
  if (url.href.indexOf(ASSETS) === 0) { e.respondWith(assetFirst(req, e)); return; }
  e.respondWith(networkFirst(req, e));
});

async function assetFirst(req, e) {   // fingerprinted build file: the saved copy is always correct
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  const t = touch(cache, req.url).catch(() => {}); try { e.waitUntil(t); } catch (err) { /* already answered */ }
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) await cache.put(req, res.clone());
  return res;
}

async function networkFirst(req, e) {
  const cache = await caches.open(CACHE);
  const nav = req.mode === 'navigate';
  const key = nav ? BASE : req;                      // every page address opens the same app
  const cached = await cache.match(key);
  const net = fetch(req).then(res => {
    if (res.ok) { cache.put(key, res.clone()); if (nav) { const p = prune(cache).catch(() => {}); try { e.waitUntil(p); } catch (err) { /* the page was already answered */ } } return res; }
    return cached || res;                            // server error: prefer the saved copy
  });
  if (!cached) return net;                           // nothing saved yet: wait for the internet
  const slow = new Promise(r => setTimeout(() => r(cached), SLOW_MS));
  return Promise.race([net.catch(() => cached), slow]);
}

async function fonts(url) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(url.href);
  const refresh = () => fetch(url.href).then(r => { if (r.ok) cache.put(url.href, r.clone()); return r; });
  if (hit) { if (url.hostname === 'fonts.googleapis.com') refresh().catch(() => {}); return hit; }
  return refresh();
}
