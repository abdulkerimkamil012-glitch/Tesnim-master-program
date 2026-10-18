/* ============================================================
   BOOT (Bundle C) — the first file the page runs (index.html loads it).
   1. open the store (IndexedDB) and bring old localStorage data in, once;
   2. if the app is connected to Supabase: log in / fetch only what changed (src/sync.js);
   3. only THEN start the app (src/main.js), so it always reads complete, up-to-date data — no reloads needed.
   ============================================================ */
import './style.css';   // loaded with the first file, so the screen is styled before the app starts
import { store } from './store.js';
import { CLOUD, startCloud, afterMain } from './sync.js';

function fatal(e) {   // never a blank screen: say what happened and offer a retry
  console.error(e);
  const d = document.createElement('div');
  d.style.cssText = 'position:fixed;inset:0;z-index:99;display:flex;align-items:center;justify-content:center;padding:24px;background:#0c2a20;color:#eaf3e6;font-family:inherit;text-align:center';
  d.innerHTML = '<div><div style="font-size:40px">⚠️</div><p style="font-size:16px;line-height:1.6">መተግበሪያው መክፈት አልቻለም።<br>እባክዎ እንደገና ይሞክሩ።</p><button type="button" style="padding:12px 20px;border:0;border-radius:14px;background:#ffba00;color:#3b2a00;font-weight:700;font-size:15px">እንደገና ሞክር</button><p style="opacity:.6;font-size:12px;margin-top:14px;word-break:break-word"></p></div>';
  d.querySelector('p:last-child').textContent = String((e && e.message) || e);
  d.querySelector('button').onclick = () => location.reload();
  document.body.appendChild(d);
}

function warmCache() {   // tell the offline worker which files this version uses, so all of them are saved for offline
  try {
    const sw = navigator.serviceWorker; if (!sw || !sw.controller) return;
    const urls = performance.getEntriesByType('resource').map(r => r.name).filter(u => u.indexOf(location.origin) === 0);
    sw.controller.postMessage({ type: 'warm', urls });
  } catch (e) { /* optional */ }
}

(async () => {
  await store.open();
  if (CLOUD && !(await startCloud())) return;   // a login or message screen is showing
  await import('./main.js');
  if (CLOUD) afterMain();
  if ('serviceWorker' in navigator) {
    if (navigator.serviceWorker.controller) setTimeout(warmCache, 3000);
    navigator.serviceWorker.addEventListener('controllerchange', () => setTimeout(warmCache, 1000));
  }
})().catch(fatal);
