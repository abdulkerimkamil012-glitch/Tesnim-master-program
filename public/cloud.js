/* Tesnim cloud add-on: login + automatic sync + roles + offline-safe sync (Phase 2) + grouped assign list (Phase 3A part 1) + safe first login (Phase 3A part 2). Edit ONLY the two lines below. */
(function () {
  'use strict';
  var SB_URL = 'https://xdjfiiuqiecntyuarvkq.supabase.co', SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhkamZpaXVxaWVjbnR5dWFydmtxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA3NDM2NDcsImV4cCI6MjEwNjMxOTY0N30.kyiKWvh8OvQQG7vVtLHddc-Sksk_2U3ZVI42o3V51as';
  var SH = ['tesnim_programs', 'tesnim_pages', 'tesnim_trash', 'tesnim_removed_seeds'];
  var MI = ['tesnim_dayov', 'tesnim_first'];
  var PERMS = [['add', '＋ መጨመር'], ['edit', '✎ አርትዕ'], ['del', '🗑 መሰረዝ'], ['trash', '♻ ቆሻሻ መጣያ'], ['dash', '◔ አጠቃላይ ውጤት'], ['rep', '📋 ሪፖርቶች'], ['set', '⚙ ቅንብሮች'], ['stat', '📊 ስታትስቲክስ'], ['cal', '📅 ቀን መቁጠሪያ'], ['tick', '✓ ምልክት ማድረግ'], ['past', '🕘 ያለፉ ቀናትን ማስተካከል']];
  var ROLES = [['member', '👤 አባል (ምልክት ብቻ)', 'tick,dash,rep,stat,cal'], ['viewer', '👁 ተመልካች (ማየት ብቻ)', 'dash,rep,stat,cal'], ['history', '🕘 ታሪክ አራሚ', 'tick,past,dash,rep,stat,cal'], ['editor', '✎ አርታኢ', 'add,edit,del,trash,dash,rep,set,stat,cal,tick'], ['custom', '⚙ ብጁ', '']];
  var ls = window.localStorage, rawSet = Storage.prototype.setItem, rawRem = Storage.prototype.removeItem;
  var tok = ls.getItem('tesnim_token'), me = null, cur = { sv: 0, mv: 0, lv: 0 }, ready = false, timer = null, prev = {}, net = true, polling = false, gen = 0, dirty = { s: 0, m: 0 };
  window.TESNIM_ALL_PROGRAMS = null; ls.removeItem('tesnim_allprogs'); // Phase 1: a phone never holds other people's activities
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>\"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  try { prev = JSON.parse(ls.getItem('tesnim_prev') || 'null') || {}; } catch (e) { prev = {}; }   // Phase 2: the log as the server last had it (survives restarts, so offline ticks are never forgotten)
  try { dirty = JSON.parse(ls.getItem('tesnim_dirty') || 'null') || dirty; } catch (e) { }

  function api(fn, args, ms) {   // ms = give up after this long (a stuck connection must never freeze the app)
    var ctl = window.AbortController ? new AbortController() : null, t = ctl ? setTimeout(function () { ctl.abort(); }, ms || 15000) : null;
    return fetch(SB_URL + '/rest/v1/rpc/' + fn, { method: 'POST', headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(args || {}), signal: ctl ? ctl.signal : undefined })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.message || 'error'); return j; }); })
      .then(function (j) { clearTimeout(t); return j; }, function (e) { clearTimeout(t); throw e; });
  }
  function permOn(k) { return !!me.is_admin || (k === 'tick' ? me.perms.tick !== false : !!me.perms[k]); }
  function storeRole() {   // read by src/main.js at page load: who am I, may I tick, may I edit past days
    rawSet.call(ls, 'tesnim_role', JSON.stringify({ r: !me.is_admin && me.programs !== 'all', past: permOn('past'), tick: permOn('tick') }));
  }
  function sig() { return 'v2:' + cur.sv + ':' + cur.mv + ':' + cur.lv + ':' + JSON.stringify([me.programs, me.perms, me.is_admin]); }
  function canShared() { return me.is_admin || (me.programs === 'all' && (me.perms.add || me.perms.edit || me.perms.del)); }

  // ---------- Phase 2: things that survive closing the app (needed for offline use) ----------
  function saveCv() { rawSet.call(ls, 'tesnim_cv', sig()); rawSet.call(ls, 'tesnim_curv', JSON.stringify(cur)); }
  function setPrev(v) { prev = v; rawSet.call(ls, 'tesnim_prev', JSON.stringify(v)); }
  function setDirty(s, m) { dirty = { s: s, m: m }; rawSet.call(ls, 'tesnim_dirty', JSON.stringify(dirty)); }
  function saveMe() {   // a safe copy of who I am (no password hash), so the app can open with no internet
    try { rawSet.call(ls, 'tesnim_me', JSON.stringify({ id: me.id, username: me.username, is_admin: !!me.is_admin, perms: me.perms || {}, programs: me.programs })); } catch (e) { }
  }
  function wipeLocal(keepToken) {
    SH.concat(MI, ['tesnim_cv', 'tesnim_curv', 'tesnim_log', 'tesnim_prev', 'tesnim_dirty', 'tesnim_me', 'tesnim_allprogs', 'tesnim_role'], keepToken ? [] : ['tesnim_token']).forEach(function (k) { rawRem.call(ls, k); });
  }

  // Every app save to localStorage is pushed to the cloud a moment later
  Storage.prototype.setItem = function (k, v) {
    rawSet.call(this, k, v);
    if (ready && this === ls) {
      var s = SH.indexOf(k) > -1, m = MI.indexOf(k) > -1;
      if (s || m || k === 'tesnim_log') {
        gen++; if (s) setDirty(1, dirty.m); if (m) setDirty(dirty.s, 1);
        clearTimeout(timer); timer = setTimeout(push, 1200); status();
      }
    }
  };
  function pick(keys) { var o = {}; keys.forEach(function (k) { var v = ls.getItem(k); if (v != null) o[k] = v; }); return o; }
  function readLog() { try { return JSON.parse(ls.getItem('tesnim_log') || '{}') || {}; } catch (e) { return {}; } }
  function logDiff() {   // only the ticks THIS phone changed since the server last had them (so nobody's ticks get overwritten)
    var now = readLog(), ch = {}, any = false;
    Object.keys(now).concat(Object.keys(prev)).forEach(function (d) {
      var a = now[d] || {}, b = prev[d] || {};
      Object.keys(a).concat(Object.keys(b)).forEach(function (p) {
        if (JSON.stringify(a[p]) !== JSON.stringify(b[p])) { (ch[d] = ch[d] || {})[p] = a[p] === undefined ? null : a[p]; any = true; }
      });
    });
    return any ? { ch: ch, now: now } : null;
  }
  function pend() { return !!(logDiff() || dirty.m || (canShared() && dirty.s)); }   // anything not yet sent to the cloud?
  function pendCount() { var df = logDiff(), n = 0; if (df) Object.keys(df.ch).forEach(function (d) { n += Object.keys(df.ch[d]).length; }); return n; }
  function status() {   // the small "offline / waiting to send" label next to your name
    var s = $('cl-st'); if (!s) return;
    var n = pendCount(), off = !net || navigator.onLine === false;
    s.textContent = off ? '📴 ከመስመር ውጭ' + (n ? ' · ⏳' + n : '') : (n ? '⏳ ' + n : '');
    s.style.display = (off || n) ? '' : 'none';
  }
  function overlay(base, ch) {   // put my unsent ticks on top of the server's log (null = I un-ticked it)
    var o = JSON.parse(JSON.stringify(base || {}));
    Object.keys(ch).forEach(function (d) {
      Object.keys(ch[d]).forEach(function (p) {
        if (ch[d][p] === null) { if (o[d]) { delete o[d][p]; if (!Object.keys(o[d]).length) delete o[d]; } }
        else { (o[d] = o[d] || {})[p] = ch[d][p]; }
      });
    });
    return o;
  }
  function kick() { if (pend()) { clearTimeout(timer); timer = setTimeout(push, 500); } }

  function push() {
    timer = null; if (!me) return;
    var sh = canShared() && !!dirty.s, mi = !!dirty.m, df = logDiff(), g = gen, jobs = [];
    if (sh || mi) jobs.push(api('app_put', { p_tok: tok, p_shared: sh ? pick(SH) : null, p_mine: pick(MI) }).then(function (r) {
      cur.mv = r.mv; if (sh) cur.sv = r.sv; if (g === gen) setDirty(sh ? 0 : dirty.s, 0); saveCv();
    }));
    if (df) jobs.push(api('app_put_log', { p_tok: tok, p_changes: df.ch }).then(function (r) {
      setPrev(df.now); if (r.lv === cur.lv + 1) cur.lv = r.lv; saveCv();
      if (r.rej && r.rej.length) refused();
    }));
    if (!jobs.length) { status(); return; }
    Promise.all(jobs).then(function () { net = true; status(); }).catch(function (e) {
      if (e && /auth/.test(e.message)) { ls.removeItem('tesnim_token'); return location.reload(); }
      net = false; status(); clearTimeout(timer); timer = setTimeout(push, 15000);   // offline: keep the ticks, try again soon
    });
  }
  // The server said no to some ticks (locked day / no permission): show why, then reload the true server copy.
  function refused() {
    var n = document.createElement('div'); n.id = 'cl-note'; n.textContent = '⛔ ይህ ቀን ተቆልፏል — ለውጡ አልተቀመጠም'; document.body.appendChild(n);
    api('app_get', { p_tok: tok }).then(function (x) { me = x.user; cur = { sv: x.sv, mv: x.mv, lv: x.lv }; apply(x, true); setTimeout(function () { location.reload(); }, 1800); }).catch(function () { });
  }
  function apply(d, discard) {   // discard = true only when the server refused my ticks
    var pendingTicks = discard ? null : logDiff();   // must be read BEFORE the log is replaced
    var keepS = !discard && canShared() && !!dirty.s, keepM = !discard && !!dirty.m;   // my unsent edits win over the cloud copy
    SH.forEach(function (k) {
      if (keepS) return;
      var v = d.shared[k];
      if (k === 'tesnim_programs' && v != null && !me.is_admin && me.programs !== 'all') {
        var ids = me.programs || [];
        try { v = JSON.stringify(JSON.parse(v).filter(function (p) { return ids.indexOf(p.id) > -1; })); } catch (e) { v = '[]'; }
      }
      if (v == null) rawRem.call(ls, k); else rawSet.call(ls, k, v);
    });
    MI.forEach(function (k) { if (keepM) return; var v = d.mine[k]; if (v == null) rawRem.call(ls, k); else rawSet.call(ls, k, v); });
    var log = d.log || {};
    rawSet.call(ls, 'tesnim_log', JSON.stringify(pendingTicks ? overlay(log, pendingTicks.ch) : log)); setPrev(log);
    storeRole(); saveMe();
    saveCv();
  }
  function safe() {
    var a = document.activeElement;
    return !timer && !pend() && !(a && /INPUT|TEXTAREA/.test(a.tagName)) && !document.querySelector('.overlay.open,#detailView.open');
  }
  function classes() {
    var b = document.body; b.classList.add('cloud', 'pb');
    if (me.is_admin) b.classList.add('is-admin');
    else PERMS.forEach(function (p) { if (!permOn(p[0])) b.classList.add('no-' + p[0]); });
  }
  function logout() {   // never throw away ticks that were not sent yet
    var df = logDiff();
    var go = function () { api('app_put', { p_tok: tok, p_shared: null, p_mine: pick(MI) }).catch(function () { }).then(function () { wipeLocal(false); location.reload(); }); };
    if (!df) return go();
    api('app_put_log', { p_tok: tok, p_changes: df.ch }).then(go).catch(function () {
      if (confirm('⚠ ገና ያልተላኩ ለውጦች አሉ። አሁን ከወጡ ይጠፋሉ። ኢንተርኔት ካለዎት ቆይተው ይውጡ። ለማንኛውም ይውጡ?')) go();
    });
  }

  // ---------- Phase 2: checking the cloud (slowly, and only while the app is on screen) ----------
  function pollNow() {
    if (!ready || !tok) return;
    if (pend()) { kick(); return; }   // send my own changes first, then look for new ones
    api('app_get', { p_tok: tok }).then(function (n) {
      net = true; me = n.user; saveMe(); var old = cur; cur = { sv: n.sv, mv: n.mv, lv: n.lv };
      if (ls.getItem('tesnim_cv') !== sig()) { if (safe()) { apply(n); location.reload(); } else cur = old; }
      status();
    }).catch(function (e) { if (/auth/.test(e.message)) { ls.removeItem('tesnim_token'); location.reload(); } else { net = false; status(); } });
  }
  function startPolling() {
    if (polling) return; polling = true;
    setInterval(function () { if (document.visibilityState === 'visible') pollNow(); }, 60000);   // was every 8 seconds
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') { kick(); pollNow(); } });
  }
  window.addEventListener('online', function () { net = true; status(); if (ready) { kick(); pollNow(); } });
  window.addEventListener('offline', function () { net = false; status(); });

  function start(d) {
    var old = null; try { old = JSON.parse(ls.getItem('tesnim_me') || 'null'); } catch (e) { }
    if (old && d.user && ((old.id && d.user.id && old.id !== d.user.id) || (!(old.id && d.user.id) && old.username !== d.user.username))) { wipeLocal(true); prev = {}; dirty = { s: 0, m: 0 }; }   // someone else logged in on this phone
    me = d.user; cur = { sv: d.sv, mv: d.mv, lv: d.lv };
    if (ls.getItem('tesnim_prev') == null) setPrev({});   // Phase 3A: a phone with no saved copy yet knows nothing about the server, so it must never ask the server to delete anything
    saveMe(); storeRole(); classes(); chip();
    if (me.is_admin && d.sv === 0) { setPrev({}); ready = true; push(); saveCv(); return unveil(); }
    if (ls.getItem('tesnim_cv') !== sig()) { apply(d); return location.reload(); }
    ready = true; unveil(); status(); kick(); startPolling();
  }
  function offlineStart() {   // no internet at app start: open from this phone's saved copy
    unveil();
    var cm = null; try { cm = JSON.parse(ls.getItem('tesnim_me') || 'null'); } catch (e) { }
    if (!cm || ls.getItem('tesnim_prev') == null) { ready = false; return; }   // never synced on this phone yet: nothing to open
    me = cm; net = false;
    try { cur = JSON.parse(ls.getItem('tesnim_curv') || 'null') || cur; } catch (e) { }
    classes(); chip(); ready = true; status(); startPolling(); kick();
    setTimeout(pollNow, 8000);   // if the network was only slow, catch up shortly
  }

  // ---------- UI ----------
  var css = document.createElement('style');
  css.textContent = '.pb{padding-bottom:64px}' +
    '#cl-veil,#cl-login,#cl-admin{position:fixed;inset:0;z-index:60;background:#0c2a20;color:#eaf3e6;font-family:inherit;overflow-y:auto}' +
    '#cl-login{display:flex;align-items:center;justify-content:center;padding:24px}#cl-login form{width:100%;max-width:340px;display:flex;flex-direction:column;gap:12px}' +
    '#cl-login h2,#cl-admin h2{margin:0 0 6px;font-size:22px}.cl-in{padding:14px;border-radius:14px;border:1px solid #ffffff33;background:#ffffff14;color:#fff;font-size:16px;width:100%;box-sizing:border-box}' +
    '.cl-btn{padding:13px 16px;border-radius:14px;border:0;background:#ffba00;color:#3b2a00;font-weight:700;font-size:15px}.cl-btn.g{background:#ffffff22;color:#fff}.cl-btn.r{background:#c0392b;color:#fff}' +
    '#cl-chip{position:fixed;bottom:10px;left:50%;transform:translateX(-50%);z-index:30;display:flex;gap:8px;align-items:center;padding:6px 8px 6px 14px;border-radius:99px;background:#0c2a20ee;color:#eaf3e6;font-size:13px;box-shadow:0 2px 12px #0006}#cl-chip button{border:0;border-radius:99px;padding:7px 12px;background:#ffffff22;color:#fff;font-size:13px}' +
    '#cl-admin .in{max-width:560px;margin:0 auto;padding:20px 16px 60px}.cl-row{display:flex;gap:8px;align-items:center;justify-content:space-between;padding:12px;margin:8px 0;border-radius:14px;background:#ffffff14}' +
    '.cl-chk{display:flex;gap:10px;align-items:center;padding:7px 0;font-size:15px}.cl-chk input{width:20px;height:20px}#cl-err{color:#ff9d8f;min-height:18px;font-size:14px}.cl-box{max-height:55vh;overflow-y:auto;padding:6px;border-radius:12px;background:#ffffff0d}' +
    'body:not(.is-admin) #importBtn,body:not(.is-admin) #exportBtn{display:none}.no-add #addBtn,.no-add #addPageBtn{display:none}.no-edit .edit,.no-edit [data-pgedit],.no-edit .dtab[data-tab=edit]{display:none}' +
    '.no-del .del,.no-del [data-pgdel],.no-del #etDelete,.no-del .trash-purge,.no-del #trashClearAll{display:none}.no-trash #trashBtn{display:none}.no-dash .ringcard{display:none}.no-rep #dayRepBtn,.no-rep #weekBtn{display:none}' +
    '.no-tick .tick,.no-tick .subtick,.no-tick .wd-cell{pointer-events:none;opacity:.45}#cl-note{position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:70;padding:10px 16px;border-radius:99px;background:#c0392b;color:#fff;font-size:14px;max-width:90vw;text-align:center}' +
    '.no-set #remindBtn{display:none}.no-set.no-trash #settingsBtn,.no-set.no-trash #settingsPanel{display:none}.no-stat [data-openstat],.no-stat .dtab[data-tab=stat]{display:none}.no-cal [data-opencal],.no-cal .dtab[data-tab=cal]{display:none}.no-cal.no-stat.no-edit #detailView{display:none!important}';
  css.textContent += `#cl-login,#cl-admin{background:radial-gradient(circle at 18% 12%,#2f8f6a 0,transparent 45%),radial-gradient(circle at 88% 85%,#ffba0055 0,transparent 42%),linear-gradient(160deg,#0c3b2e,#071f18)}
#cl-login form,#cl-admin .in{background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.22);border-radius:28px;box-shadow:0 20px 60px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.25);-webkit-backdrop-filter:blur(22px) saturate(160%);backdrop-filter:blur(22px) saturate(160%)}
#cl-login form{padding:30px 24px}#cl-admin .in{margin:18px auto;padding:22px 18px}
.lg-logo{width:68px;height:68px;margin:0 auto;border-radius:22px;display:grid;place-items:center;font-size:34px;background:linear-gradient(145deg,#ffd760,#e79a00);box-shadow:0 8px 24px #ffba0066}
#cl-login h2{text-align:center;margin:8px 0 0}#cl-login p{margin:0 0 6px;text-align:center;opacity:.7;font-size:14px}
.cl-in{background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.25)}.cl-in:focus{outline:2px solid #ffba00;border-color:transparent}
.cl-btn{background:linear-gradient(135deg,#ffd760,#ffa800);box-shadow:0 6px 18px #ffba0055}.cl-btn.g{background:rgba(255,255,255,.16);box-shadow:none}.cl-btn.r{background:#c0392b;box-shadow:none}
.cl-row{background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.18)}
.cl-chk input{-webkit-appearance:none;appearance:none;width:42px;height:24px;border-radius:99px;background:#ffffff33;position:relative;flex:none;transition:.2s}
.cl-chk input:before{content:'';position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#fff;transition:.2s}.cl-chk input:checked{background:#2fbf84}.cl-chk input:checked:before{left:21px}
.cl-chk input:indeterminate{background:#e79a00}.cl-chk input:indeterminate:before{left:12px}.cl-chk input:disabled{opacity:.4}
.cl-grp{margin:0 0 8px;border-radius:12px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.05);overflow:hidden}
.cl-gh{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:2px 12px;background:rgba(255,255,255,.1)}
.cl-gt{flex:1;min-width:0;display:flex;align-items:center;gap:8px;padding:10px 0;border:0;background:none;color:inherit;font:inherit;font-size:15px;text-align:start;cursor:pointer}
.cl-gt b{overflow-wrap:anywhere}.cl-gc{opacity:.7;font-size:12px;white-space:nowrap}.cl-car{opacity:.8;width:14px;flex:none}
.cl-gb{padding:0 12px}.cl-gb .cl-chk{align-items:flex-start}.cl-gb .cl-chk>span{line-height:1.5}
.cl-wd{display:inline-block;padding:1px 9px;margin-inline-start:4px;border-radius:99px;background:rgba(255,255,255,.18);font-size:11px;white-space:nowrap}
#cl-chip{padding:7px;gap:10px;background:rgba(12,42,32,.55);border:1px solid rgba(255,255,255,.25);-webkit-backdrop-filter:blur(18px) saturate(160%);backdrop-filter:blur(18px) saturate(160%);box-shadow:0 10px 30px rgba(0,0,0,.35),inset 0 1px 0 rgba(255,255,255,.25)}
#cl-chip .av{width:34px;height:34px;border-radius:50%;display:grid;place-items:center;font-weight:700;background:linear-gradient(145deg,#ffd760,#e79a00);color:#3b2a00}
#cl-st{font-size:12px;opacity:.9;white-space:nowrap}#cl-chip .nm{display:flex;flex-direction:column;line-height:1.15;font-weight:600}#cl-chip .nm small{font-size:10px;opacity:.7;font-weight:400}`;
  document.head.appendChild(css);
  function el(id, html) { var d = document.createElement('div'); d.id = id; d.innerHTML = html || ''; document.body.appendChild(d); return d; }
  function unveil() { var v = $('cl-veil'); if (v) v.remove(); }
  function chip() {
    el('cl-chip', '<span class="av">' + esc(me.username.charAt(0).toUpperCase()) + '</span><span class="nm">' + esc(me.username) + '<small>' + (me.is_admin ? 'አስተዳዳሪ' : 'ተጠቃሚ') + '</small></span><span id="cl-st" style="display:none"></span>' + (me.is_admin ? '<button id="cl-adm">👑 ተጠቃሚዎች</button>' : '') + '<button id="cl-out">ውጣ</button>');
    $('cl-out').onclick = logout; if (me.is_admin) $('cl-adm').onclick = admin;
  }
  function login() {
    unveil();
    el('cl-login', '<form id="cl-f"><div class="lg-logo">🌿</div><h2>እንኳን ደህና መጡ</h2><p>ለመቀጠል ይግቡ</p><input class="cl-in" id="cl-u" placeholder="የተጠቃሚ ስም" autocapitalize="none" autocomplete="username"><input class="cl-in" id="cl-p" type="password" placeholder="የይለፍ ቃል" autocomplete="current-password"><div id="cl-err"></div><button class="cl-btn" type="submit">ግባ</button></form>');
    $('cl-f').onsubmit = function (e) {
      e.preventDefault(); $('cl-err').textContent = '...';
      api('app_login', { p_user: $('cl-u').value.trim(), p_pass: $('cl-p').value }).then(function (r) { rawSet.call(ls, 'tesnim_token', r.token); location.reload(); })
        .catch(function (x) { $('cl-err').textContent = /bad/.test(x.message) ? 'ስሙ ወይም የይለፍ ቃሉ ትክክል አይደለም' : 'ግንኙነት አልተሳካም — ቅንብሩን ያረጋግጡ'; });
    };
  }

  // ---------- Phase 3A part 1: the assign list, grouped by category ----------
  var DAYN = ['ሰኞ', 'ማክሰኞ', 'ረቡዕ', 'ሐሙስ', 'አርብ', 'ቅዳሜ', 'እሁድ'];   // 1=Mon ... 7=Sun (same numbers main.js uses)
  function dayNums(p) { return Array.isArray(p.schedule) ? p.schedule.map(Number).filter(function (n) { return n >= 1 && n <= 7; }).sort(function (a, b) { return a - b; }) : []; }
  function whenLabel(p) { var d = dayNums(p); return (!d.length || d.length >= 7) ? 'ዕለታዊ' : d.map(function (n) { return DAYN[n - 1]; }).join(' · '); }
  function groupProgs(progs) {   // [{name, none, items:[{p}]}] - groups in order of first appearance, "no category" last; inside a group: Mon..Sun, then daily
    var map = {}, order = [];
    progs.forEach(function (p, i) {
      var c = String(p.category || '').trim(), k = c ? 'c:' + c : 'none', d = dayNums(p);
      if (!map[k]) { map[k] = { name: c || 'ያለ ምድብ', none: !c, items: [] }; order.push(k); }
      map[k].items.push({ p: p, i: i, key: d.length && d.length < 7 ? d[0] : 8 });
    });
    var gs = order.map(function (k) { return map[k]; });
    gs.forEach(function (g) { g.items.sort(function (a, b) { return a.key - b.key || a.i - b.i; }); });
    return gs.filter(function (g) { return !g.none; }).concat(gs.filter(function (g) { return g.none; }));
  }
  function listHtml(progs, u, all, taken) {
    if (!progs.length) return '<p style="opacity:.7;font-size:14px;margin:8px">ምንም ፕሮግራም የለም</p>';
    return groupProgs(progs).map(function (g) {
      return '<div class="cl-grp"><div class="cl-gh"><button type="button" class="cl-gt" data-gt="1" aria-expanded="true"><span class="cl-car">▾</span><b>' + esc(g.name) + '</b><small class="cl-gc"></small></button>' +
        '<label class="cl-chk"><input type="checkbox" data-gall="1" aria-label="' + esc(g.name) + ' - ሁሉንም ምረጥ"></label></div><div class="cl-gb">' +
        g.items.map(function (x) {
          var p = x.p, mine = all || (u.programs || []).indexOf(p.id) > -1, tk = taken[p.id];
          return '<label class="cl-chk"><input type="checkbox" data-g="' + esc(p.id) + '"' + (mine ? ' checked' : '') + (tk && !mine ? ' disabled' : '') + '><span>' + esc(p.name) + ' <small class="cl-wd">' + esc(whenLabel(p)) + '</small>' + (tk ? ' <small>(' + esc(tk) + ')</small>' : '') + '</span></label>';
        }).join('') + '</div></div>';
    }).join('');
  }

  // ---------- admin: users, roles, which programs each user sees ----------
  function admin() {
    var box = el('cl-admin', '<div class="in"><p>...</p></div>');
    function close() { box.remove(); }
    var users = [];
    function list() {
      api('admin_list', { p_tok: tok }).then(function (us) {
        users = us;
        box.innerHTML = '<div class="in"><h2>👑 ተጠቃሚዎች</h2>' + us.map(function (u) { return '<div class="cl-row"><span><b>' + esc(u.username) + '</b>' + (u.is_admin ? ' 👑' : '') + (u.perms && u.perms.role ? ' <small>' + esc(u.perms.role) + '</small>' : '') + '</span><span><button class="cl-btn g" data-e="' + u.id + '">አርትዕ</button> <button class="cl-btn r" data-d="' + u.id + '">🗑</button></span></div>'; }).join('') +
          '<p><button class="cl-btn" id="cl-new">＋ አዲስ ተጠቃሚ</button> <button class="cl-btn g" id="cl-x">ዝጋ</button></p></div>';
        $('cl-x').onclick = close; $('cl-new').onclick = function () { form(null); };
        box.querySelectorAll('[data-e]').forEach(function (b) { b.onclick = function () { form(us.filter(function (u) { return u.id === b.dataset.e; })[0]); }; });
        box.querySelectorAll('[data-d]').forEach(function (b) { b.onclick = function () { if (confirm('ይህ ተጠቃሚ ይሰረዝ?')) api('admin_delete', { p_tok: tok, p_id: b.dataset.d }).then(list).catch(function (e) { alert(e.message); }); }; });
      }).catch(function (e) { box.innerHTML = '<div class="in"><p>' + esc(e.message) + '</p><button class="cl-btn g" id="cl-x">ዝጋ</button></div>'; $('cl-x').onclick = close; });
    }
    function form(u) {
      u = u || { username: '', is_admin: false, perms: {}, programs: [] };
      var progs = []; try { progs = JSON.parse(ls.getItem('tesnim_programs') || '[]'); } catch (e) { }
      var all = u.programs === 'all';
      var taken = {};   // activity id -> name of the OTHER person who already owns it
      users.forEach(function (o) { if (o.id !== u.id && !o.is_admin && Array.isArray(o.programs)) o.programs.forEach(function (g) { taken[g] = o.username; }); });
      box.innerHTML = '<div class="in"><h2>' + (u.id ? 'አርትዕ' : 'አዲስ ተጠቃሚ') + '</h2>' +
        '<input class="cl-in" id="f-u" placeholder="የተጠቃሚ ስም" value="' + esc(u.username) + '" autocapitalize="none"><br><br><input class="cl-in" id="f-p" type="text" placeholder="' + (u.id ? 'የይለፍ ቃል (ባዶ = አይቀየርም)' : 'የይለፍ ቃል') + '" autocomplete="off">' +
        '<label class="cl-chk"><input type="checkbox" id="f-a"' + (u.is_admin ? ' checked' : '') + '> 👑 አስተዳዳሪ (ሁሉንም ያያል)</label><h3>ሚና</h3><select class="cl-in" id="f-role">' + ROLES.map(function (r) { return '<option value="' + r[0] + '"' + ((u.perms && u.perms.role || 'custom') === r[0] ? ' selected' : '') + '>' + r[1] + '</option>'; }).join('') + '</select><h3>ፈቃዶች</h3>' +
        PERMS.map(function (p) { return '<label class="cl-chk"><input type="checkbox" data-p="' + p[0] + '"' + ((u.perms[p[0]] !== undefined ? u.perms[p[0]] : p[0] === 'tick') ? ' checked' : '') + '> ' + p[1] + '</label>'; }).join('') +
        '<h3>የሚያያቸው ፕሮግራሞች</h3><label class="cl-chk"><input type="checkbox" id="f-all"' + (all ? ' checked' : '') + '> ሁሉም ፕሮግራሞች</label><div class="cl-box" id="f-list">' +
        listHtml(progs, u, all, taken) + '</div>' +
        '<div id="cl-err"></div><p><button class="cl-btn" id="f-s">አስቀምጥ</button> <button class="cl-btn g" id="f-c">ተመለስ</button></p></div>';
      var lst = $('f-list');
      function syncGroups() {   // each group's switch + "n/m" count always matches its activities (activities owned by someone else are not counted)
        lst.querySelectorAll('.cl-grp').forEach(function (g) {
          var cs = [].slice.call(g.querySelectorAll('[data-g]')).filter(function (c) { return !c.disabled; });
          var n = cs.filter(function (c) { return c.checked; }).length, a = g.querySelector('[data-gall]');
          a.disabled = !cs.length; a.checked = !!cs.length && n === cs.length; a.indeterminate = n > 0 && n < cs.length;
          g.querySelector('.cl-gc').textContent = n + '/' + cs.length;
        });
      }
      $('f-all').onchange = function () { box.querySelectorAll('[data-g]').forEach(function (c) { if (!c.disabled) c.checked = $('f-all').checked; }); syncGroups(); };
      lst.onchange = function (e) {
        var t = e.target;
        if (t.dataset.gall !== undefined) {   // "select all in this group"
          t.closest('.cl-grp').querySelectorAll('[data-g]').forEach(function (c) { if (!c.disabled) c.checked = t.checked; });
          if (!t.checked) $('f-all').checked = false;
        } else if (t.dataset.g !== undefined && !t.checked) $('f-all').checked = false;   // "all programs" can no longer stay on when one is switched off
        syncGroups();
      };
      lst.onclick = function (e) {   // tap a group's title to fold / unfold it
        var b = e.target.closest('[data-gt]'); if (!b) return;
        var body = b.closest('.cl-grp').querySelector('.cl-gb'); body.hidden = !body.hidden;
        b.setAttribute('aria-expanded', String(!body.hidden)); b.querySelector('.cl-car').textContent = body.hidden ? '▸' : '▾';
      };
      syncGroups();
      $('f-role').onchange = function () {
        var r = ROLES.filter(function (x) { return x[0] === $('f-role').value; })[0]; if (!r || r[0] === 'custom') return;
        var on = r[2].split(',');
        box.querySelectorAll('[data-p]').forEach(function (c) { c.checked = on.indexOf(c.dataset.p) > -1; });
        if (r[0] === 'editor') { $('f-all').checked = true; $('f-all').onchange(); }
      };
      $('f-c').onclick = list;
      $('f-s').onclick = function () {
        var perms = {}; box.querySelectorAll('[data-p]').forEach(function (c) { perms[c.dataset.p] = c.checked; }); perms.role = $('f-role').value;
        var ids = []; box.querySelectorAll('[data-g]').forEach(function (c) { if (c.checked) ids.push(c.dataset.g); });
        api('admin_save', { p_tok: tok, p_id: u.id || null, p_username: $('f-u').value, p_pass: $('f-p').value, p_admin: $('f-a').checked, p_perms: perms, p_programs: $('f-all').checked ? 'all' : ids })
          .then(list).catch(function (e) { $('cl-err').textContent = /duplicate/.test(e.message) ? 'ይህ ስም ተይዟል' : /overlap/.test(e.message) ? 'ይህ ፕሮግራም አስቀድሞ የሌላ ተጠቃሚ ነው: ' + e.message.split(':').pop() : /own admin/.test(e.message) ? 'የራስዎን አስተዳዳሪነት ማስወገድ አይቻልም' : e.message; });
      };
    }
    list();
  }

  // ---------- boot ----------
  if (SB_URL.indexOf('YOUR-') === 0) return;   // not configured yet: app works as before
  el('cl-veil');
  if (!tok) return login();
  if (navigator.onLine === false) return offlineStart();   // the phone says there is no network: do not wait
  api('app_get', { p_tok: tok }, 4000).then(start, function (e) {   // 4 seconds max, then open from the saved copy
    if (/auth/.test(e.message)) { ls.removeItem('tesnim_token'); return login(); }
    offlineStart();   // no internet: open from this phone's saved copy
  });
})();
