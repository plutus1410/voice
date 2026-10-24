/* ============================================================
   PLUTUS — install as an app (PWA)
   • Registers the service worker.
   • Shows the "Install PLUTUS" modal EVERY time a visitor lands on
     the home page (each fresh visit / reload, or the first time they
     reach the home page during a visit), until the app is installed.
     "Not now" only closes it for this visit.
   • It adapts to the device, so it appears on phones and tablets
     even when the browser has no one-tap install button:
       - Chrome / Edge / Samsung / Android .... one-tap "Install app"
       - Android browsers without that event .. "menu → Install app" steps
       - iPhone / iPad (Safari, Chrome, …) .... "Share → Add to Home Screen"
       - in-app browsers (WhatsApp, Instagram…) "open in your browser" steps
       - desktop Chrome / Edge ................. one-tap "Install app"
   • Nothing is shown inside the installed app, or once the browser has
     reported the install (appinstalled event), or after the visitor taps
     "I've already added it" (iPhone/iPad Safari can't tell a website that
     it is on the home screen, so the visitor is asked).
   • To force it while testing: open the site with  ?install=1
   ============================================================ */
(function () {
  'use strict';
  const KEY = 'plutus.installed.v1'; // set when the app has been installed (or the visitor says it has)
  const installed = {
    get() { try { return localStorage.getItem(KEY); } catch (e) { return null; } },
    set() { try { localStorage.setItem(KEY, String(Date.now())); } catch (e) { /* private mode: asked again next visit */ } }
  };
  const FORCE = /[?&]install=1\b/.test(location.search);
  const WAIT_MS = 2600;           // how long to wait for the browser's own install event before showing the steps instead
  let shownThisLoad = false, modal = null, shell = null, mode = null, lastFocus = null;

  /* ---------- service worker (needs https or localhost) ---------- */
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
  }

  /* ---------- environment ---------- */
  const ua = navigator.userAgent || '';
  const isStandalone = () => (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
  const isIOS = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isAndroid = /android/i.test(ua);
  const isInApp = /FBAN|FBAV|FB_IAB|Instagram|Line\/|MicroMessenger|Snapchat|Twitter|LinkedInApp|WhatsApp|Telegram|GSA\/|; wv\)/i.test(ua);
  const isMobile = isIOS || isAndroid;
  // the browser's own install event is captured early by a tiny script in index.html
  const nativeEvt = () => window.__plutusInstallEvt || null;

  /* ---------- modal ---------- */
  const ICON = {
    share: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M8 7l4-4 4 4M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1"/></svg>',
    plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M12 8v8M8 12h8"/></svg>',
    dots: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="19" r="1.4"/></svg>',
    open: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>'
  };
  const step = (ico, html) => `<li><span class="pwa-step-ico">${ICON[ico]}</span><span>${html}</span></li>`;
  const STEPS = {
    ios: `<ol class="pwa-steps">${step('share', 'Tap the <b>Share</b> button in your browser’s toolbar')}${step('plus', 'Choose <b>Add to Home Screen</b>, then tap <b>Add</b>')}</ol>`,
    android: `<ol class="pwa-steps">${step('dots', 'Open your browser’s <b>menu</b> (the three dots)')}${step('plus', 'Tap <b>Install app</b> or <b>Add to Home screen</b>')}</ol>`,
    desktop: `<ol class="pwa-steps">${step('plus', 'Click the <b>Install</b> icon at the right of the address bar')}${step('dots', 'Or open the browser <b>menu</b> and choose <b>Install PLUTUS</b>')}</ol>`,
    inapp: `<ol class="pwa-steps">${step('open', 'Open this page in <b>Safari</b> or <b>Chrome</b> (use the menu → <b>Open in browser</b>)')}${step('plus', 'Then choose <b>Install app</b> or <b>Add to Home Screen</b>')}</ol>`
  };
  const ACTIONS = {
    native: '<div class="pwa-actions"><button type="button" class="pwa-btn pwa-btn-primary" data-install>Install app</button><button type="button" class="pwa-btn pwa-btn-ghost" data-close>Not now</button></div>',
    manual: '<div class="pwa-actions"><button type="button" class="pwa-btn pwa-btn-primary" data-close>Got it</button><button type="button" class="pwa-btn pwa-btn-ghost" data-installed>I’ve already added it</button></div>'
  };
  const inner = (m) => `
        <button type="button" class="pwa-close" data-close aria-label="Close">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
        <div class="pwa-orb" aria-hidden="true"><span></span></div>
        <p class="pwa-eyebrow">Install app</p>
        <h2 id="pwaTitle">Keep PLUTUS<br />one tap away</h2>
        <p class="pwa-desc" id="pwaDesc">Add PLUTUS to your device and open it like any other app — straight from your home screen, in its own full-screen window.</p>
        <ul class="pwa-perks">
          <li><b>Faster</b><span>One tap to launch</span></li>
          <li><b>Cleaner</b><span>No browser bars</span></li>
          <li><b>Anywhere</b><span>Phone, tablet, desktop</span></li>
        </ul>
        ${m === 'native' ? '' : STEPS[m] || STEPS.android}
        ${m === 'native' ? ACTIONS.native : ACTIONS.manual}
        <p class="pwa-note">Free · no download from a store · remove it any time</p>`;

  function build(m) {
    const el = document.createElement('div');
    el.className = 'pwa-overlay';
    el.innerHTML = '<div class="pwa-modal" role="dialog" aria-modal="true" aria-labelledby="pwaTitle" aria-describedby="pwaDesc"></div>';
    shell = el.firstChild;
    shell.innerHTML = inner(m);
    return el;
  }
  function onKey(e) {
    if (e.key === 'Escape') { close(); return; }
    if (e.key !== 'Tab' || !modal) return;
    const f = Array.from(modal.querySelectorAll('button:not([disabled])'));
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
    else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
  }
  function close() {
    if (!modal) return;
    const m = modal; modal = null; shell = null; mode = null;
    document.removeEventListener('keydown', onKey, true);
    document.documentElement.classList.remove('pwa-lock');
    m.classList.remove('in');
    setTimeout(() => m.remove(), 260);
    if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) { /* ignore */ } }
  }
  async function install() {
    const d = nativeEvt();
    close();
    if (!d) return;
    window.__plutusInstallEvt = null;
    try { d.prompt(); await d.userChoice; } catch (e) { /* ignore */ }
  }
  function show(m) {
    if (shownThisLoad || modal || isStandalone()) return;
    shownThisLoad = true;                // once per visit; shown again on the next visit until installed
    lastFocus = document.activeElement; mode = m;
    modal = build(m);
    modal.addEventListener('click', (e) => {
      if (e.target === modal || e.target.closest('[data-close]')) close();
      else if (e.target.closest('[data-installed]')) { installed.set(); close(); }
      else if (e.target.closest('[data-install]')) install();
    });
    document.body.appendChild(modal);
    document.documentElement.classList.add('pwa-lock');
    document.addEventListener('keydown', onKey, true);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!modal) return;
      modal.classList.add('in');
      const b = modal.querySelector('.pwa-btn-primary'); if (b) b.focus({ preventScroll: true });
    }));
  }
  // the browser's install button became available while the "steps" version was already open: switch to one-tap install
  function upgrade() {
    if (!modal || !shell || mode === 'native') return;
    mode = 'native'; shell.innerHTML = inner('native');
    const b = modal.querySelector('.pwa-btn-primary'); if (b) b.focus({ preventScroll: true });
  }

  /* ---------- when to show ---------- */
  const onHome = () => !/^#\/s\//.test(location.hash); // the search page (not a stock dashboard)
  const eligible = () => !isStandalone() && !shownThisLoad && (FORCE || (!installed.get() && onHome()));
  const afterLoad = (fn, ms) => {
    const go = () => setTimeout(fn, ms);
    if (document.readyState === 'complete') go(); else window.addEventListener('load', go, { once: true });
  };
  const manualMode = () => (isInApp ? 'inapp' : isIOS ? 'ios' : isAndroid ? 'android' : 'desktop');

  function tryShow() {
    if (!eligible() || modal) return;
    if (nativeEvt() && !isInApp) { show('native'); return; }
    if (isMobile || isInApp) {
      // give the browser a moment to offer its own install button first
      setTimeout(() => {
        if (!eligible() || modal) return;
        if (nativeEvt() && !isInApp) { show('native'); return; }
        show(manualMode());
      }, WAIT_MS);
      return;
    }
    if (FORCE) show('desktop');   // desktop test mode
  }

  window.addEventListener('plutus:installready', () => {
    if (modal) upgrade();
    else if (eligible()) afterLoad(() => { if (eligible() && nativeEvt()) show('native'); }, 600);
  });
  window.addEventListener('appinstalled', () => { window.__plutusInstallEvt = null; installed.set(); close(); });
  // landing on the home page: on load, or arriving there later in the visit (e.g. from a shared stock link)
  afterLoad(tryShow, 1000);
  window.addEventListener('hashchange', () => { if (onHome()) setTimeout(tryShow, 700); });
})();
