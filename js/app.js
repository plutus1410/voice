/* ============================================================
   PLUTUS — UI, data fetching, routing, charts
   ============================================================ */
(function () {
  'use strict';

  const CFG = window.APP_CONFIG || {};
  const A = window.Analysis;
  const { fmtMoney, fmtPrice, fmtPct, fmtX, isNum } = A;
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const isMobile = () => window.matchMedia('(max-width: 640px)').matches;
  const CMP_KEY = 'plutus.compare.v1'; // remembers the "Compare with industry average" switch
  const loadCmpPref = () => { try { return localStorage.getItem(CMP_KEY) === '1'; } catch (e) { return false; } };
  const state = { charts: [], lastHits: {}, model: null, ind: null, peerCmp: null, indStatus: 'loading', cmp: loadCmpPref() };

  /* ---------- tiny line icons (24×24, drawn with the current text colour) ---------- */
  const IC = {
    avg: '<path d="M5.5 20v-8M12 20V4M18.5 20v-11" stroke-width="3" opacity=".55"/><path d="M2 13h20" stroke-width="1.8"/>',
    up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
    dn: '<path d="M12 5v14M6 13l6 6 6-6"/>',
    eq: '<path d="M6 9h12M6 15h12"/>',
    trend: '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
    landmark: '<path d="M3 10l9-6 9 6"/><path d="M5 10v8M9.5 10v8M14.5 10v8M19 10v8"/><path d="M3 21h18"/>',
    scale: '<path d="M12 4v16M7 20h10M4 8h16"/><path d="M4 8l-2.5 6a2.5 2.5 0 0 0 5 0zM20 8l-2.5 6a2.5 2.5 0 0 0 5 0z"/>',
    percent: '<path d="M19 5L5 19"/><circle cx="7" cy="7" r="2.4"/><circle cx="17" cy="17" r="2.4"/>',
    range: '<path d="M3 12h18M7 8l-4 4 4 4M17 8l4 4-4 4"/>',
    banknote: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.6"/><path d="M6 12h.01M18 12h.01"/>',
    wallet: '<path d="M3 7a2 2 0 0 1 2-2h13v4"/><path d="M3 7v11a2 2 0 0 0 2 2h15V9H5a2 2 0 0 1-2-2z"/><circle cx="16.5" cy="14.5" r="1"/>',
    pie: '<path d="M12 3a9 9 0 1 0 9 9h-9z"/><path d="M15 3.5A9 9 0 0 1 20.5 9H15z"/>',
    hash: '<path d="M4 9h16M4 15h16M10 3L8 21M16 3l-2 18"/>',
    repeat: '<path d="M17 2l4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/>',
    card: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20M6 15h4"/>',
    shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>',
    drop: '<path d="M12 3s6.5 6.5 6.5 11.2A6.5 6.5 0 0 1 5.5 14.2C5.5 9.5 12 3 12 3z"/>',
    waves: '<path d="M3 8c3 0 3-3 6-3s3 3 6 3 3-3 6-3"/><path d="M3 16c3 0 3-3 6-3s3 3 6 3 3-3 6-3"/>',
    pulse: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
    tag: '<path d="M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.4"/>',
    sprout: '<path d="M12 21v-8"/><path d="M12 13c0-4 3-6 7-6 0 4-3 6-7 6z"/><path d="M12 16c0-3-2.5-5-6-5 0 3 2.5 5 6 5z"/>',
    anchor: '<circle cx="12" cy="5" r="2.5"/><path d="M12 7.5V21M8 12h8M5 12H3a9 9 0 0 0 18 0h-2"/>',
    award: '<circle cx="12" cy="9" r="6"/><path d="M8.5 14.5L7 22l5-3 5 3-1.5-7.5"/>'
  };
  const ico = (k, cls = 'ico') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${IC[k] || ''}</svg>`;
  const KPI_ICON = { rev: 'banknote', ni: 'wallet', nm: 'pie', eps: 'hash', pe: 'scale', dy: 'percent', r1: 'trend', roe: 'repeat', de: 'card', eqa: 'shield', cr: 'drop', fcf: 'waves', vol: 'pulse' };
  const PILLAR_ICON = { growth: 'sprout', profit: 'wallet', strength: 'shield', value: 'tag', stability: 'anchor', track: 'award' };
  // label row of a headline-strip cell: icon · short label
  const stripK = (icon, label) => `<div class="k">${ico(icon)}<span>${label}</span></div>`;
  // the line under a headline number that shows the industry average when the comparison is on
  const stripInd = (key) => `<div class="sl cmpc" data-ind="${key}" data-t="sline"></div>`;

  /* ====================== DATA LAYER ====================== */
  const YH = 'https://query2.finance.yahoo.com';
  const YH1 = 'https://query1.finance.yahoo.com';
  const ttl = (CFG.CACHE_MINUTES || 15) * 60e3;
  // anyAge: also accept an expired copy (used only when the live request has failed)
  function cacheGet(k, anyAge) {
    try { const x = JSON.parse(sessionStorage.getItem(k)); if (x && (anyAge || Date.now() - x.t < ttl)) return x.d; } catch (e) { /* ignore */ }
    return null;
  }
  function cacheSet(k, d) {
    const v = JSON.stringify({ t: Date.now(), d });
    try { sessionStorage.setItem(k, v); } catch (e) {
      // storage full (peer statements are large): drop the oldest half of the Yahoo copies and try once more
      try {
        const old = Object.keys(sessionStorage).filter((x) => /^y[fp]:/.test(x))
          .map((x) => { let t = 0; try { t = JSON.parse(sessionStorage.getItem(x)).t || 0; } catch (er) { /* broken entry */ } return [x, t]; })
          .sort((a, b) => a[1] - b[1]);
        old.slice(0, Math.ceil(old.length / 2)).forEach(([x]) => sessionStorage.removeItem(x));
        sessionStorage.setItem(k, v);
      } catch (er) { /* still full: just not cached */ }
    }
  }

  /* ---- request queue + retries ----
     One dashboard fires a burst of requests: its own data, then shareholding, then up to ~40 for the industry peers (and the news
     sidebar adds its own). Yahoo answers such bursts with "429 Too Many Requests" or brief 5xx errors even when the visitor's
     connection is fine — that, plus a single quick retry, was what produced most "Signal lost" screens. So:
       • at most MAX_INFLIGHT requests run at once, and higher-priority ones (search, the stock being opened) jump the queue
         ahead of background peer lookups;
       • background requests for a stock the visitor has already left are dropped instead of competing with the new one;
       • a failed request is retried with growing, jittered waits (honouring Retry-After), alternating Yahoo's twin hosts;
       • if every try fails, an older copy from this tab's cache is used before giving up. */
  const PRIO = { bg: 0, side: 1, main: 2, search: 3 };
  const MAX_INFLIGHT = 6;
  let inflight = 0; const waiting = [];
  function acquire(prio) {
    if (inflight < MAX_INFLIGHT) { inflight++; return Promise.resolve(); }
    return new Promise((go) => {
      let i = waiting.length; while (i > 0 && waiting[i - 1].prio < prio) i--; // first in, first out within a priority
      waiting.splice(i, 0, { prio, go });
    });
  }
  function release() { const n = waiting.shift(); if (n) n.go(); else inflight--; }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const otherHost = (u) => (u.includes('://query2.finance.yahoo.com/') ? u.replace('://query2.', '://query1.') : u.replace('://query1.', '://query2.'));
  const transient = (e) => !!e && (e.retry || e.name === 'AbortError' || e instanceof TypeError || e instanceof SyntaxError);
  const backoff = (attempt, retryAfter) => (retryAfter > 0 ? Math.min(retryAfter * 1000, 10000) : Math.min(8000, 900 * 2 ** attempt) + Math.random() * 500);
  const workerBase = () => (CFG.WORKER_URL || '').replace(/\/+$/, '');
  // Plain-English reason for the error screen / search box (e.status keeps the code for logic)
  function explain(e) {
    if (!e) return 'Unknown error.';
    if (e.cancelled) return e.message;
    if (e.status === 429) return 'The data service is busy right now (too many requests at once).';
    if (e.status === 404) return 'Not found on Yahoo Finance (HTTP 404).';
    if (e.status >= 500) return `The data service had a temporary problem (HTTP ${e.status}).`;
    if (e.status) return `The data service refused the request (HTTP ${e.status}).`;
    if (e.name === 'AbortError') return 'The data service took too long to answer.';
    if (e instanceof SyntaxError) return 'The data service sent back an unreadable answer.';
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'You appear to be offline.';
    return 'Couldn’t reach the data service.';
  }
  // one HTTP call with a timeout; throws an Error carrying .status / .retry / .retryAfter
  async function fetchJSON(url, init) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CFG.REQUEST_TIMEOUT_MS || 15000);
    try {
      const res = await fetch(url, { ...(init || {}), signal: ctrl.signal });
      if (!res.ok) {
        const er = new Error('HTTP ' + res.status);
        er.status = res.status; er.retry = res.status === 429 || res.status >= 500;
        er.retryAfter = parseFloat(res.headers.get('Retry-After')) || 0;
        throw er;
      }
      return await res.json();
    } finally { clearTimeout(timer); }
  }
  // o: { prio, my, tries } — `my` ties a background request to the dashboard that asked for it (see loadSeq)
  async function yrequest(url, o, post) {
    o = o || {};
    const key = post ? 'yp:' + url + post : 'yf:' + url;
    const hit = cacheGet(key); if (hit) return hit;
    const prio = o.prio == null ? PRIO.main : o.prio;
    const tries = o.tries || (prio >= PRIO.main ? 4 : 3);
    let lastErr = new Error('No proxy configured');
    for (let attempt = 0; attempt < tries; attempt++) {
      if (o.my != null && o.my !== loadSeq) { const er = new Error('Cancelled — another stock was opened'); er.cancelled = true; throw er; }
      let u = attempt % 2 ? otherHost(url) : url;
      // Older Workers sent every edge-cache hit with a broken CORS header ("*, *"), which the browser reports as a network
      // error (TypeError). A throw-away parameter makes the retry miss that cache entry; Yahoo ignores it.
      if (!post && attempt > 0 && lastErr instanceof TypeError) u += (u.includes('?') ? '&' : '?') + '_pb=' + Date.now().toString(36);
      const routes = post
        ? (workerBase() ? [workerBase() + '/?url=' + encodeURIComponent(u)] : [])
        : workerBase() ? [workerBase() + '/?url=' + encodeURIComponent(u)] : (CFG.PUBLIC_PROXIES || []).map((p) => p + encodeURIComponent(u));
      if (!routes.length) throw new Error(post ? 'POST needs the Worker' : 'No proxy configured');
      await acquire(prio);
      try {
        for (const r of routes) {
          try {
            const data = await fetchJSON(r, post ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: post } : null);
            cacheSet(key, data);
            return data;
          } catch (e) { lastErr = e; if (!transient(e)) throw e; }
        }
      } catch (e) { lastErr = e; break; } finally { release(); }
      if (attempt < tries - 1) await sleep(backoff(attempt, lastErr.retryAfter));
    }
    const old = cacheGet(key, true); // stale copy beats an error screen
    if (old) { console.info('[PLUTUS] using an older cached copy:', url, lastErr.message); return old; }
    lastErr.message = explain(lastErr);
    throw lastErr;
  }
  const yfetch = (url, o) => yrequest(url, o);
  // POST (only the Worker supports it; used for the industry screener)
  const ypost = (url, body, o) => yrequest(url, o, JSON.stringify(body));
  const Yahoo = {
    search: (q) => yfetch(`${YH}/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=20&newsCount=0&listsCount=0&enableFuzzyQuery=true&region=IN&lang=en-IN`, { prio: PRIO.search, tries: 2 }),
    recs: (s, o) => yfetch(`${YH}/v6/finance/recommendationsbysymbol/${encodeURIComponent(s)}`, o),
    chart: (s, range, interval, o) => yfetch(`${YH}/v8/finance/chart/${encodeURIComponent(s)}?range=${range}&interval=${interval}&includePrePost=false&events=div%2Csplit`, o),
    timeseries: (s, o) => {
      const day = 86400;
      const p2 = Math.floor(Date.now() / 1000 / day) * day + day;
      const p1 = p2 - 10 * 365 * day;
      return yfetch(`${YH}/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(s)}?symbol=${encodeURIComponent(s)}&type=${A.TIMESERIES_TYPES.join(',')}&period1=${p1}&period2=${p2}&merge=false`, o);
    },
    summary: (s, o) => yfetch(`${YH}/v10/finance/quoteSummary/${encodeURIComponent(s)}?modules=price,summaryDetail,defaultKeyStatistics,financialData,assetProfile`, o),
    holders: (s, o) => yfetch(`${YH}/v10/finance/quoteSummary/${encodeURIComponent(s)}?modules=majorHoldersBreakdown,institutionOwnership,fundOwnership,netSharePurchaseActivity`, o),
    profile: (s, o) => yfetch(`${YH}/v10/finance/quoteSummary/${encodeURIComponent(s)}?modules=assetProfile`, o),
    industry: (key, o) => yfetch(`${YH}/v1/finance/industries/${encodeURIComponent(key)}?formatted=true&withReturns=false&lang=en-US&region=US`, o),
    screener: (body, o) => ypost(`${YH1}/v1/finance/screener?formatted=false&useRecordsResponse=false&lang=en-US&region=US&corsDomain=finance.yahoo.com`, body, o)
  };
  const bg = (my) => ({ prio: PRIO.bg, my }); // background lookups for the stock opened as `my`

  // Run fn over items with limited concurrency; never throws (each slot is {ok, v|e})
  async function pool(items, limit, fn) {
    const out = new Array(items.length); let i = 0;
    const run = async () => {
      while (i < items.length) {
        const k = i++;
        try { out[k] = { ok: true, v: await fn(items[k], k) }; } catch (e) { out[k] = { ok: false, e }; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
    return out;
  }

    /* ====================== COMPANY LOGOS ====================== */
  const LOGO_TEMPLATES = (() => {
    const t = [], k = CFG.LOGODEV_KEY;
    if (k) {
      t.push('https://img.logo.dev/ticker/{symbol}?token=' + encodeURIComponent(k) + '&size=128&format=png&fallback=404');
      t.push('https://img.logo.dev/{domain}?token=' + encodeURIComponent(k) + '&size=128&format=png&fallback=404');
    }
    return t.concat((CFG.LOGO_SOURCES && CFG.LOGO_SOURCES.length) ? CFG.LOGO_SOURCES : [
      'https://t3.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&url=https://{domain}&size=128',
      'https://icons.duckduckgo.com/ip3/{domain}.ico'
    ]);
  })();
  const logoCandidates = (d, s) => LOGO_TEMPLATES
    .filter((t) => (d || !t.includes('{domain}')) && (s || !t.includes('{symbol}')))
    .map((t) => t.replace('{domain}', encodeURIComponent(d || '')).replace('{symbol}', encodeURIComponent(s || '')));
  const domainOf = (url) => {
    if (!url) return '';
    try { return new URL(/^https?:/i.test(url) ? url : 'https://' + url).hostname.replace(/^www\./i, ''); } catch (e) { return ''; }
  };
  const initials = (name) => {
    const w = String(name || '').replace(/[^A-Za-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
    if (!w.length) return '?';
    return (w.length === 1 ? w[0].slice(0, 2) : w[0][0] + w[1][0]).toUpperCase();
  };
  function logoHTML(domain, name, size, sym) {
    const c = logoCandidates(domain, sym);
    return `<span class="logo ${size || ''} ${c.length ? '' : 'nologo'}" data-d="${esc(domain || '')}" data-s="${esc(sym || '')}" data-n="0">${c.length ? `<img src="${esc(c[0])}" alt="" loading="lazy" decoding="async">` : ''}<b>${esc(initials(name))}</b></span>`;
  }
  function applyLogo(wrap, domain) {
    if (!wrap || !domain) return;
    wrap.dataset.d = domain;
    if (!wrap.classList.contains('nologo') && wrap.querySelector('img')) return;
    const c = logoCandidates(domain, wrap.dataset.s); if (!c.length) return;
    wrap.dataset.n = '0'; wrap.classList.remove('nologo');
    let img = wrap.querySelector('img');
    if (!img) { img = document.createElement('img'); img.alt = ''; img.decoding = 'async'; wrap.insertBefore(img, wrap.firstChild); }
    img.src = c[0];
  }
  function logoFail(img) {
    const w = img.closest && img.closest('.logo'); if (!w) return;
    const n = (+w.dataset.n || 0) + 1; w.dataset.n = String(n);
    const c = logoCandidates(w.dataset.d, w.dataset.s);
    if (c[n]) img.src = c[n]; else w.classList.add('nologo');
  }
  document.addEventListener('error', (e) => { if (e.target instanceof HTMLImageElement) logoFail(e.target); }, true);
  document.addEventListener('load', (e) => { const t = e.target; if (t instanceof HTMLImageElement && t.closest('.logo') && t.naturalWidth && t.naturalWidth < 8) logoFail(t); }, true);
  if (CFG.LOGODEV_KEY) document.addEventListener('DOMContentLoaded', () => {
    const f = document.querySelector('.foot');
    if (f) f.insertAdjacentHTML('beforeend', '<p style="margin-top:8px"><a href="https://logo.dev" target="_blank" rel="noopener" style="color:inherit">Logos provided by Logo.dev</a></p>');
  });

  // Company website domains: a few well-known seeds, then looked up from Yahoo and remembered
  const SEED_DOMAINS = { 'RELIANCE.NS': 'ril.com', 'TCS.NS': 'tcs.com', 'HDFCBANK.NS': 'hdfcbank.com', 'INFY.NS': 'infosys.com', 'TATAMOTORS.NS': 'tatamotors.com', 'ITC.NS': 'itcportal.com', AAPL: 'apple.com', MSFT: 'microsoft.com', NVDA: 'nvidia.com' };
  const DOM_KEY = 'plutus:dom';
  const domCache = (() => { try { return JSON.parse(localStorage.getItem(DOM_KEY)) || {}; } catch (e) { return {}; } })();
  function saveDom(sym, d) { domCache[sym] = d; try { localStorage.setItem(DOM_KEY, JSON.stringify(domCache)); } catch (e) { /* ignore */ } }
  function knownDomain(it) {
    if (it.domain != null) return it.domain;
    if (SEED_DOMAINS[it.symbol]) return SEED_DOMAINS[it.symbol];
    if (domCache[it.symbol] !== undefined) return domCache[it.symbol];
    return null; // unknown yet
  }
  const domInflight = {};
  function resolveDomain(sym) {
    if (domInflight[sym]) return domInflight[sym];
    domInflight[sym] = (async () => {
      try {
        const S = A.parseSummary(await Yahoo.profile(sym, { prio: PRIO.side }));
        const d = domainOf(S.assetProfile && S.assetProfile.website);
        saveDom(sym, d);
        return d;
      } catch (e) { return ''; } finally { delete domInflight[sym]; }
    })();
    return domInflight[sym];
  }
  let domQueue = 0; const domWaiters = [];
  async function limitedResolve(sym) {
    if (domQueue >= 4) await new Promise((r) => domWaiters.push(r));
    domQueue++;
    try { return await resolveDomain(sym); } finally { domQueue--; const n = domWaiters.shift(); if (n) n(); }
  }

  /* ====================== FUZZY SEARCH (by company name) ====================== */
  const RECENT_KEY = 'plutus:recent';
  const getRecent = () => { try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || []; } catch (e) { return []; } };
  const pushRecent = (it) => {
    const r = getRecent().filter((x) => x.symbol !== it.symbol);
    const d = knownDomain(it);
    r.unshift({ ...it, domain: d == null ? undefined : d });
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(r.slice(0, 6))); } catch (e) { /* ignore */ }
  };
  const isIndian = (sym) => /\.(NS|BO)$/.test(sym || '');

  // Normalise a company name (or the typed query) so "Tata Motors Ltd." and "tata motors" compare cleanly
  const LEGAL = /\b(limited|ltd|inc|incorporated|corp|corporation|co|company|plc|ag|nv|sa|llc|lp|pvt|private)\b/g;
  const norm = (s) => {
    const t = String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const u = t.replace(LEGAL, ' ').replace(/\s+/g, ' ').trim();
    return u || t;
  };
  function highlight(text, q) {
    const t = esc(text); if (!q) return t;
    const words = q.trim().split(/\s+/).filter((w) => w.length > 1).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (!words.length) return t;
    return t.replace(new RegExp('(' + words.join('|') + ')', 'ig'), '<mark>$1</mark>');
  }
  // Rank Yahoo's results by how well the COMPANY NAME matches what was typed (the ticker is never used for matching)
  function rankByName(quotes, query) {
    const q = norm(query);
    if (!q || !quotes.length) return quotes;
    const bonus = (x) => (/\.NS$/.test(x.symbol) ? 0.12 : /\.BO$/.test(x.symbol) ? 0.08 : 0); // favour Indian listings: NSE, then BSE
    const nameBoost = (n) => (n.startsWith(q) ? 0.45 : n.split(' ').some((w) => w.startsWith(q)) ? 0.3 : n.includes(q) ? 0.18 : 0);
    const docs = quotes.map((x) => ({ ...x, n1: norm(x.name), n2: norm(x.short) }));
    if (!window.Fuse) {
      const hits = docs.filter((d) => d.n1.includes(q) || d.n2.includes(q));
      return (hits.length ? hits : docs).sort((a, b) => bonus(b) - bonus(a));
    }
    const fuse = new Fuse(docs, { keys: [{ name: 'n1', weight: 0.65 }, { name: 'n2', weight: 0.35 }], threshold: 0.42, ignoreLocation: true, includeScore: true, minMatchCharLength: 2 });
    const hits = fuse.search(q)
      .map((h) => ({ item: h.item, s: h.score - Math.max(nameBoost(h.item.n1), nameBoost(h.item.n2)) - bonus(h.item) }))
      .sort((a, b) => a.s - b.s).map((h) => h.item);
    // If nothing matches by name, fall back to Yahoo's own order so the user still sees something
    return hits.length ? hits : docs.sort((a, b) => bonus(b) - bonus(a));
  }

  function attachSearch(input, list) {
    let items = [], active = -1, timer = null, seq = 0, header = '';
    const open = () => list.classList.add('open');
    const close = () => { list.classList.remove('open'); active = -1; };

    function hydrateLogos() {
      const snap = items;
      snap.forEach((it, i) => {
        if (knownDomain(it) !== null) return;
        limitedResolve(it.symbol).then((d) => {
          if (!d || snap !== items) return;
          it.domain = d;
          applyLogo(list.querySelector(`li[data-i="${i}"] .logo`), d);
        });
      });
    }
    function renderItems(q) {
      if (!items.length) { list.innerHTML = `<li class="s-info">No listed companies match “${esc(q)}”. Check the spelling of the company name.</li>`; open(); return; }
      list.innerHTML = (header ? `<li class="s-head">${header}</li>` : '') + items.map((it, i) => {
        const dom = knownDomain(it);
        return `<li role="option" data-i="${i}" class="${i === active ? 'active' : ''}">
           ${logoHTML(dom, it.name, 'md', it.symbol)}
           <span class="s-main">
             <span class="s-name">${highlight(it.name, q)}</span>
             <span class="s-sub">${isIndian(it.symbol) ? '<b class="in-tag">IN</b>' : ''}<span class="s-sym">${esc(it.symbol)}</span>${it.exch ? ' · ' + esc(it.exch) : ''}</span>
           </span>
         </li>`;
      }).join('');
      open();
      const a = list.querySelector('li.active'); if (a) a.scrollIntoView({ block: 'nearest' });
      hydrateLogos();
    }
    function showRecent() {
      const r = getRecent();
      if (!r.length) return close();
      items = r; active = -1; header = 'RECENT'; renderItems('');
    }
    async function run(q) {
      const my = ++seq;
      header = '';
      list.innerHTML = '<li class="s-info">Scanning markets…</li>'; open();
      try {
        const data = await Yahoo.search(q);
        if (my !== seq) return;
        const quotes = (data.quotes || [])
          .filter((x) => x.symbol && x.quoteType === 'EQUITY')
          .map((x) => ({ symbol: x.symbol, name: x.longname || x.shortname || x.symbol, short: x.shortname || '', exch: x.exchDisp || x.exchange || '', sector: x.sectorDisp || x.sector || '', industry: x.industryDisp || x.industry || '' }));
        items = rankByName(quotes, q).slice(0, 10); active = items.length ? 0 : -1;
        renderItems(q);
      } catch (e) {
        if (my !== seq) return;
        list.innerHTML = `<li class="s-info">${esc(e.message)} Please try again in a moment.</li>`; open();
      }
    }
    function choose(i) {
      const it = items[i]; if (!it) return;
      state.lastHits[it.symbol] = it; pushRecent(it);
      input.value = ''; close(); input.blur();
      location.hash = '#/s/' + encodeURIComponent(it.symbol);
    }
    input.addEventListener('input', () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (!q) { seq++; return showRecent(); }
      timer = setTimeout(() => run(q), 230);
    });
    input.addEventListener('focus', () => { if (!input.value.trim()) showRecent(); });
    input.addEventListener('keydown', (e) => {
      if (!list.classList.contains('open')) return;
      const q = input.value.trim();
      if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(items.length - 1, active + 1); renderItems(q); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); renderItems(q); }
      else if (e.key === 'Enter') { e.preventDefault(); choose(active >= 0 ? active : 0); }
      else if (e.key === 'Escape') close();
    });
    list.addEventListener('mousedown', (e) => { const li = e.target.closest('li[data-i]'); if (li) { e.preventDefault(); choose(+li.dataset.i); } });
    document.addEventListener('click', (e) => { if (!list.contains(e.target) && e.target !== input) close(); });
  }

  /* ====================== ROUTING ====================== */
  const HOME_TITLE = document.title; // the title in index.html
  function route() {
    const m = location.hash.match(/^#\/s\/(.+)$/);
    if (m) { showView('dash'); loadDashboard(decodeURIComponent(m[1]).toUpperCase()); }
    else {
      loadSeq++; // a stock that is still loading must not re-title the home page when it finishes
      document.title = HOME_TITLE;
      showView('search'); if (!isMobile()) setTimeout(() => $('#mainSearch').focus(), 50);
    }
  }
  function showView(v) {
    $('#viewSearch').classList.toggle('hidden', v !== 'search');
    $('#viewDash').classList.toggle('hidden', v !== 'dash');
    $('#miniSearchWrap').classList.toggle('hidden', v !== 'dash');
    $('#cmpBtn').classList.toggle('hidden', v !== 'dash');
    $('#topbar').classList.toggle('has-cmp', v === 'dash');
    window.scrollTo(0, 0);
  }

  /* ====================== DASHBOARD ====================== */
  let loadSeq = 0;
  // round: 0 on a normal open; 1 for the automatic second attempt after a transient failure
  async function loadDashboard(symbol, round = 0) {
    const my = ++loadSeq;
    destroyCharts();
    state.ind = null; state.peerCmp = null; state.holders = null; state.indStatus = 'loading'; updateCmpBtn();
    $('#dashContent').classList.add('hidden'); $('#dashError').classList.add('hidden');
    $('#dashLoading').classList.remove('hidden'); $('#loadingSym').textContent = '· ' + symbol;
    $('#loadingMsg').textContent = round ? 'RE-ESTABLISHING LINK' : 'ACQUIRING TELEMETRY';
    document.title = symbol + ' — PLUTUS';
    const o = { prio: PRIO.main, my };
    const [c5, c1, ts, sum] = await Promise.allSettled([
      Yahoo.chart(symbol, '5y', '1wk', o), Yahoo.chart(symbol, '1y', '1d', o), Yahoo.timeseries(symbol, o), Yahoo.summary(symbol, o)
    ]);
    if (my !== loadSeq) return;
    const val = (r) => (r.status === 'fulfilled' ? r.value : null);
    const chartOk = (r) => { const v = val(r); return v && v.chart && v.chart.result && v.chart.result[0]; };
    if (!chartOk(c5) && !chartOk(c1)) {
      const err = [c1, c5].map((r) => (r.status === 'rejected' ? r.reason : null)).find(Boolean);
      if (!err || err.status === 404) { $('#dashLoading').classList.add('hidden'); return showError(symbol, 'Yahoo Finance has no price data for this symbol.', false); }
      // a busy / flaky data service usually recovers within seconds: one more full round before showing an error
      if (round === 0 && transient(err)) {
        $('#loadingMsg').textContent = 'DATA SERVICE BUSY · RETRYING';
        await sleep(3500);
        if (my !== loadSeq) return;
        return loadDashboard(symbol, 1);
      }
      $('#dashLoading').classList.add('hidden');
      return showError(symbol, err.message, true);
    }
    $('#dashLoading').classList.add('hidden');
    let model;
    try { model = A.buildModel(symbol, val(c5), val(c1), val(ts), val(sum), state.lastHits[symbol]); }
    catch (e) { console.error(e); return showError(symbol, 'Could not process the data for this company.', false); }
    state.model = model;
    document.title = model.name + ' (' + symbol + ') — PLUTUS';
    render(model, { summaryOk: !!val(sum) && model.hasProfile });
    loadPeers(model, my);
    loadHolders(model, my);
  }
  // canRetry: the failure was temporary (busy service, timeout, network) rather than "this symbol does not exist"
  function showError(symbol, reason, canRetry) {
    const el = $('#dashError');
    el.innerHTML = `<h2>${canRetry ? 'Signal lost' : 'No signal'}</h2><p>We couldn’t load data for <b>${esc(symbol)}</b>.<br>${esc(reason)}</p>
      ${canRetry ? '<p class="err-hint">Your internet is probably fine — Yahoo Finance sometimes limits requests for a short while. Trying again usually works.</p>' : ''}
      <div class="err-actions">${canRetry ? '<button type="button" class="primary" data-act="retry">↻ Try again</button>' : ''}<button type="button" data-act="home">← New search</button></div>`;
    el.classList.remove('hidden');
    const onIt = () => { const m = location.hash.match(/^#\/s\/(.+)$/); return !!m && decodeURIComponent(m[1]).toUpperCase() === symbol; };
    const again = () => { if (!el.classList.contains('hidden') && onIt()) loadDashboard(symbol); };
    el.querySelectorAll('button[data-act]').forEach((b) => b.addEventListener('click', () => { if (b.dataset.act === 'retry') again(); else location.hash = '#/'; }));
    if (canRetry && navigator.onLine === false) window.addEventListener('online', again, { once: true }); // back online: reload by itself
  }

  const colorFor = (s) => (s == null ? 'var(--dim)' : s >= 70 ? 'var(--good)' : s >= 45 ? 'var(--warn)' : 'var(--bad)');
  const signCls = (v) => (!isNum(v) ? 'muted' : v > 0 ? 'good' : v < 0 ? 'bad' : 'muted');

  /* ---------- industry-average comparison ---------- */
  // Every metric that is shown for the company is also computed (the same way) for its industry peers.
  const pillarScore = (m, k) => { const p = m.scores.pillars.find((x) => x.key === k); return p ? p.score : null; };
  const IND = {
    mc:  { get: (m) => m.marketCap, f: 'money', cur: 'px', better: null },
    rev: { get: (m) => m.revLast, f: 'money', cur: 'fin', better: null },
    ni:  { get: (m) => m.niLast, f: 'money', cur: 'fin', better: null },
    nm:  { get: (m) => m.netMargin, f: 'pct', better: 'high' },
    pe:  { get: (m) => (m.negEarnings ? null : A.validPe(m.pe)), f: 'x', better: 'low' },
    roe: { get: (m) => m.roe, f: 'pct', better: 'high' },
    de:  { get: (m) => (m.isFinancial ? null : m.de), f: 'x2', better: 'low', skipFin: true },
    eqa: { get: (m) => m.equityToAssets, f: 'pct', better: 'high' },
    fcf: { get: (m) => m.fcfLast, f: 'money', cur: 'fin', better: null },
    cr:  { get: (m) => (m.isFinancial ? null : m.currentRatio), f: 'x2', better: 'high', skipFin: true },
    eps: { noAvg: true },
    dy:  { get: (m) => m.divYield, f: 'pct2', better: 'high' },
    r1:  { get: (m) => m.ret1y, f: 'pct', better: 'high' },
    vol: { get: (m) => m.vol, f: 'pct', better: 'low' },
    pos: { get: (m) => m.pos52, f: 'pct0', better: null },
    overall: { get: (m) => m.scores.overall, f: 'pts', better: 'high' }
  };
  const specFor = (k) => (k.startsWith('p_') ? { get: (m) => pillarScore(m, k.slice(2)), f: 'pts', better: 'high' } : IND[k]);
  const allIndKeys = (m) => [...Object.keys(IND), ...m.scores.pillars.map((p) => 'p_' + p.key)];

  function fmtBy(spec, v, m) {
    switch (spec.f) {
      case 'money': return fmtMoney(v, spec.cur === 'px' ? m.currency : m.finCurrency);
      case 'pct': return fmtPct(v, 1);
      case 'pct2': return fmtPct(v, 2);
      case 'pct0': return fmtPct(v, 0);
      case 'x': return fmtX(v, 1);
      case 'x2': return fmtX(v, 2);
      case 'pts': return String(Math.round(v));
      default: return String(v);
    }
  }
  /* ---------- industry comparison ----------
     Industry averages are OFF by default. The "Compare with industry" switch in the top bar turns them on. Nothing is inserted into the page when it flips: every spot that can show
     a comparison already exists, with a fixed size, and just fades / swaps its content in place — "Industry avg …" plus a
     "▲ 9% higher" chip under the headline numbers and in each Key Number card, a chip on each Power Stat, a marker on its
     meter and on the score ring. */
  function cmpDelta(v, a, spec) {
    if (!isNum(v) || !isNum(a)) return null;
    const d = v - a, ad = Math.abs(d); let txt, tiny;
    if (spec.f === 'pct' || spec.f === 'pct2' || spec.f === 'pct0') { txt = `${(ad * 100).toFixed(1)} pts`; tiny = ad < 0.005; }
    else if (spec.f === 'pts') { txt = `${Math.round(ad)} pts`; tiny = ad < 2; }
    else { if (a === 0) return null; const rel = ad / Math.abs(a); txt = `${(rel * 100).toFixed(0)}%`; tiny = rel < 0.03; }
    const dir = tiny ? 'eq' : d > 0 ? 'up' : 'dn';
    const cls = tiny || !spec.better ? 'neu' : ((spec.better === 'high') === (d > 0)) ? 'good' : 'bad';
    return { dir, cls, txt: tiny ? '' : txt, word: tiny ? 'in line' : d > 0 ? 'higher' : 'lower', long: tiny ? 'in line with the industry' : `${txt} ${d > 0 ? 'higher' : 'lower'} than the industry` };
  }
  function cmpInfo(key) {
    const m = state.model, ind = state.ind, spec = specFor(key);
    if (!spec) return { s: 'none' };
    if (spec.noAvg) return { s: 'na', why: 'Per-share values can’t be compared across companies' };
    if (state.indStatus === 'loading') return { s: 'wait' };
    if (!ind) return { s: 'na', why: 'No industry data' };
    if (spec.skipFin && m.isFinancial) return { s: 'na', why: 'Not applicable to financial companies' };
    const a = ind.avg[key];
    if (!isNum(a)) return { s: 'na', why: 'No industry average available' };
    return { s: 'ok', a, spec, txt: fmtBy(spec, a, m), d: cmpDelta(spec.get(m), a, spec) };
  }
  // e.g. "Industry average 24.1×. This company: 9% higher than the industry — worse (lower is better here)."
  function cmpTip(i) {
    const better = i.spec.better === 'high' ? 'higher is better here' : 'lower is better here';
    const verdict = !i.d ? '' : i.d.cls === 'good' ? ` — better (${better})` : i.d.cls === 'bad' ? ` — worse (${better})` : '';
    return `Industry average ${i.txt}.${i.d ? ` This company: ${i.d.long}${verdict}.` : ''}`;
  }
  const dlHTML = (i) => `<span class="dl ${i.d.cls}" tabindex="0" data-tip="${esc(cmpTip(i))}">${ico(i.d.dir)}${i.d.txt ? `<b>${esc(i.d.txt)}</b>` : ''}<i class="dw">${esc(i.d.word)}</i></span>`;
  // "INDUSTRY AVG 24.1×" (narrow boxes show "AVG 24.1×", see css/style.css)
  const lnKey = '<span class="ln-k"><span class="lk-l">Industry avg</span><span class="lk-s">Avg</span></span>';
  const lnHTML = (i) => (i.s === 'ok'
    ? `<span class="ln">${lnKey}<b>${esc(i.txt)}</b></span>${i.d ? dlHTML(i) : ''}`
    : `<span class="ln na" title="${esc(i.why || '')}">${lnKey}<b>n/a</b></span>`);

  function computeIndustryAvg(models) {
    const avg = {};
    allIndKeys(state.model).forEach((k) => {
      const spec = specFor(k); if (!spec || spec.noAvg) return;
      // money amounts (market cap, revenue, profit, cash flow) are only averaged across peers reporting in the same currency
      const usable = (x) => spec.f !== 'money' || (spec.cur === 'px' ? x.currency === state.model.currency : x.finCurrency === state.model.finCurrency);
      const vs = models.filter(usable).map((x) => spec.get(x)).filter(isNum);
      avg[k] = vs.length >= 2 ? vs.reduce((a, b) => a + b, 0) / vs.length : null;
    });
    return avg;
  }
  // Fill every comparison spot (called when the page is drawn and again when the peers have loaded)
  function fillIndustryUI() {
    const m = state.model; if (!m) return;
    let n = 0;
    document.querySelectorAll('#dashContent [data-ind]').forEach((el) => {
      el.style.setProperty('--i', n++); // entrance stagger
      const t = el.dataset.t, i = cmpInfo(el.dataset.ind);
      if (t === 'mk' || t === 'rmk') { // markers on the Power Stat meters / the score ring
        el.classList.toggle('off', i.s !== 'ok');
        if (i.s === 'ok') el.style.setProperty(t === 'mk' ? '--x' : '--a', Math.max(0, Math.min(100, i.a)).toFixed(1));
        return;
      }
      if (i.s === 'wait') { el.innerHTML = '<span class="sk"></span>'; return; }
      if (t === 'line' || t === 'sline') el.innerHTML = lnHTML(i);
      else if (t === 'chip') el.innerHTML = i.s === 'ok' && i.d ? dlHTML(i) : '';
    });
  }

  /* ---------- the switch (top bar): "Compare with industry" / "Industry avg" ---------- */
  const HINT_KEY = 'plutus.compareHint.v1'; // set once the visitor has used the comparison (stops the attention glow)
  function cmpActive() { return !!state.cmp && state.indStatus !== 'fail'; }
  function updateCmpBtn() {
    const b = $('#cmpBtn'); if (!b) return;
    const st = state.indStatus, on = cmpActive();
    b.classList.toggle('is-wait', st === 'loading'); b.classList.toggle('is-na', st === 'fail');
    b.setAttribute('aria-checked', on ? 'true' : 'false'); b.disabled = st === 'fail';
    b.dataset.tip = st === 'fail' ? 'Industry comparison isn’t available for this company'
      : on ? 'Showing the industry average next to each number — click to hide it'
        : 'Show this company’s numbers next to the average of similar companies in its industry';
  }
  function applyCompare() {
    const root = $('#dashContent'); if (root) root.classList.toggle('cmp-on', cmpActive());
    updateCmpBtn();
  }
  function toggleCompare() {
    if (state.indStatus === 'fail') return;
    state.cmp = !state.cmp;
    try { localStorage.setItem(CMP_KEY, state.cmp ? '1' : '0'); localStorage.setItem(HINT_KEY, '1'); } catch (e) { /* private mode: just not remembered */ }
    const b = $('#cmpBtn'); if (b) b.classList.remove('nudge');
    applyCompare(); syncCompareCharts();
    // say what just happened, and how to read the chips that appear
    showToast(state.cmp
      ? `<span class="tg-t">Industry average <b>on</b></span><span class="tg-g"><span class="dl neu">${ico('up')}<i class="dw">higher</i></span><span class="dl neu">${ico('dn')}<i class="dw">lower</i></span></span><span class="tg-g"><span class="tg-d good"></span>better<span class="tg-d bad"></span>worse</span>`
      : '<span class="tg-t">Industry average <b>off</b></span>');
  }

  // add / remove the industry lines on the charts without rebuilding them (Chart.js animates the change)
  function syncCompareCharts() {
    const m = state.model; if (!m) return;
    const on = cmpActive() && state.ind;
    const pe = findChart('chPE');
    if (pe) {
      const has = pe.data.datasets.some((d) => d.isInd);
      if (on && isNum(state.ind.avg.pe) && !has) { pe.data.datasets.push(peIndDataset(pe.data.labels.length, state.ind.avg.pe)); pe.update(); }
      else if (!on && has) { pe.data.datasets = pe.data.datasets.filter((d) => !d.isInd); pe.update(); }
    }
    const mg = findChart('chMargin');
    if (mg) {
      const pb = $('#periodToggle button.on'), annual = !pb || pb.dataset.p !== 'quarterly';
      const has = mg.data.datasets.some((d) => d.isInd);
      if (on && annual && isNum(state.ind.avg.nm) && !has) { mg.data.datasets.push(marginIndDataset(mg.data.labels, state.ind.avg.nm)); mg.update(); }
      else if (!(on && annual) && has) { mg.data.datasets = mg.data.datasets.filter((d) => !d.isInd); mg.update(); }
    }
  }
  let toastT = null;
  function showToast(html) {
    const t = $('#cmpToast'); if (!t) return;
    t.innerHTML = html; t.classList.add('in');
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('in'), 3600);
  }
  // a gentle glow on the switch (until the comparison has been used once) so the feature is easy to discover
  function nudgeCompare() {
    const b = $('#cmpBtn'); if (!b || state.cmp) return;
    let seen = false; try { seen = localStorage.getItem(HINT_KEY) === '1'; } catch (e) { /* ignore */ }
    if (seen) return;
    b.classList.remove('nudge'); void b.offsetWidth; b.classList.add('nudge');
    setTimeout(() => b.classList.remove('nudge'), 3400);
  }
  function initCompareSwitch() {
    const b = $('#cmpBtn'); if (!b) return;
    b.addEventListener('click', () => { if (!b.disabled) toggleCompare(); });
    // tap-to-show tooltips on the industry chips (touch screens have no hover)
    document.addEventListener('click', (e) => {
      const t = e.target.closest('.dl[data-tip], .bd[data-tip]');
      document.querySelectorAll('.dl.tip-open, .bd.tip-open').forEach((x) => { if (x !== t) x.classList.remove('tip-open'); });
      if (t) t.classList.toggle('tip-open');
    });
    updateCmpBtn();
  }

  function aboutSection(m, idx) {
    // Website: shown as "Website  domain ↗" so it lines up with the other label/value facts
    const siteHost = domainOf(m.website);
    const siteHref = m.website ? (/^https?:/i.test(m.website) ? m.website : 'https://' + m.website) : '';
    const facts = [
      m.sector ? `<span class="fact"><span class="fk">Sector</span> <b>${esc(m.sector)}</b></span>` : '',
      m.industry ? `<span class="fact"><span class="fk">Industry</span> <b>${esc(m.industry)}</b></span>` : '',
      m.city || m.country ? `<span class="fact"><span class="fk">HQ</span> <b>${esc([m.city, m.country].filter(Boolean).join(', '))}</b></span>` : '',
      isNum(m.beta) ? `<span class="fact"><span class="fk">Beta</span> <b>${m.beta.toFixed(2)}</b></span>` : '',
      siteHref ? `<span class="fact"><span class="fk">Website</span> <b><a href="${esc(siteHref)}" target="_blank" rel="noopener">${esc(siteHost || m.website)} ↗</a></b></span>` : ''
    ].join('');
    if (!m.summary && !facts) return '';
    return `<section class="section about reveal" id="sec-about">
      <div class="section-head"><span class="idx">${idx}</span><h2>About the Company</h2><p>What the business does</p></div>
      ${m.summary ? `<p class="about-text clamp" id="aboutText">${esc(m.summary)}</p><button class="more-btn hidden" id="aboutMore">Read more ↓</button>` : ''}
      ${facts ? `<div class="facts">${facts}</div>` : ''}
    </section>`;
  }

  function render(m, opts) {
    const c = m.finCurrency, pc = m.currency;
    const S = m.scores;
    const posPct = isNum(m.pos52) ? (m.pos52 * 100).toFixed(1) : null;
    let n = 0; const idx = () => String(++n).padStart(2, '0');
    const notices = [];
    if (!opts.summaryOk) notices.push('Company profile & key statistics are temporarily unavailable — some figures are computed from statements instead.');
    if (!m.hasFundamentals) notices.push('Yahoo Finance has no annual financial statements for this listing, so growth, profit and balance-sheet metrics can’t be shown.');
    if (!m.sameCur && m.hasFundamentals) notices.push(`Financial statements are reported in ${c} while the share trades in ${pc}; the P/E history chart is hidden to avoid mixing currencies.`);
    const about = aboutSection(m, '01');
    if (about) n = 1;
    const dom = domainOf(m.website) || (domCache[m.symbol] || '');
    if (domainOf(m.website)) saveDom(m.symbol, domainOf(m.website));

    const html = `
    ${secNavHTML(!!about)}
    <section class="identity reveal">
      <div class="ident-row">
        ${logoHTML(dom, m.name, 'lg', m.symbol)}
        <div class="ident-txt">
          <div class="meta"><b>${esc(m.symbol)}</b> · ${esc(m.exchange)}</div>
          <h1>${esc(m.name)}</h1>
        </div>
      </div>
      <div class="price-block">
        <div class="price">${fmtPrice(m.price, pc)}</div>
        <div class="chg ${signCls(m.changePct)}">${isNum(m.change) ? (m.change > 0 ? '▲ ' : m.change < 0 ? '▼ ' : '') + Math.abs(m.change).toFixed(2) : ''} ${isNum(m.changePct) ? '(' + fmtPct(m.changePct, 2, true) + ')' : ''} <span class="muted">today</span></div>
      </div>
    </section>
    ${notices.map((x) => `<div class="notice">${esc(x)}</div>`).join('')}
    <div class="strip reveal">
      <div>${stripK('landmark', 'Market Cap')}<div class="v">${fmtMoney(m.marketCap, pc)}</div>${stripInd('mc')}</div>
      <div>${stripK('scale', 'P/E')}<div class="v">${m.negEarnings ? 'n/a <span class="muted" style="font-size:12px">(loss)</span>' : fmtX(m.pe, 1)}</div>${stripInd('pe')}</div>
      <div>${stripK('trend', '1Y Return')}<div class="v ${signCls(m.ret1y)}">${fmtPct(m.ret1y, 1, true)}</div>${stripInd('r1')}</div>
      <div>${stripK('percent', 'Div. Yield')}<div class="v">${isNum(m.divYield) ? fmtPct(m.divYield, 2) : '—'}</div>${stripInd('dy')}</div>
      <div class="range-cell">${stripK('range', '52W Range')}
        ${posPct != null ? `<div class="range-wrap"><div class="range"><span style="left:${posPct}%"></span></div>
        <div class="range-lbl"><span>${fmtPrice(m.low52, pc)}</span><span>${fmtPrice(m.high52, pc)}</span></div></div>` : '<div class="v">—</div>'}
      </div>
    </div>

    ${about}

    <section class="section reveal" id="sec-health">
      <div class="section-head"><span class="idx">${idx()}</span><h2>Health Scan</h2><p>Six power stats, scored 0–100 from reported numbers</p></div>
      <div class="health">
        <div class="panel ring-wrap">
          <div class="panel-title">Overall Health Score</div>
          <div class="ring">
            <svg viewBox="0 0 200 200"><circle class="track" cx="100" cy="100" r="88"/><circle class="bar" id="ringBar" cx="100" cy="100" r="88"
              style="stroke:${colorFor(S.overall)}" stroke-dasharray="${2 * Math.PI * 88}" stroke-dashoffset="${2 * Math.PI * 88}"/>
              <g class="ring-mk off" data-ind="overall" data-t="rmk"><line x1="179" y1="100" x2="197" y2="100"/></g></svg>
            <div class="center"><div class="num" id="ringNum">0</div><div class="of swap"><span class="sw-a">OF 100</span><span class="sw-b cmpc" data-ind="overall" data-t="line"></span></div></div>
          </div>
          <div class="tier ${S.tier.cls}">${S.tier.label}</div>
          <div class="ring-note">Average of the six stats. Describes financial health — not whether the share is a good buy.</div>
        </div>
        <div class="panel">
          <div class="panel-title">Power Stats</div>
          ${S.pillars.map((p) => {
            const lit = p.score == null ? 0 : Math.round(p.score / 10);
            return `<div class="pillar">
              <div class="pillar-top"><span class="pillar-name"><span class="pi" style="color:${colorFor(p.score)}">${ico(PILLAR_ICON[p.key] || 'avg')}</span>${p.name}</span><span class="pillar-r"><span class="cmpc" data-ind="p_${p.key}" data-t="chip"></span><span class="pillar-score" style="color:${colorFor(p.score)}">${p.score == null ? 'N/A' : p.score}</span></span></div>
              <div class="pillar-hint">${p.hint}</div>
              <div class="segs">${Array.from({ length: 10 }, (_, i) => `<i style="${i < lit ? 'background:' + colorFor(p.score) : ''}"></i>`).join('')}<b class="mk off" data-ind="p_${p.key}" data-t="mk"></b></div>
            </div>`;
          }).join('')}
        </div>
      </div>
    </section>

    <section class="section reveal" id="sec-key">
      <div class="section-head"><span class="idx">${idx()}</span><h2>Key Numbers</h2><p>Tap ⓘ for meaning</p></div>
      ${kpiGroupsHTML(m)}
    </section>

    <section class="section reveal" id="sec-trajectory">
      <div class="section-head"><span class="idx">${idx()}</span><h2>Trajectory</h2><p>How the business and the share price have moved over time</p></div>
      <div class="charts">
        ${chartCard('chPrice', 'Share Price', 'What one share has cost in the market over time.', m.takeaways.price, true,
          '<div class="toggle" id="priceToggle"><button data-r="1y">1Y</button><button data-r="5y" class="on">5Y</button></div>')}
        ${chartCard('chPE', 'P/E Ratio History', 'How many years of profit investors pay for in the share price (price ÷ latest annual earnings per share). Dashed line = 5-year median.', m.takeaways.pe, true)}
        <div class="period-bar">
          <div><span class="pb-title">Business Results</span><span class="pb-sub" id="periodNote"></span></div>
          <div class="toggle big" id="periodToggle"><button data-p="annual" class="on">YEARLY</button><button data-p="quarterly">QUARTERLY</button></div>
        </div>
        ${chartCard('chRev', 'Revenue vs Net Profit', 'Sales (everything customers paid) vs. what was left after all costs and taxes.', m.takeaways.revenue)}
        ${chartCard('chMargin', 'Profit Margins', 'Out of every 100 of sales, how much remains as profit at each stage.', m.takeaways.margins)}
        ${chartCard('chEPS', 'Earnings per Share', 'Profit belonging to each single share.', m.takeaways.eps)}
        ${chartCard('chCash', 'Cash Flow', 'Cash generated by operations, and what is left after investing in the business (free cash flow).', m.takeaways.cash)}
        ${chartCard('chDebt', 'Debt vs Shareholders’ Equity', 'Money borrowed vs. money that belongs to the owners.', m.takeaways.debt, true)}
      </div>
    </section>

    <section class="section reveal" id="sec-shareholding">
      <div class="section-head"><span class="idx">${idx()}</span><h2>Shareholding Pattern</h2><p>Who owns the company’s shares</p></div>
      <div id="holdWrap"><div class="peer-loading"><div class="orbit sm"><span></span></div><span>Loading shareholding…</span></div></div>
    </section>

    <section class="section reveal" id="sec-peers">
      <div class="section-head"><span class="idx">${idx()}</span><h2>Peer Arena</h2><p>How it stacks up against companies in the same industry</p></div>
      <div id="peerWrap"><div class="peer-loading"><div class="orbit sm"><span></span></div><span>Finding industry peers…</span></div></div>
    </section>

    <section class="section reveal" id="sec-sw">
      <div class="section-head"><span class="idx">${idx()}</span><h2>Strengths &amp; Weaknesses</h2><p>Facts that stand out — you decide what matters to you</p></div>
      <div class="sw" id="swWrap">
        ${swCol('s', 'Strengths', m.strengths, 'good')}
        ${swCol('w', 'Weaknesses', m.weaknesses, 'bad')}
      </div>
      <div class="verdict-note">PLUTUS does not tell you to buy, sell or hold. Every investor has different goals, time horizons and risk tolerance. Use these facts as a starting point, compare with similar companies, and read the company’s official reports before deciding.</div>
    </section>`;

    const root = $('#dashContent');
    root.innerHTML = html;
    root.classList.remove('hidden');
    fillIndustryUI(); applyCompare();

    // About: show "Read more" only if text is actually clamped
    const at = $('#aboutText'), mb = $('#aboutMore');
    if (at && mb) {
      requestAnimationFrame(() => { if (at.scrollHeight > at.clientHeight + 4) mb.classList.remove('hidden'); });
      mb.addEventListener('click', () => { const c2 = at.classList.toggle('clamp'); mb.textContent = c2 ? 'Read more ↓' : 'Show less ↑'; });
    }
    // Key Numbers: category tabs show one group of cards at a time
    root.querySelectorAll('.kpi-tab').forEach((tab) => tab.addEventListener('click', () => {
      const g = tab.dataset.g;
      root.querySelectorAll('.kpi.tip-open').forEach((k) => k.classList.remove('tip-open'));
      root.querySelectorAll('.kpi-tab').forEach((t) => { const on = t === tab; t.classList.toggle('on', on); t.setAttribute('aria-selected', on ? 'true' : 'false'); t.tabIndex = on ? 0 : -1; });
      root.querySelectorAll('.kpis').forEach((p) => { p.hidden = p.dataset.g !== g; });
    }));
    root.querySelectorAll('.kpi-tabs').forEach((bar) => bar.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const tabs = Array.from(bar.querySelectorAll('.kpi-tab')), i = tabs.indexOf(document.activeElement);
      if (i < 0) return;
      const nx = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      nx.focus(); nx.click(); e.preventDefault();
    }));
    // KPI tooltips: tap-to-toggle for touch screens
    root.querySelectorAll('.kpi .info').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      const card = b.closest('.kpi'); const was = card.classList.contains('tip-open');
      root.querySelectorAll('.kpi.tip-open').forEach((k) => k.classList.remove('tip-open'));
      if (!was) card.classList.add('tip-open');
    }));
    document.addEventListener('click', () => root.querySelectorAll('.kpi.tip-open').forEach((k) => k.classList.remove('tip-open')));

    requestAnimationFrame(() => {
      const C = 2 * Math.PI * 88, bar = $('#ringBar');
      if (bar && isNum(S.overall)) bar.style.strokeDashoffset = C * (1 - S.overall / 100);
      countUp($('#ringNum'), S.overall);
    });
    observeReveal();
    initSecNav();
    drawCharts(m);
  }

  function countUp(el, target) {
    if (!el) return;
    if (!isNum(target)) { el.textContent = '—'; return; }
    const t0 = performance.now(), dur = 1300;
    const step = (t) => { const p = Math.min(1, (t - t0) / dur); el.textContent = Math.round(target * (1 - Math.pow(1 - p, 3))); if (p < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }
  function observeReveal() {
    const els = document.querySelectorAll('.reveal');
    if (!('IntersectionObserver' in window)) { els.forEach((e) => e.classList.add('in')); return; }
    const io = new IntersectionObserver((ents) => ents.forEach((en) => { if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); } }), { threshold: 0.05 });
    els.forEach((e) => io.observe(e));
  }

  /* ---------- sticky section navigation ----------
     A slim bar at the very top of the stock page (above the company name and price) that sticks under the top bar while
     the page scrolls. Tabs jump to a section; the tab of the section being read lights up. Scrolling is done in JS (not with
     #anchors) because the address hash is the router (#/s/SYMBOL). */
  const SEC_TABS = [
    { id: 'sec-about', label: 'About the Company' },
    { id: 'sec-health', label: 'Health Scan' },
    { id: 'sec-key', label: 'Key Numbers' },
    { id: 'sec-trajectory', label: 'Trajectory' },
    { id: 'sec-shareholding', label: 'Shareholding' },
    { id: 'sec-peers', label: 'Peer Arena' },
    { id: 'sec-sw', label: 'Strengths &amp; Weaknesses' }
  ];
  function secNavHTML(hasAbout) {
    const tabs = SEC_TABS.filter((t) => hasAbout || t.id !== 'sec-about')
      .map((t) => `<button type="button" class="sn-tab" data-t="${t.id}">${t.label}</button>`).join('');
    return `<nav class="secnav" id="secNav" aria-label="Jump to a section"><div class="sn-track">${tabs}</div></nav>`;
  }
  let secNavOff = null;
  function initSecNav() {
    if (secNavOff) { secNavOff(); secNavOff = null; }
    const nav = $('#secNav'); if (!nav) return;
    const track = $('.sn-track', nav);
    const items = Array.from(nav.querySelectorAll('.sn-tab')).map((tab) => ({ tab, sec: document.getElementById(tab.dataset.t) })).filter((x) => x.sec);
    const barH = () => { const tb = $('#topbar'); return tb ? tb.getBoundingClientRect().height : 68; };
    const offset = () => barH() + nav.offsetHeight + 16;                          // where a section's top should land
    const docTop = (el) => { let y = 0; for (; el; el = el.offsetParent) y += el.offsetTop; return y; }; // ignores the reveal animation's shift
    let locked = false, lockT = null, current = null, raf = 0;
    function setActive(it) {
      if (it === current) return;
      current = it;
      items.forEach((x) => { const on = x === it; x.tab.classList.toggle('on', on); if (on) x.tab.setAttribute('aria-current', 'true'); else x.tab.removeAttribute('aria-current'); });
      if (it && track.scrollWidth > track.clientWidth + 2) { // narrow screens: keep the active tab in view (sideways only, never moves the page)
        track.scrollTo({ left: Math.max(0, it.tab.offsetLeft - (track.clientWidth - it.tab.offsetWidth) / 2), behavior: 'smooth' });
      }
    }
    function update() {
      raf = 0;
      if (!document.body.contains(nav)) { off(); return; }
      if (!nav.offsetParent) return; // dashboard hidden (home page)
      nav.classList.toggle('stuck', nav.getBoundingClientRect().top <= barH() + 0.5);
      if (locked) return;
      const line = window.scrollY + offset() + 8;
      let cur = null;
      for (const it of items) if (docTop(it.sec) <= line) cur = it;
      if (items.length && window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) cur = items[items.length - 1]; // bottom of the page
      setActive(cur);
    }
    const onScroll = () => {
      if (locked) { clearTimeout(lockT); lockT = setTimeout(() => { locked = false; update(); }, 140); } // a tab click is still scrolling
      if (!raf) raf = requestAnimationFrame(update);
    };
    nav.addEventListener('click', (e) => {
      const b = e.target.closest('.sn-tab'); if (!b) return;
      const it = items.find((x) => x.tab === b); if (!it) return;
      locked = true; clearTimeout(lockT); lockT = setTimeout(() => { locked = false; update(); }, 400);
      setActive(it);
      const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      window.scrollTo({ top: Math.max(0, docTop(it.sec) - offset()), behavior: reduce ? 'auto' : 'smooth' });
    });
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    function off() { window.removeEventListener('scroll', onScroll); window.removeEventListener('resize', onScroll); clearTimeout(lockT); if (raf) cancelAnimationFrame(raf); raf = 0; }
    secNavOff = off;
    requestAnimationFrame(update);
  }

  /* ---------- KPI cards ---------- */
  // 12 cards in 3 categories of 4 (the 4 most useful for that question), each category filling the full width.
  const KPI_GROUPS = [
    { name: 'Growth & Profit', icon: 'trend', sub: 'Is it growing and earning?', keys: ['rev', 'ni', 'nm', 'eps'] },
    { name: 'Value & Returns', icon: 'tag', sub: 'What you pay, what you get', keys: ['pe', 'dy', 'r1', 'roe'] },
    { name: 'Safety & Cash', icon: 'shield', sub: 'How strong are its finances?', keys: ['de', 'cr', 'fcf', 'vol'] }
  ];
  function kpiGroupsHTML(m) {
    const byKey = {};
    kpiCards(m).forEach((html) => { const k = (html.match(/data-k="([^"]+)"/) || [])[1]; if (k) byKey[k] = html; });
    const tabs = KPI_GROUPS.map((g, i) => `<button type="button" class="kpi-tab${i === 0 ? ' on' : ''}" role="tab" id="kpiTab${i}" aria-controls="kpiPanel${i}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}" data-g="${i}" title="${esc(g.sub)}"><span class="kt-ic">${ico(g.icon)}</span><span class="kt-name">${g.name}</span></button>`).join('');
    const panels = KPI_GROUPS.map((g, i) => `<div class="kpis" role="tabpanel" id="kpiPanel${i}" aria-labelledby="kpiTab${i}" data-g="${i}"${i === 0 ? '' : ' hidden'}>${g.keys.map((k) => byKey[k] || (k === 'de' ? byKey.eqa : '') || '').join('')}</div>`).join('');
    return `<div class="kpi-tabs" role="tablist" aria-label="Key number categories">${tabs}</div>${panels}`;
  }
  function kpiCards(m) {
    const c = m.finCurrency;
    const lvl = (v, good, bad, higherBetter = true) => (!isNum(v) ? '' : higherBetter ? (v >= good ? 'good' : v <= bad ? 'bad' : 'warn') : (v <= good ? 'good' : v >= bad ? 'bad' : 'warn'));
    const card = (k, v, sub, dot, tip, ik) => `<div class="kpi" data-k="${ik}"><div class="k"><span class="ki ${dot}">${ico(KPI_ICON[ik] || 'avg')}</span><span class="k-label">${k}</span><button class="info" aria-label="What is ${k}?">i</button><div class="tip">${tip}</div></div><div class="v">${v}</div><div class="sub swap"><span class="sw-a">${sub}</span><span class="sw-b cmpc" data-ind="${ik}" data-t="line"></span></div></div>`;
    const yoy = (g) => (isNum(g) ? `<span class="${signCls(g)}">${fmtPct(g, 1, true)}</span> vs last year` : 'vs last year: —');
    const fin = m.isFinancial;
    return [
      card('Revenue', fmtMoney(m.revLast, c), yoy(m.revYoY), lvl(m.revYoY, 0.08, 0), 'Total money the company earned from selling its products or services in the year. Growing revenue means more customers or higher prices.', 'rev'),
      card('Net Profit', fmtMoney(m.niLast, c), isNum(m.niYoY) ? yoy(m.niYoY) : (isNum(m.niLast) && m.niLast < 0 ? '<span class="bad">Net loss</span>' : '—'), isNum(m.niLast) && m.niLast < 0 ? 'bad' : lvl(m.niYoY, 0.08, 0), 'What is left after paying every cost, interest and tax. This is the company’s “take-home pay”.', 'ni'),
      card('Net Margin', fmtPct(m.netMargin), isNum(m.netMarginPrev) ? `prev. year ${fmtPct(m.netMarginPrev)}` : '—', lvl(m.netMargin, 0.12, 0.04), 'Profit kept from every 100 of sales. 20% means 20 of every 100 is profit. Higher = more efficient business.', 'nm'),
      card('P/E Ratio', m.negEarnings ? 'n/a' : fmtX(m.pe, 1), isNum(m.peMedian) && isNum(m.pe) ? `5-yr median ${fmtX(m.peMedian, 1)}` : isNum(m.fwdPe) ? `forward ${fmtX(m.fwdPe, 1)}` : '—', m.negEarnings ? 'bad' : lvl(m.pe, 18, 40, false), 'Share price ÷ profit per share. A P/E of 20 means you pay 20 years of today’s profit. Higher = more expensive (often because growth is expected).', 'pe'),
      card('ROE', fmtPct(m.roe), 'profit ÷ shareholders’ money', lvl(m.roe, 0.15, 0.06), 'Return on Equity: how much profit the company makes with the money its owners have put in. 20% means 20 of profit for every 100 of owners’ money.', 'roe'),
      card(fin ? 'Equity / Assets' : 'Debt / Equity', fin ? fmtPct(m.equityToAssets) : fmtX(m.de, 2), fin ? 'capital cushion (financial co.)' : 'borrowed per 1 of owners’ money', fin ? lvl(m.equityToAssets, 0.12, 0.06) : lvl(m.de, 0.5, 1.5, false), fin ? 'For banks and insurers, borrowing is the business. This shows what share of assets is funded by owners — a bigger cushion absorbs losses better.' : 'How much the company has borrowed compared with what its owners have put in. 0.5× means 50 of debt for every 100 of equity. Lower = less risk from lenders.', fin ? 'eqa' : 'de'),
      card('Free Cash Flow', fmtMoney(m.fcfLast, c), isNum(m.fcfMargin) ? `${fmtPct(m.fcfMargin)} of revenue` : '—', isNum(m.fcfLast) ? (m.fcfLast > 0 ? 'good' : 'bad') : '', 'Cash left over after running the business and paying for new equipment. It can fund dividends, buybacks or growth without borrowing.', 'fcf'),
      card('Current Ratio', fin ? 'n/a' : fmtX(m.currentRatio, 2), fin ? 'not meaningful for financials' : 'short-term assets ÷ bills', fin ? '' : lvl(m.currentRatio, 1.5, 1), 'Can the company pay bills due within a year? Above 1× means it has more near-cash assets than short-term bills.', 'cr'),
      card('EPS (TTM)', isNum(m.ttmEps) ? m.ttmEps.toFixed(2) : '—', `${esc(c)} per share · last 12 months`, isNum(m.ttmEps) ? (m.ttmEps > 0 ? 'good' : 'bad') : '', 'Earnings per share: total profit divided by the number of shares. Your “slice” of profit for each share you own.', 'eps'),
      card('Dividend Yield', isNum(m.divYield) ? fmtPct(m.divYield, 2) : '—', isNum(m.divYield) && m.divYield > 0 ? 'cash paid yearly ÷ price' : 'no regular dividend', isNum(m.divYield) && m.divYield >= 0.015 ? 'good' : '', 'Cash the company pays shareholders each year as a % of the share price. 2% means about 2 per year for every 100 invested.', 'dy'),
      card('1-Year Return', fmtPct(m.ret1y, 1, true), isNum(m.ret5y) ? `5-yr ${fmtPct(m.ret5y, 0, true)}` : 'price change', lvl(m.ret1y, 0.1, -0.1), 'How much the share price changed over the past 12 months (excluding dividends). Past moves do not predict future ones.', 'r1'),
      card('Volatility', fmtPct(m.vol, 0), isNum(m.maxDD) ? `worst dip ${fmtPct(m.maxDD, 0)}` : '—', lvl(m.vol, 0.25, 0.45, false), 'How wildly the price moved over the last year. 30% means it typically swings about ±30% in a year. Higher = bumpier ride.', 'vol')
    ];
  }

  function chartCard(id, title, what, takeaway, wide, extra) {
    return `<div class="chart-card ${wide ? 'wide' : ''}">
      <h3>${title}${extra || ''}</h3>
      <p class="what">${what}</p>
      <div class="chart-box" id="box-${id}"><canvas id="${id}"></canvas></div>
      <div class="takeaway ${takeaway ? '' : 'hidden'}" id="tk-${id}">${esc(takeaway || '')}</div>
    </div>`;
  }
  function swCol(cls, title, items, color) {
    return `<div class="sw-col ${cls}">
      <h3 class="${color}">${title} <span class="count">${items.length}</span></h3>
      ${items.length ? items.map((x) => `<div class="sw-item"><span class="bar"></span><div><div class="t">${esc(x.title)}${x.peer ? '<span class="peer-chip">VS INDUSTRY</span>' : ''}</div><div class="d">${esc(x.text)}</div></div><span class="m">${esc(x.metric)}</span></div>`).join('')
        : `<div class="sw-empty">Nothing stands out ${cls === 's' ? 'strongly on the positive side' : 'as a clear weak spot'} based on the available data.</div>`}
    </div>`;
  }

  /* ====================== INDUSTRY PEERS ====================== */
  const toIndustryKey = (s) => String(s || '').toLowerCase().replace(/&/g, ' ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const sameText = (a, b) => !!a && !!b && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

  // ----- listing country: derived from the ticker's exchange suffix (no suffix = US exchanges) -----
  const SUFFIX_COUNTRY = {
    NS: 'IN', BO: 'IN', L: 'GB', T: 'JP', HK: 'HK', DE: 'DE', F: 'DE', SG: 'DE', TO: 'CA', V: 'CA', NE: 'CA', CN: 'CA', AX: 'AU', NZ: 'NZ',
    PA: 'FR', MI: 'IT', MC: 'ES', AS: 'NL', BR: 'BE', LS: 'PT', ST: 'SE', CO: 'DK', HE: 'FI', OL: 'NO', VI: 'AT', SW: 'CH', IR: 'IE',
    SS: 'CN', SZ: 'CN', KS: 'KR', KQ: 'KR', TW: 'TW', TWO: 'TW', SI: 'SG', SA: 'BR', MX: 'MX', JO: 'ZA', TA: 'IL', BK: 'TH', JK: 'ID',
    KL: 'MY', SR: 'SA', IS: 'TR', WA: 'PL', AT: 'GR'
  };
  const COUNTRY_NAME = {
    US: 'the United States', IN: 'India', GB: 'the United Kingdom', JP: 'Japan', HK: 'Hong Kong', DE: 'Germany', CA: 'Canada', AU: 'Australia', NZ: 'New Zealand',
    FR: 'France', IT: 'Italy', ES: 'Spain', NL: 'the Netherlands', BE: 'Belgium', PT: 'Portugal', SE: 'Sweden', DK: 'Denmark', FI: 'Finland', NO: 'Norway',
    AT: 'Austria', CH: 'Switzerland', IE: 'Ireland', CN: 'China', KR: 'South Korea', TW: 'Taiwan', SG: 'Singapore', BR: 'Brazil', MX: 'Mexico', ZA: 'South Africa',
    IL: 'Israel', TH: 'Thailand', ID: 'Indonesia', MY: 'Malaysia', SA: 'Saudi Arabia', TR: 'Turkey', PL: 'Poland', GR: 'Greece'
  };
  const marketOf = (sym) => {
    const i = String(sym || '').lastIndexOf('.');
    if (i < 0) return 'US';
    const suf = sym.slice(i + 1).toUpperCase();
    return SUFFIX_COUNTRY[suf] || 'X:' + suf;
  };
  const countryName = (code) => COUNTRY_NAME[code] || '';

  // field: 'industry' (same industry) or 'sector' (wider fallback). Always restricted to the company's listing country.
  function screenerBody(m, field) {
    const ops = [{ operator: 'EQ', operands: [field, field === 'sector' ? m.sector : m.industry] }];
    const mk = marketOf(m.symbol);
    if (/\.NS$/.test(m.symbol)) ops.push({ operator: 'EQ', operands: ['exchange', 'NSI'] });
    else if (/\.BO$/.test(m.symbol)) ops.push({ operator: 'EQ', operands: ['exchange', 'BSE'] });
    else if (mk.length === 2) ops.push({ operator: 'EQ', operands: ['region', mk.toLowerCase()] });
    return { size: 40, offset: 0, sortField: 'intradaymarketcap', sortType: 'DESC', quoteType: 'EQUITY', topOperator: 'AND', query: { operator: 'AND', operands: ops }, userId: '', userIdType: 'guid' };
  }
  function collectSymbols(node, out, depth) {
    if (!node || depth > 8) return out;
    if (Array.isArray(node)) node.forEach((n) => collectSymbols(n, out, depth + 1));
    else if (typeof node === 'object') {
      if (typeof node.symbol === 'string' && node.symbol && node.symbol[0] !== '^') out.push({ symbol: node.symbol, name: node.name || node.longName || node.shortName || '' });
      Object.values(node).forEach((v) => { if (v && typeof v === 'object') collectSymbols(v, out, depth + 1); });
    }
    return out;
  }
  const rawNum = (v) => (isNum(v) ? v : v && isNum(v.raw) ? v.raw : null);

  // Collect candidate companies. Several sources, because any single one can be unavailable or return too few names.
  // `diag` records what each source returned so a "no peers" result can be explained instead of silently empty.
  async function gatherCandidates(m, my, diag) {
    const out = new Map();
    const myMarket = marketOf(m.symbol);
    const sameMkt = (x) => marketOf(x) === myMarket; // peers must be listed in the same country
    diag.market = myMarket;
    const add = (sym, name, mc, src) => { if (sym && sym !== m.symbol && sameMkt(sym) && !out.has(sym)) out.set(sym, { symbol: sym, name, marketCap: mc, src }); };
    const indCount = () => [...out.values()].filter((c) => c.src === 'screener' || c.src === 'industry').length;
    const runScreener = async (field, src) => {
      try {
        const r = await Yahoo.screener(screenerBody(m, field), bg(my));
        const res = r && r.finance && r.finance.result && r.finance.result[0];
        const list = (res && (res.quotes || res.records)) || [];
        list.forEach((q) => add(q.symbol, q.longName || q.shortName || q.displayName || '', rawNum(q.marketCap), src));
        diag[src] = list.length;
      } catch (e) { diag[src] = 'error: ' + e.message; }
    };
    // 1) Yahoo screener: every listed company in this industry (needs the updated Worker)
    if (m.industry) await runScreener('industry', 'screener');
    // 2) Yahoo's industry page: the industry's top companies
    if (m.industry && indCount() < 6) {
      try {
        const r = await Yahoo.industry(m.industryKey || toIndustryKey(m.industry), bg(my));
        const l = collectSymbols(r, [], 0);
        l.forEach((x) => add(x.symbol, x.name, null, 'industry'));
        diag.industryPage = l.length;
      } catch (e) { diag.industryPage = 'error: ' + e.message; }
    }
    // 3) Yahoo's "similar companies" (kept only if they pass the industry/sector check below)
    if (out.size < 8) {
      try {
        const r = await Yahoo.recs(m.symbol, bg(my));
        const list = (r.finance && r.finance.result && r.finance.result[0] && r.finance.result[0].recommendedSymbols) || [];
        list.forEach((x) => add(x.symbol, '', null, 'recs'));
        diag.similar = list.length;
      } catch (e) { diag.similar = 'error: ' + e.message; }
    }
    // 4) Same SECTOR: fallback pool for companies whose exact industry has few (or no) listed peers, e.g. Apple
    if (m.sector && indCount() < 6) await runScreener('sector', 'screenerSector');
    const logGap = (c) => (isNum(c.marketCap) && isNum(m.marketCap) && c.marketCap > 0 && m.marketCap > 0 ? Math.abs(Math.log(c.marketCap / m.marketCap)) : 99);
    const prio = { screener: 0, industry: 1, recs: 2, screenerSector: 3 };
    const arr = [...out.values()].sort((a, b) => prio[a.src] - prio[b.src] || logGap(a) - logGap(b));
    diag.candidates = arr.length;
    return arr.slice(0, 18);
  }

  // Returns { models, level: 'industry' | 'sector' | 'similar' } or null
  async function findIndustryPeers(m, my, diag) {
    const cands = await gatherCandidates(m, my, diag);
    if (my !== loadSeq || !cands.length) return null;
    const sums = await pool(cands, 4, (c) => Yahoo.summary(c.symbol, bg(my)));
    if (my !== loadSeq) return null;
    diag.profiles = `${sums.filter((x) => x.ok).length}/${cands.length}`;
    const seen = new Set([norm(m.name)]);
    const rows = [];
    // .NS listings first so the NSE copy of a dual-listed company wins
    cands.map((c, i) => ({ c, s: sums[i] })).sort((a, b) => (/\.NS$/.test(b.c.symbol) ? 1 : 0) - (/\.NS$/.test(a.c.symbol) ? 1 : 0)).forEach(({ c, s }) => {
      if (!s.ok || marketOf(c.symbol) !== marketOf(m.symbol)) return;
      const S = A.parseSummary(s.v), pr = S.price || {}, ap = S.assetProfile || {};
      const nm = pr.longName || pr.shortName || c.name || c.symbol;
      const key = norm(nm); if (seen.has(key)) return; // same company listed twice
      const mc = rawNum(pr.marketCap) ?? c.marketCap;
      rows.push({ c, S, nm, key, mc, industry: ap.industry || '', sector: ap.sector || '', cur: pr.currency });
      seen.add(key);
    });
    let pick, level;
    const inInd = m.industry ? rows.filter((r) => sameText(r.industry, m.industry)) : [];
    const inSec = m.sector ? rows.filter((r) => !sameText(r.industry, m.industry) && sameText(r.sector, m.sector)) : [];
    diag.sameIndustry = inInd.length; diag.sameSector = inSec.length;
    if (inInd.length >= 3) { pick = inInd; level = 'industry'; }
    else if (inInd.length + inSec.length >= 3) { pick = [...inInd, ...inSec]; level = 'sector'; }
    else if (inInd.length >= 2) { pick = inInd; level = 'industry'; }
    else if (inInd.length + inSec.length >= 2) { pick = [...inInd, ...inSec]; level = 'sector'; }
    else if (!m.industry && !m.sector && rows.length >= 2) { pick = rows; level = 'similar'; }
    else return null;
    // Keep the 6 closest in size (same-industry names always come first)
    const gap = (r) => (isNum(r.mc) && isNum(m.marketCap) && r.mc > 0 && m.marketCap > 0 ? Math.abs(Math.log(r.mc / m.marketCap)) : 99);
    pick = pick.sort((a, b) => (level === 'sector' ? (sameText(b.industry, m.industry) - sameText(a.industry, m.industry)) : 0) || gap(a) - gap(b)).slice(0, 6);
    // Full models for each peer so every metric is computed exactly like the main company's
    const built = await pool(pick, 3, async (r) => {
      const [c5, c1, ts] = await Promise.allSettled([Yahoo.chart(r.c.symbol, '5y', '1wk', bg(my)), Yahoo.chart(r.c.symbol, '1y', '1d', bg(my)), Yahoo.timeseries(r.c.symbol, bg(my))]);
      const val = (x) => (x.status === 'fulfilled' ? x.value : null);
      const sumRes = sums[cands.indexOf(r.c)].v;
      return A.buildModel(r.c.symbol, val(c5), val(c1), val(ts), sumRes, { name: r.nm });
    });
    if (my !== loadSeq) return null;
    // Peers that report or trade in another currency (e.g. a Japanese company's US listing) are kept: ratios and percentages are
    // comparable; only their money amounts are left out of the averages (see computeIndustryAvg).
    const models = built.filter((x) => x.ok).map((x) => x.v).filter((x) => x.hasFundamentals || isNum(x.marketCap));
    diag.peersBuilt = `${models.length}/${pick.length}`;
    if (models.length < 2) return null;
    return { models, level };
  }

  async function loadPeers(m, my) {
    const diag = {};
    const fail = (msg) => {
      if (my !== loadSeq) return;
      state.ind = null; state.peerCmp = null; state.indStatus = 'fail';
      const detail = Object.entries(diag).map(([k, v]) => `${k}: ${v}`).join(' · ');
      const hint = Object.values(diag).some((v) => /HTTP (400|403|404|405)/.test(String(v))) ? ' The peer-lookup request was refused — make sure the latest worker.js is deployed on Cloudflare.' : '';
      const w = $('#peerWrap'); if (w) w.innerHTML = `<div class="nodata"><div>${esc(msg)}${hint ? `<div class="diag">${esc(hint.trim())}</div>` : ''}${detail ? `<div class="diag">Lookup details — ${esc(detail)}</div>` : ''}</div></div>`;
      fillIndustryUI();
      applyCompare();
    };
    try {
      const found = await findIndustryPeers(m, my, diag);
      if (my !== loadSeq) return;
      console.info('[PLUTUS peers]', m.symbol, m.industry, diag);
      const where = countryName(marketOf(m.symbol));
      if (!found) return fail(m.industry ? `Couldn’t find enough peers for “${m.industry}”${where ? ' listed in ' + where : ' in the same market'} right now.` : 'Yahoo Finance has no industry information for this company.');
      state.ind = { models: found.models, level: found.level, n: found.models.length, avg: computeIndustryAvg(found.models) };
      state.indStatus = 'ok';
      fillIndustryUI();
      applyCompare();
      refreshIndustryCharts();
      nudgeCompare();
      const mainRow = A.peerRowFromModel(m, true);
      const peerRows = found.models.map((x) => { const r = A.peerRowFromModel(x, false); if (x.currency !== m.currency) r.marketCap = null; return r; });
      const cmp = A.peerCompare(mainRow, peerRows, m.isFinancial);
      state.peerCmp = cmp;
      renderPeers(m, cmp, found.level);
      const sw = $('#swWrap');
      if (sw && (cmp.strengths.length || cmp.weaknesses.length)) {
        const tag = (arr) => arr.map((x) => ({ ...x, peer: true }));
        sw.innerHTML = swCol('s', 'Strengths', [...m.strengths, ...tag(cmp.strengths)], 'good') + swCol('w', 'Weaknesses', [...m.weaknesses, ...tag(cmp.weaknesses)], 'bad');
      }
    } catch (e) { console.error(e); diag.error = e.message; fail('Couldn’t load industry peers (' + e.message + ').'); }
  }

  /* ====================== SHAREHOLDING PATTERN ====================== */
  const rawv = (x) => (x && typeof x === 'object' ? x.raw : x);
  function parseHolders(res) {
    const r = res && res.quoteSummary && res.quoteSummary.result && res.quoteSummary.result[0];
    if (!r) return null;
    const mh = r.majorHoldersBreakdown || {};
    const num = (x) => { const v = rawv(x); return isNum(v) ? v : null; };
    // Yahoo's pctChange = how much that holder changed ITS OWN stake since the previous filing.
    // dpp turns it into percentage points of ALL the company's shares:  now - before,  where before = now / (1 + change).
    const list = (o) => ((o && o.ownershipList) || [])
      .map((x) => {
        const pct = num(x.pctHeld), chg = num(x.pctChange);
        const dpp = pct != null && chg != null && chg > -1 ? (pct - pct / (1 + chg)) * 100 : null;
        return { name: x.organization, pct, chg, dpp, date: num(x.reportDate) };
      })
      .filter((x) => x.name && x.pct != null && x.pct > 0)
      .sort((a, b) => b.pct - a.pct).slice(0, 10);
    // insiders: net buying / selling over the last 6 months
    const na = r.netSharePurchaseActivity || {};
    const buys = num(na.buyInfoShares), sells = num(na.sellInfoShares);
    let net = num(na.netInfoShares);
    if (net == null && (buys != null || sells != null)) net = (buys || 0) - Math.abs(sells || 0);
    const act = net == null ? null : { net, period: na.period || '6m' };
    const h = { ins: num(mh.insidersPercentHeld), inst: num(mh.institutionsPercentHeld), instFloat: num(mh.institutionsFloatPercentHeld), count: num(mh.institutionsCount),
      insts: list(r.institutionOwnership), funds: list(r.fundOwnership), act };
    if (h.ins == null && h.inst == null && !h.insts.length && !h.funds.length) return null;
    return h;
  }
  // Three groups: insiders / institutions / everyone else. If the source figures add up to more than 100%, the crowd is scaled to 100.
  function holdSegments(h) {
    const ins = h.ins, inst = h.inst, known = (ins || 0) + (inst || 0);
    const others = Math.max(0, 1 - known), total = Math.max(1, known);
    const segs = [];
    if (ins != null) segs.push({ key: 'ins', label: 'Promoters & insiders', value: ins });
    if (inst != null) segs.push({ key: 'inst', label: 'Institutions', value: inst });
    segs.push({ key: 'pub', label: 'Public & others', value: others });
    segs.forEach((x) => { x.share = x.value / total; });
    return { segs, scaled: known > 1.02 };
  }

  /* ---------- change since the previous filing ---------- */
  const fmtPP = (v) => { const a = Math.abs(v); return a < 0.005 ? '≈0 pp' : (v > 0 ? '+' : '−') + a.toFixed(2) + ' pp'; };
  function moveStats(list) {
    const ch = list.filter((x) => isNum(x.dpp));
    if (!ch.length) return null;
    const up = ch.filter((x) => x.dpp >= 0.005).sort((a, b) => b.dpp - a.dpp);
    const dn = ch.filter((x) => x.dpp <= -0.005).sort((a, b) => a.dpp - b.dpp);
    return { up, dn, net: ch.reduce((a, x) => a + x.dpp, 0), n: ch.length, flat: ch.length - up.length - dn.length };
  }
  const trend = (v) => (v >= 0.005 ? 'good' : v <= -0.005 ? 'bad' : 'muted');
  const arrow = (v) => (v >= 0.005 ? '▲' : v <= -0.005 ? '▼' : '•');
  const periodLbl = (p) => String(p).replace(/^(\d+)\s*m$/i, '$1 mo');
  function changeChip(key, h) {
    if (key === 'ins' && h.act) {
      const n = h.act.net;
      return `<span class="cl-chg ${trend(n)}">${arrow(n)} ${n >= 0.005 ? 'Net buying' : n <= -0.005 ? 'Net selling' : 'No net trades'} · ${esc(periodLbl(h.act.period))}</span>`;
    }
    if (key === 'inst') {
      const m = moveStats(h.insts);
      if (m) return `<span class="cl-chg ${trend(m.net)}">${arrow(m.net)} ${fmtPP(m.net)} · top ${m.n} holders</span>`;
    }
    return '';
  }
  function holdListHTML(items) {
    if (!items.length) return '<li class="hl-empty">Not available for this company.</li>';
    const max = Math.max(...items.map((x) => x.pct));
    return items.map((x, i) => {
      const chg = isNum(x.dpp) && Math.abs(x.dpp) >= 0.005
        ? `<span class="hl-chg ${trend(x.dpp)}" title="Change in the share of the company held, since the previous filing">${arrow(x.dpp)} ${Math.abs(x.dpp).toFixed(2)} pp</span>` : '<span class="hl-chg"></span>';
      return `<li><span class="hl-n">${i + 1}</span><div class="hl-main"><div class="hl-row"><span class="hl-name" title="${esc(x.name)}">${esc(x.name)}</span><span class="hl-pct">${fmtPct(x.pct, 2)}</span></div><div class="hl-bar"><i style="width:${Math.max(2, x.pct / max * 100).toFixed(1)}%"></i></div></div>${chg}</li>`;
    }).join('');
  }
  function movesHTML(list) {
    const m = moveStats(list);
    if (!m) return '<p class="hold-empty">Change data isn’t available for this list.</p>';
    const max = Math.max(0.0001, ...m.up.concat(m.dn).map((x) => Math.abs(x.dpp)));
    const rows = (arr, cls) => arr.length
      ? arr.map((x) => `<li><div class="mv-row"><span class="mv-name" title="${esc(x.name)}">${esc(x.name)}</span><span class="mv-val ${cls}">${fmtPP(x.dpp)}</span></div><div class="mv-bar"><i class="${cls}" style="width:${Math.max(4, Math.abs(x.dpp) / max * 100).toFixed(1)}%"></i></div></li>`).join('')
      : '<li class="mv-none">None</li>';
    return `<div class="mv-head"><b>Change since the previous filing</b><span class="mv-net ${trend(m.net)}">${arrow(m.net)} Net ${fmtPP(m.net)}</span></div>
      <div class="mv-grid">
        <div class="mv-col"><h4 class="good">▲ Added <span>${m.up.length}</span></h4><ul>${rows(m.up, 'good')}</ul></div>
        <div class="mv-col"><h4 class="bad">▼ Trimmed <span>${m.dn.length}</span></h4><ul>${rows(m.dn, 'bad')}</ul></div>
      </div>
      <p class="hold-note mv-note">pp = percentage points of all shares${m.flat ? ` · ${m.flat} unchanged` : ''}</p>`;
  }

  /* ---------- crowd of people ----------
     100 little people = 100% of the shares (1 person = 1%). Each colour is one kind of shareholder, so the size of
     each group is that group's holding. Counts use the "largest remainder" method so they always add up to 100,
     and any holder with a visible stake gets at least one person.
     Wide screens: a grid. Phones: the same people arranged in a circle (one wedge per group). */
  const CROWD_N = 100;
  const PERSON = '<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false"><symbol id="plutusPerson" viewBox="0 0 24 40"><circle cx="12" cy="7" r="6"/><path d="M2.5 40V24.5C2.5 18.7 6.7 15 12 15s9.5 3.7 9.5 9.5V40z"/></symbol></svg>';
  const personSvg = (cls, extra) => `<svg class="${cls}" viewBox="0 0 24 40"${extra || ''} aria-hidden="true" focusable="false"><use href="#plutusPerson"/></svg>`;
  function crowdCounts(segs) {
    const raw = segs.map((x) => x.share * CROWD_N), c = raw.map(Math.floor);
    let rem = CROWD_N - c.reduce((p, q) => p + q, 0);
    raw.map((r, i) => [r - c[i], i]).sort((p, q) => q[0] - p[0]).forEach((e) => { if (rem > 0) { c[e[1]]++; rem--; } });
    segs.forEach((x, i) => { if (c[i] === 0 && x.value >= 0.004) { c[c.indexOf(Math.max(...c))]--; c[i] = 1; } });
    return c;
  }
  const SIZES = ['', 'v1', 'v2', 'v3', 'v4']; // a few slightly different heights so it reads as a crowd, not a grid
  function crowdHTML(segs, counts) {
    let i = 0, out = '';
    segs.forEach((x, k) => { for (let n = 0; n < counts[k]; n++, i++) out += personSvg(`pp g-${x.key} ${SIZES[(i * 7 + k * 3) % SIZES.length]}`, ` data-g="${x.key}" style="--i:${i}"`); });
    return out;
  }
  // Circle layout: 100 points spread evenly over a disc (sunflower pattern), then ordered clockwise from the top,
  // so handing them out group by group makes each group one wedge of the circle.
  let DISC = null;
  function discPoints() {
    if (DISC) return DISC;
    const N = CROWD_N, R = 0.44, ga = Math.PI * (3 - Math.sqrt(5)), pts = [];
    for (let i = 0; i < N; i++) {
      const r = R * Math.sqrt((i + 0.5) / N), t = i * ga, x = r * Math.cos(t), y = r * Math.sin(t);
      pts.push({ x, y, a: (Math.atan2(y, x) + Math.PI / 2 + 2 * Math.PI) % (2 * Math.PI) });
    }
    pts.sort((p, q) => p.a - q.a);
    return (DISC = pts);
  }
  function discHTML(segs, counts) {
    const pts = discPoints(), W = 5.2; let i = 0, out = '';
    segs.forEach((x, k) => {
      for (let n = 0; n < counts[k]; n++, i++) {
        const p = pts[i], w = W * (0.94 + ((i * 37) % 13) / 100), h = w * 40 / 24;
        out += personSvg(`pp g-${x.key}`, ` data-g="${x.key}" style="--i:${i};left:${(50 + p.x * 100 - w / 2).toFixed(2)}%;top:${(50 + p.y * 100 - h / 2).toFixed(2)}%;width:${w.toFixed(2)}%"`);
      }
    });
    return out;
  }

  async function loadHolders(m, my) {
    let res = null;
    try { res = await Yahoo.holders(m.symbol, { prio: PRIO.side, my }); } catch (e) { console.info('[PLUTUS holders]', m.symbol, e.message); }
    if (my !== loadSeq) return;
    const h = parseHolders(res);
    state.holders = h;
    renderHolders(h, !res);
  }
  function renderHolders(h, failed) {
    const w = $('#holdWrap'); if (!w) return;
    if (!h) { w.innerHTML = `<div class="nodata"><div>${failed ? 'Shareholding data couldn’t be loaded right now.' : 'Shareholding data isn’t published for this company on Yahoo Finance.'}</div></div>`; return; }
    const { segs, scaled } = holdSegments(h);
    const counts = crowdCounts(segs);
    const lead = segs.reduce((p, q, i) => (q.value > p.v ? { v: q.value, i } : p), { v: -1, i: 0 }), L = segs[lead.i];
    const legend = segs.map((x, k) => `<li><button type="button" class="cl-item" data-g="${x.key}" aria-pressed="false">
        ${personSvg('cl-ico g-' + x.key)}
        <span class="cl-txt"><span class="cl-name">${x.label}</span><span class="cl-sub">${counts[k]} of every 100 shares</span>${changeChip(x.key, h)}</span>
        <span class="cl-val">${fmtPct(x.value, 1)}</span></button></li>`).join('');
    const stats = [
      isNum(h.count) ? `<div><b>${Math.round(h.count).toLocaleString('en-US')}</b><span>Institutions holding</span></div>` : '',
      isNum(h.instFloat) ? `<div><b>${fmtPct(h.instFloat, 1)}</b><span>Of free float held by institutions</span></div>` : ''
    ].join('');
    const lists = { insts: h.insts, funds: h.funds };
    const both = h.insts.length && h.funds.length;
    const first = h.insts.length ? 'insts' : 'funds';
    const dates = h.insts.concat(h.funds).map((x) => x.date).filter(isNum);
    const asOf = dates.length ? new Date(Math.max(...dates) * 1000).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }) : '';
    const head = both
      ? `<div class="toggle" id="holdToggle"><button data-l="insts" class="on">INSTITUTIONS</button><button data-l="funds">MUTUAL FUNDS</button></div>`
      : `<span class="hold-tag">${first === 'insts' ? 'INSTITUTIONS' : 'MUTUAL FUNDS'}</span>`;
    const summary = segs.map((x, k) => `${counts[k]} ${x.label}`).join(', ');
    const aria = `Crowd of 100 people showing who owns the shares: ${esc(summary)}`;
    const hasList = h.insts.length || h.funds.length;
    w.innerHTML = `${PERSON}
      <div class="panel crowd-panel">
        <div class="panel-title crowd-title"><span>Who owns the shares</span><span class="crowd-key">${personSvg('ck-ico')} = 1% of shares</span></div>
        <div class="crowd-wrap">
          <div class="crowd-vis">
            <div class="crowd crowd-grid" role="img" aria-label="${aria}">${crowdHTML(segs, counts)}</div>
            <div class="crowd crowd-disc" role="img" aria-label="${aria}">${discHTML(segs, counts)}</div>
          </div>
          <div class="crowd-side">
            <p class="crowd-lead"><b>${counts[lead.i]}</b> of every 100 shares are held by <span class="g-${L.key}">${L.label.toLowerCase()}</span>.</p>
            <ul class="crowd-legend">${legend}</ul>
            ${stats ? `<div class="hold-stats">${stats}</div>` : ''}
            ${scaled ? '<p class="hold-note">Source figures overlap slightly, so the crowd is scaled to 100.</p>' : ''}
          </div>
        </div>
      </div>
      <div class="panel hold-top">
        <div class="panel-title hold-top-head"><span>Biggest holders</span>${head}</div>
        ${hasList ? `<ol class="hold-list" id="holdList">${holdListHTML(lists[first])}</ol><div class="hold-moves" id="holdMoves">${movesHTML(lists[first])}</div>` : '<p class="hold-empty">A holder-by-holder list isn’t available for this company.</p>'}
        ${asOf ? `<p class="hold-note">Latest filing: ${asOf}</p>` : ''}
      </div>
      <p class="hold-foot">Source: Yahoo Finance · can lag official filings.</p>`;

    // hover / tap a group (or a person) to light up that part of the crowd
    const cw = $('.crowd-wrap', w); let locked = null;
    const setHl = (k) => {
      ['ins', 'inst', 'pub'].forEach((x) => cw.classList.toggle('hl-' + x, x === k));
      cw.querySelectorAll('.cl-item').forEach((b) => { b.classList.toggle('on', b.dataset.g === k); b.setAttribute('aria-pressed', locked === b.dataset.g ? 'true' : 'false'); });
    };
    cw.querySelectorAll('.cl-item').forEach((b) => {
      b.addEventListener('mouseenter', () => setHl(b.dataset.g));
      b.addEventListener('mouseleave', () => setHl(locked));
      b.addEventListener('focus', () => setHl(b.dataset.g));
      b.addEventListener('blur', () => setHl(locked));
      b.addEventListener('click', () => { locked = locked === b.dataset.g ? null : b.dataset.g; setHl(locked || b.dataset.g); });
    });
    cw.querySelectorAll('.crowd').forEach((c) => {
      c.addEventListener('mouseover', (e) => { const p = e.target.closest('.pp'); if (p) setHl(p.dataset.g); });
      c.addEventListener('mouseleave', () => setHl(locked));
    });
    const tg = $('#holdToggle');
    if (tg) tg.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      tg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      const ol = $('#holdList'), mv = $('#holdMoves');
      if (ol) ol.innerHTML = holdListHTML(lists[b.dataset.l]);
      if (mv) mv.innerHTML = movesHTML(lists[b.dataset.l]);
    });
  }

  const fmtMetric = (mt, v, cur) => (!isNum(v) ? '—' : mt.fmt === 'pct' ? fmtPct(v, 1) : mt.fmt === 'x' ? fmtX(v, 1) : fmtMoney(v, cur));
  const shortSym = (s) => s.replace(/\.(NS|BO)$/, '');
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

  // One Peer Arena card: metric name, big rank, a position meter (one segment per company) and a short position label.
  const MEDAL_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 2h4l1 5H8zM17 2h-4l-1 5h4z" class="rt-ribbon"/><circle cx="12" cy="15" r="6.5"/></svg>';
  function rankTile(r) {
    const has = r.rank != null && r.of > 0;
    const tone = !has ? 'none' : r.rank === 1 ? 'gold' : r.rank === 2 ? 'silver' : r.rank === 3 ? 'bronze' : 'blue';
    const f = has && r.of > 1 ? (r.rank - 1) / (r.of - 1) : 0;
    const label = !has ? 'No data' : r.rank === 1 ? 'Best in group' : (r.of > 1 && r.rank === r.of) ? 'Last in group' : f <= 1 / 3 ? 'Upper third' : f <= 2 / 3 ? 'Middle' : 'Lower third';
    const segs = has ? Array.from({ length: r.of }, (_, i) => `<i class="${i === r.rank - 1 ? 'me' : ''}"></i>`).join('') : '';
    return `<div class="rank-tile tone-${tone}">
        <div class="rt-top"><span class="rt-name">${r.name}</span>${tone === 'gold' || tone === 'silver' || tone === 'bronze' ? `<span class="rt-medal" title="Top 3">${MEDAL_SVG}</span>` : ''}</div>
        <div class="rt-rank">${has ? '#' + r.rank : '—'}<span>${has ? 'of ' + r.of : 'no data'}</span></div>
        <div class="rt-meter" aria-hidden="true">${segs}</div>
        <div class="rt-label">${label}</div>
      </div>`;
  }

  function renderPeers(m, cmp, level) {
    const cur = m.currency, nPeers = cmp.rows.length - 1;
    const medal = (r) => (r == null ? '' : r === 1 ? 'gold' : r === 2 ? 'silver' : r === 3 ? 'bronze' : '');
    const tiles = cmp.ranks.map((r) => rankTile(r)).join('');
    const cols = A.PEER_METRICS.filter((mt) => !(m.isFinancial && mt.key === 'de'));
    const row = (r) => {
      const dom = domainOf(r.website);
      const cell = `<span class="pcell">${r.isMain ? '<span class="you">◉</span>' : ''}${logoHTML(dom, r.name, 'sm', r.symbol)}<span class="ptxt"><b>${esc(shortSym(r.symbol))}</b><span class="pname">${esc(r.name)}</span></span></span>`;
      return `<tr class="${r.isMain ? 'main' : ''}"><td>${r.isMain ? cell : `<a href="#/s/${encodeURIComponent(r.symbol)}">${cell}</a>`}</td>${cols.map((c) => `<td>${fmtMetric(c, r[c.key], cur)}</td>`).join('')}</tr>`;
    };
    const avgTr = `<tr class="avg"><td><span class="pcell"><span class="ptxt"><b>Industry average</b><span class="pname">${nPeers} industry peers</span></span></span></td>${cols.map((c) => `<td>${fmtMetric(c, cmp.avgRow[c.key], cur)}</td>`).join('')}</tr>`;
    const table = `<div class="peer-table-wrap"><table class="peer-table">
      <thead><tr><th>Company</th>${cols.map((c) => `<th>${c.label}</th>`).join('')}</tr></thead>
      <tbody>${cmp.rows.map(row).join('')}${avgTr}</tbody></table></div>
      <div class="scroll-hint">← Swipe the table to see all columns →</div>`;
    const btns = cols.filter((c) => c.key !== 'marketCap').map((c, i) => `<button data-k="${c.key}" class="${i === 0 ? 'on' : ''}">${c.name.toUpperCase()}</button>`).join('');
    const cn = countryName(marketOf(m.symbol)), loc = cn ? `, ${esc(cn)}` : '';
    const rule = '<b>#1</b> = best (lowest wins for Debt &amp; P/E).';
    const intro = level === 'industry'
      ? `Vs <b>${nPeers}</b> closest-size peers in <b>${esc(m.industry)}</b>${loc}. ${rule}`
      : level === 'sector'
        ? `Vs <b>${nPeers}</b> peers from the wider <b>${esc(m.sector)}</b> sector${loc}. ${rule}`
        : `Vs <b>${nPeers}</b> similar companies suggested by Yahoo. ${rule}`;
    $('#peerWrap').innerHTML = `
      <p class="peer-intro">${intro}</p>
      <div class="rank-grid">${tiles}</div>
      <div class="chart-card wide peer-chart">
        <h3>Head to Head<div class="toggle" id="peerToggle">${btns}</div></h3>
        <div class="chart-box" id="box-chPeer"><canvas id="chPeer"></canvas></div>
      </div>
      ${table}`;
    const draw = (key) => {
      resetBox('chPeer');
      const mt = A.PEER_METRICS.find((x) => x.key === key);
      const rows = [...cmp.rows, ...(isNum(cmp.avgRow[key]) ? [cmp.avgRow] : [])].filter((r) => isNum(r[key]))
        .sort((a, b) => (mt.better === 'high' ? b[key] - a[key] : a[key] - b[key]));
      if (!rows.length) return noData('chPeer');
      const val = (v) => (mt.fmt === 'pct' ? +(v * 100).toFixed(2) : +v.toFixed(2));
      const unit = mt.fmt === 'pct' ? '%' : '×';
      const C = tc(), bg = (r) => (r.isMain ? C.accent : r.isAvg ? C.accent2 : C.line2);
      mk('chPeer', { type: 'bar',
        data: { labels: rows.map((r) => (r.isAvg ? 'Industry average' : clip(r.name, isMobile() ? 16 : 28))), datasets: [{ label: mt.label, data: rows.map((r) => val(r[key])),
          backgroundColor: rows.map(bg), borderColor: rows.map((r) => (r.isMain ? C.accent : r.isAvg ? C.accent2 : C.dim)), borderWidth: 1, borderRadius: 2, maxBarThickness: 26 }] },
        options: { indexAxis: 'y', plugins: { legend: { display: false }, tooltip: { callbacks: { label: (x) => `${mt.label}: ${x.parsed.x}${unit}` } } },
          scales: { x: { ticks: { maxTicksLimit: isMobile() ? 4 : 8, callback: (v) => v + unit } }, y: { grid: { display: false }, ticks: { color: C.text, autoSkip: false } } } } });
    };
    draw(cols.find((c) => c.key !== 'marketCap').key);
    window.__plutusPeerRedraw = () => { const on = $('#peerToggle button.on'); if (on && $('#box-chPeer')) draw(on.dataset.k); };
    $('#peerToggle').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; $('#peerToggle').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); draw(b.dataset.k); });
  }

  /* ---------- charts ---------- */
  // Chart colours come from the same CSS tokens as the page (css/style.css), so they follow the light / dark theme
  let tcCache = null;
  function tc() {
    const theme = document.documentElement.getAttribute('data-theme') || 'light';
    if (tcCache && tcCache.theme === theme) return tcCache;
    const cs = getComputedStyle(document.documentElement), v = (n) => cs.getPropertyValue(n).trim();
    return (tcCache = { theme, accent: v('--accent'), accent2: v('--accent-2'), good: v('--good'), warn: v('--warn'), bad: v('--bad'),
      text: v('--text'), hi: v('--hi'), muted: v('--muted'), dim: v('--dim'), line2: v('--line-2'), grid: v('--grid'), tipBg: v('--tip-bg') });
  }
  function destroyCharts() { state.charts.forEach((c) => c.destroy()); state.charts = []; }
  // Rebuild every chart for the current theme / screen size, keeping the toggles the visitor picked
  function redrawCharts() {
    if (!state.model || $('#dashContent').classList.contains('hidden')) return;
    const on = (id, k) => { const b = $(`#${id} button.on`); return b ? b.dataset[k] : undefined; };
    const sel = { price: on('priceToggle', 'r'), period: on('periodToggle', 'p') };
    destroyCharts(); drawCharts(state.model, sel);
    if (window.__plutusPeerRedraw) window.__plutusPeerRedraw();
  }
  function setupChartDefaults() {
    if (!window.Chart) return;
    const mob = isMobile(), C = tc();
    Chart.defaults.color = C.muted;
    Chart.defaults.font.family = '"Helvetica Neue", Helvetica, Arial, sans-serif';
    Chart.defaults.font.size = mob ? 10 : 11;
    Chart.defaults.borderColor = C.grid;
    Chart.defaults.plugins.legend.position = 'top';
    Chart.defaults.plugins.legend.labels.boxWidth = 10;
    Chart.defaults.plugins.legend.labels.boxHeight = 10;
    Chart.defaults.plugins.legend.labels.padding = mob ? 8 : 12;
    Chart.defaults.plugins.tooltip.backgroundColor = C.tipBg;
    Chart.defaults.plugins.tooltip.titleColor = C.text;
    Chart.defaults.plugins.tooltip.bodyColor = C.text;
    Chart.defaults.plugins.tooltip.borderColor = C.accent;
    Chart.defaults.plugins.tooltip.borderWidth = 1;
    Chart.defaults.plugins.tooltip.padding = 10;
    Chart.defaults.maintainAspectRatio = false;
    Chart.defaults.responsive = true;
  }
  const grad = (hex, a1 = 0.35) => (ctx) => {
    const { chart } = ctx; const { ctx: g, chartArea } = chart;
    if (!chartArea) return 'transparent';
    const gr = g.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
    gr.addColorStop(0, hex + Math.round(a1 * 255).toString(16).padStart(2, '0')); gr.addColorStop(1, hex + '00');
    return gr;
  };
  const dLabel = (t, withDay) => new Date(t).toLocaleDateString('en-GB', withDay ? { day: '2-digit', month: 'short', year: '2-digit' } : { month: 'short', year: '2-digit' });
  function resetBox(id) {
    const old = state.charts.find((x) => x.canvas && x.canvas.id === id);
    if (old) { old.destroy(); state.charts = state.charts.filter((x) => x !== old); }
    const box = document.getElementById('box-' + id); if (box) box.innerHTML = `<canvas id="${id}"></canvas>`;
  }
  function setTake(id, text) { const el = document.getElementById('tk-' + id); if (!el) return; el.textContent = text || ''; el.classList.toggle('hidden', !text); }
  function noData(id, msg) {
    const cv = document.getElementById(id); if (!cv) return;
    cv.parentElement.innerHTML = `<div class="nodata">${esc(msg || 'No data available')}</div>`;
  }
  function mk(id, cfg) {
    const cv = document.getElementById(id); if (!cv || !window.Chart) return null;
    const ch = new Chart(cv, cfg); state.charts.push(ch); return ch;
  }
  const anyNum = (arr) => (arr || []).some(isNum);
  const findChart = (id) => state.charts.find((c) => c.canvas && c.canvas.id === id);

  // Industry-average overlay on the P/E chart (added once the peers have loaded)
  const peIndDataset = (len, v) => ({ label: 'Industry avg P/E', data: Array.from({ length: len }, () => +v.toFixed(2)), borderColor: tc().good, borderDash: [2, 4], borderWidth: 1.3, pointRadius: 0, isInd: true });
  const marginIndDataset = (labels, v) => ({ label: 'Industry net margin', data: labels.map(() => +(v * 100).toFixed(2)), borderColor: tc().hi, borderDash: [5, 5], borderWidth: 1, pointRadius: 0, isInd: true });
  function refreshIndustryCharts() { syncCompareCharts(); }

  // sel: which toggles are selected ({ price: '1y'|'5y', period: 'annual'|'quarterly' }) — kept when charts are redrawn
  function drawCharts(m, sel) {
    sel = sel || {};
    setupChartDefaults();
    const pc = m.currency, mob = isMobile(), C = tc();
    const hasInd = !!state.ind;
    // Price
    const drawPrice = (range) => {
      resetBox('chPrice');
      const pts = range === '1y' ? m.priceDaily : m.priceWeekly;
      if (!pts.length) return noData('chPrice');
      const up = pts[pts.length - 1].v >= pts[0].v, col = up ? C.good : C.bad;
      mk('chPrice', {
        type: 'line',
        data: { labels: pts.map((p) => dLabel(p.t, range === '1y')), datasets: [{ label: 'Price', data: pts.map((p) => p.v), borderColor: col, backgroundColor: grad(col, 0.28), fill: true, borderWidth: 1.6, pointRadius: 0, tension: 0.15 }] },
        options: { interaction: { mode: 'index', intersect: false }, plugins: { legend: { display: false }, tooltip: { callbacks: { label: (x) => fmtPrice(x.parsed.y, pc) } } },
          scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: mob ? 4 : 8, maxRotation: 0 } }, y: { position: 'right', ticks: { maxTicksLimit: mob ? 5 : 8, callback: (v) => fmtPrice(v, pc).replace(/\.00$/, '') } } } }
      });
    };
    drawPrice(sel.price || '5y');
    const tg = $('#priceToggle');
    // onclick (not addEventListener): a redraw (theme switch, breakpoint change) replaces the handler instead of stacking another
    if (tg) tg.onclick = (e) => { const b = e.target.closest('button'); if (!b) return; tg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); drawPrice(b.dataset.r); };
    // P/E history
    if (m.peHistory.length > 5) {
      const ph = m.peHistory;
      mk('chPE', { type: 'line',
        data: { labels: ph.map((p) => dLabel(p.t)), datasets: [
          { label: 'P/E', data: ph.map((p) => +p.v.toFixed(2)), borderColor: C.accent2, backgroundColor: grad(C.accent2, 0.22), fill: true, borderWidth: 1.6, pointRadius: 0, tension: 0.15 },
          { label: '5-yr median', data: ph.map(() => +m.peMedian.toFixed(2)), borderColor: C.warn, borderDash: [6, 6], borderWidth: 1, pointRadius: 0 },
          ...(cmpActive() && hasInd && isNum(state.ind.avg.pe) ? [peIndDataset(ph.length, state.ind.avg.pe)] : [])] },
        options: { interaction: { mode: 'index', intersect: false }, plugins: { tooltip: { callbacks: { label: (x) => `${x.dataset.label}: ${x.parsed.y.toFixed(1)}×` } } },
          scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: mob ? 4 : 8, maxRotation: 0 } }, y: { position: 'right', ticks: { maxTicksLimit: mob ? 5 : 8, callback: (v) => v + '×' } } } } });
    } else noData('chPE', m.negEarnings ? 'Not meaningful — company has losses' : !m.sameCur ? 'Hidden — currency mismatch' : 'Not enough earnings history');

    drawBusiness(m, sel.period || 'annual');
    const pt = $('#periodToggle');
    if (pt) pt.onclick = (e) => {
      const b = e.target.closest('button'); if (!b) return;
      pt.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      drawBusiness(m, b.dataset.p);
    };
  }

  function quarterTakeaways(m) {
    const q = m.quarterly, t = {}, c = m.finCurrency, n = q.revenue.length;
    const yoy = (arr) => (n >= 5 && isNum(arr[n - 1]) && isNum(arr[n - 5]) && arr[n - 5] > 0 ? arr[n - 1] / arr[n - 5] - 1 : null);
    if (n) {
      const rg = yoy(q.revenue), ng = yoy(q.netIncome);
      t.revenue = `Latest quarter (${q.labels[n - 1]}): revenue ${fmtMoney(q.revenue[n - 1], c)}, net profit ${fmtMoney(q.netIncome[n - 1], c)}` +
        (isNum(rg) ? ` · revenue ${fmtPct(rg, 1, true)} vs same quarter last year` : '') + (isNum(ng) ? `, profit ${fmtPct(ng, 1, true)}` : '') + '.';
      if (isNum(q.netMarginS[n - 1])) t.margins = `Net margin in the latest quarter: ${fmtPct(q.netMarginS[n - 1])}${n >= 5 && isNum(q.netMarginS[n - 5]) ? ` (same quarter last year ${fmtPct(q.netMarginS[n - 5])})` : ''}.`;
      if (isNum(q.eps[n - 1])) t.eps = `Latest quarterly EPS: ${q.eps[n - 1].toFixed(2)} ${c}${n >= 5 && isNum(q.eps[n - 5]) ? ` vs ${q.eps[n - 5].toFixed(2)} a year earlier` : ''}.`;
    }
    t.cash = anyNum(q.ocf) ? '' : 'Many companies (including most Indian listings) publish cash flow only half-yearly or yearly — switch to Yearly.';
    t.debt = anyNum(q.debt) ? '' : 'Quarterly balance-sheet data isn’t published for this company — switch to Yearly.';
    return t;
  }

  function drawBusiness(m, period) {
    const c = m.finCurrency, mob = isMobile(), C = tc();
    const D = period === 'quarterly' ? m.quarterly : m.annual, L = D.labels;
    const moneyTick = { maxTicksLimit: mob ? 5 : 7, callback: (v) => fmtMoney(v, c) };
    const moneyTip = { callbacks: { label: (x) => `${x.dataset.label}: ${fmtMoney(x.parsed.y, c)}` } };
    const xs = { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true } };
    const bar = mob ? 18 : 34;
    ['chRev', 'chMargin', 'chEPS', 'chCash', 'chDebt'].forEach(resetBox);
    const note = $('#periodNote');
    if (note) note.textContent = period === 'quarterly' ? `Quarterly · last ${L.length} reported quarters` : `Yearly · last ${L.length} financial years`;
    const T = period === 'quarterly' ? quarterTakeaways(m) : m.takeaways;
    setTake('chRev', T.revenue); setTake('chMargin', T.margins); setTake('chEPS', T.eps); setTake('chCash', T.cash); setTake('chDebt', T.debt);
    const nd = period === 'quarterly' ? 'No quarterly data published' : 'No data available';
    const negCol = (arr, pos) => arr.map((v) => (isNum(v) && v < 0 ? C.bad : pos));

    if (anyNum(D.revenue) || anyNum(D.netIncome)) mk('chRev', { type: 'bar',
      data: { labels: L, datasets: [
        { label: 'Revenue', data: D.revenue, backgroundColor: C.accent, borderRadius: 2, maxBarThickness: bar },
        { label: 'Net Profit', data: D.netIncome, backgroundColor: negCol(D.netIncome, C.good), borderRadius: 2, maxBarThickness: bar }] },
      options: { plugins: { tooltip: moneyTip }, scales: { x: xs, y: { ticks: moneyTick } } } });
    else noData('chRev', nd);

    const pctData = (arr) => arr.map((v) => (isNum(v) ? +(v * 100).toFixed(2) : null));
    const mSets = [['Gross', D.grossMarginS, C.accent2], ['Operating', D.opMarginS, C.accent], ['Net', D.netMarginS, C.good]]
      .filter(([, a]) => anyNum(a)).map(([l, a, col]) => ({ label: l, data: pctData(a), borderColor: col, backgroundColor: col, borderWidth: 2, pointRadius: mob ? 2 : 3, tension: 0.25, spanGaps: true }));
    if (cmpActive() && state.ind && period === 'annual' && isNum(state.ind.avg.nm) && mSets.length) {
      mSets.push(marginIndDataset(L, state.ind.avg.nm));
    }
    if (mSets.length) mk('chMargin', { type: 'line', data: { labels: L, datasets: mSets },
      options: { plugins: { tooltip: { callbacks: { label: (x) => `${x.dataset.label}: ${x.parsed.y.toFixed(1)}%` } } }, scales: { x: xs, y: { ticks: { maxTicksLimit: 6, callback: (v) => v + '%' } } } } });
    else noData('chMargin', nd);

    if (anyNum(D.eps)) mk('chEPS', { type: 'bar',
      data: { labels: L, datasets: [{ label: 'EPS (' + c + ')', data: D.eps, backgroundColor: negCol(D.eps, C.accent2), borderRadius: 2, maxBarThickness: mob ? 24 : 40 }] },
      options: { plugins: { legend: { display: false } }, scales: { x: xs, y: { ticks: { maxTicksLimit: 6 } } } } });
    else noData('chEPS', nd);

    if (anyNum(D.ocf) || anyNum(D.fcf)) mk('chCash', { type: 'bar',
      data: { labels: L, datasets: [
        { label: 'Operating Cash Flow', data: D.ocf, backgroundColor: C.accent, borderRadius: 2, maxBarThickness: bar },
        { label: 'Free Cash Flow', data: D.fcf, backgroundColor: negCol(D.fcf, C.good), borderRadius: 2, maxBarThickness: bar }] },
      options: { plugins: { tooltip: moneyTip }, scales: { x: xs, y: { ticks: moneyTick } } } });
    else noData('chCash', nd);

    // Debt vs Equity: this card is full-width, so with a fixed max bar width Chart.js would centre each bar in a much
    // wider slot and leave a big gap between the pair. Sizing the group to the bar width keeps the two bars side by
    // side, exactly like Revenue vs Net Profit.
    if (anyNum(D.debt) || anyNum(D.equity)) {
      const boxW = (document.getElementById('box-chDebt') || {}).clientWidth || 600;
      const slot = Math.max(40, (boxW - 70) / Math.max(1, L.length));
      const barPct = 0.9;
      const catPct = Math.min(0.8, Math.max(0.2, (2 * bar) / (barPct * slot)));
      mk('chDebt', { type: 'bar',
        data: { labels: L, datasets: [
          { label: 'Total Debt', data: D.debt, backgroundColor: C.bad, borderRadius: 2, maxBarThickness: bar, barPercentage: barPct, categoryPercentage: catPct },
          { label: 'Shareholders’ Equity', data: D.equity, backgroundColor: C.good, borderRadius: 2, maxBarThickness: bar, barPercentage: barPct, categoryPercentage: catPct }] },
        options: { plugins: { tooltip: moneyTip }, scales: { x: xs, y: { ticks: moneyTick } } } });
    } else noData('chDebt', nd);
  }

  // Redraw charts when crossing the mobile/desktop breakpoint (rotation, window resize)
  let lastMob = null, rT = null;
  window.addEventListener('resize', () => {
    clearTimeout(rT);
    rT = setTimeout(() => {
      const mob = isMobile();
      if (lastMob !== null && mob !== lastMob) redrawCharts();
      lastMob = mob;
    }, 200);
  });

  /* ====================== THEME (light / dark) ======================
     Light is the default. index.html sets data-theme on <html> before the page is drawn (from the saved choice);
     this switch flips it, remembers it, and redraws the charts in the new colours. */
  const THEME_KEY = 'plutus.theme.v1';
  const THEME_BAR = { light: '#f6f3ec', dark: '#000000' }; // browser / phone status-bar colour
  function setTheme(t, save) {
    const root = document.documentElement;
    root.classList.add('theme-switching'); // no colour transitions mid-switch
    root.setAttribute('data-theme', t);
    const meta = document.querySelector('meta[name="theme-color"]'); if (meta) meta.setAttribute('content', THEME_BAR[t]);
    const b = $('#themeBtn');
    if (b) { const next = t === 'dark' ? 'light' : 'dark'; b.setAttribute('aria-label', `Switch to ${next} mode`); b.dataset.tip = next === 'dark' ? 'Dark mode' : 'Light mode'; }
    if (save) { try { localStorage.setItem(THEME_KEY, t); } catch (e) { /* private mode: just not remembered */ } }
    redrawCharts();
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('theme-switching')));
  }
  function initThemeSwitch() {
    const b = $('#themeBtn'); if (!b) return;
    setTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light', false);
    b.addEventListener('click', () => setTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark', true));
  }

  /* ====================== INIT ====================== */
  function init() {
    lastMob = isMobile();
    initThemeSwitch();
    attachSearch($('#mainSearch'), $('#mainSuggest'));
    attachSearch($('#miniSearch'), $('#miniSuggest'));
    const mini = $('#miniSearch'), mq = window.matchMedia('(max-width: 640px)');
    const ph = () => { mini.placeholder = mq.matches ? 'Search…' : 'Search another company…'; };
    ph(); if (mq.addEventListener) mq.addEventListener('change', ph);
    initCompareSwitch();
    $('#quickChips').addEventListener('click', (e) => { const b = e.target.closest('button[data-s]'); if (b) location.hash = '#/s/' + encodeURIComponent(b.dataset.s); });
    window.addEventListener('hashchange', route);
    route();
  }
  document.addEventListener('DOMContentLoaded', init);
})();
