// Offline-first service worker (Phase 2).
// Rule: ask the internet FIRST, so a new version always reaches the phone.
// If there is no internet (or it answers too slowly), use the copy saved on
// the phone. Only this app's own files and its Google Fonts are saved.
// Supabase (login, ticks, sync) is never touched here - cloud.js handles it.
const CACHE = 'tesnim-v2';
const SLOW_MS = 3000;                       // network slower than this -> use the saved copy
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', e => { self.skipWaiting(); e.waitUntil(precache()); });
self.addEventListener('activate', e => e.waitUntil(
  caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim())
));

// On first install, save the page and everything it loads, so the very
// next start works with no internet (files fetched before the worker
// existed would otherwise be missing).
async function precache() {
  const cache = await caches.open(CACHE);
  const base = self.location.origin + '/';
  try {
    const res = await fetch(base, { cache: 'reload' });
    if (!res.ok) return;
    const html = await res.clone().text();
    await cache.put('/', res);
    const urls = new Set();
    for (const m of html.matchAll(/(?:src|href)="([^"#]+)"/g)) {
      try { urls.add(new URL(m[1], base).href); } catch (err) { /* ignore odd links */ }
    }
    await Promise.all([...urls].map(async u => {
      try {
        const host = new URL(u).hostname;
        if (host !== self.location.hostname && !FONT_HOSTS.includes(host)) return;
        const r = await fetch(u);
        if (!r.ok) return;
        await cache.put(u, r.clone());
        if (host === 'fonts.googleapis.com') {          // also keep the Latin font files
          const css = await r.text();
          for (const f of css.matchAll(/\/\* latin \*\/\s*@font-face\s*\{[^}]*?url\((https:[^)]+)\)/g)) {
            try { const fr = await fetch(f[1]); if (fr.ok) await cache.put(f[1], fr); } catch (err) { /* fonts are optional */ }
          }
        }
      } catch (err) { /* one missing file must not break the install */ }
    }));
  } catch (err) { /* installing while offline: runtime saving below still works */ }
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || req.headers.has('range')) return;
  const url = new URL(req.url);
  if (FONT_HOSTS.includes(url.hostname)) { e.respondWith(fonts(url)); return; }
  if (url.origin !== self.location.origin) return;      // Supabase etc.: leave alone
  e.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  const key = req.mode === 'navigate' ? '/' : req;      // every page address opens the same app
  const cached = await cache.match(key);
  const net = fetch(req).then(res => {
    if (res.ok) { cache.put(key, res.clone()); return res; }
    return cached || res;                                // server error: prefer the saved copy
  });
  if (!cached) return net;                               // nothing saved yet: wait for the internet
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
