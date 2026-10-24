/* ============================================================
   PLUTUS — "Latest In News" sidebar (self-contained add-on)
   ------------------------------------------------------------
   Shows at most 10 headlines for the stock being viewed, in this order:
     1) up to 5 about the COMPANY (first);
     2) up to 5 about its INDUSTRY / sector (after the company ones).
   Headlines that help an investor understand the business (results,
   deals, demand, regulation, outlook) are preferred over price chatter,
   then newest first. If one side has fewer than 5, the other side fills
   the gap (still 10 at most, company headlines always listed first).
   v5: headlines come from Bing News RSS (free, no API key) through the
   same Cloudflare Worker. Each headline gets a thumbnail:
     1) the picture supplied by the feed itself, else
     2) the article's own og:image, fetched by the Worker (?og=...).
   The company name / industry (used only to build the search words)
   still come from the Yahoo profile lookup already used by the site.
   It reads the stock from the page address (#/s/SYMBOL).
   ============================================================ */
(function () {
  'use strict';
  const CFG = window.APP_CONFIG || {};
  const PER_SIDE = 5;           // target headlines about the company, and the same number about its industry
  const TOTAL = PER_SIDE * 2;   // never more than 10 headlines in total
  const FETCH_COUNT = 15;       // asked of Bing per query (Bing returns about 10-14), then sorted by time and trimmed
  const CACHE_MS = 10 * 60e3;   // browser-side cache per query
  const YH = 'https://query2.finance.yahoo.com';
  const BING = 'https://www.bing.com/news/search';
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const workerBase = () => (CFG.WORKER_URL || '').replace(/\/+$/, '');

  /* ---------- where is the company listed? (used to keep industry news local) ---------- */
  const MARKETS = {
    NS: 'India', BO: 'India', L: 'United Kingdom', T: 'Japan', HK: 'Hong Kong', DE: 'Germany', F: 'Germany', TO: 'Canada', V: 'Canada',
    AX: 'Australia', PA: 'France', MI: 'Italy', MC: 'Spain', AS: 'Netherlands', SW: 'Switzerland', ST: 'Sweden', SS: 'China', SZ: 'China',
    KS: 'South Korea', TW: 'Taiwan', SI: 'Singapore', SA: 'Brazil', JO: 'South Africa'
  };
  const listingCountry = (sym) => { const i = sym.lastIndexOf('.'); return i < 0 ? '' : (MARKETS[sym.slice(i + 1).toUpperCase()] || ''); }; // '' = US / unknown
  const isIndia = (sym) => /\.(NS|BO)$/i.test(sym);
  const baseTicker = (sym) => sym.replace(/\.[A-Za-z]+$/, '');
  const marketOf = (sym) => (isIndia(sym) ? 'en-IN' : 'en-US');

  /* ---------- data ---------- */
  // Fetch through the Worker (or the public CORS proxies if no Worker is set); text = true for RSS/XML
  async function getData(url, text) {
    const key = 'plutus:news:' + (text ? 't:' : 'j:') + url;
    try { const c = JSON.parse(sessionStorage.getItem(key)); if (c && Date.now() - c.t < CACHE_MS) return c.d; } catch (e) { /* ignore */ }
    // after a network-type error (TypeError), ask for a fresh copy: older Workers broke CORS on every edge-cache hit
    const bust = (u, on) => (on ? u + (u.includes('?') ? '&' : '?') + '_pb=' + Date.now().toString(36) : u);
    const routes = CFG.WORKER_URL
      ? [(fresh) => workerBase() + '/?url=' + encodeURIComponent(bust(url, fresh))]
      : (CFG.PUBLIC_PROXIES || []).map((p) => () => p + encodeURIComponent(url));
    let lastErr = new Error('No data route configured');
    // busy (429) / 5xx / timeouts / network blips: up to 3 tries with growing, jittered waits (Retry-After honoured)
    for (const route of routes) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const r = route(attempt > 0 && lastErr instanceof TypeError);
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), CFG.REQUEST_TIMEOUT_MS || 15000);
        let wait = 0;
        try {
          const res = await fetch(r, { signal: ctrl.signal });
          if (!res.ok) { const er = new Error('HTTP ' + res.status); er.retry = res.status === 429 || res.status >= 500; er.after = parseFloat(res.headers.get('Retry-After')) || 0; throw er; }
          const d = text ? await res.text() : await res.json();
          try { sessionStorage.setItem(key, JSON.stringify({ t: Date.now(), d })); } catch (e) { /* quota */ }
          return d;
        } catch (e) {
          lastErr = e;
          if (!(e.retry || e.name === 'AbortError' || e instanceof TypeError || e instanceof SyntaxError) || attempt === 2) break;
          wait = e.after > 0 ? Math.min(e.after * 1000, 10000) : 900 * 2 ** attempt + Math.random() * 500;
        } finally { clearTimeout(timer); }
        await sleep(wait);
      }
    }
    // everything failed: an older copy from this tab is better than "News is unavailable"
    try { const c = JSON.parse(sessionStorage.getItem(key)); if (c && c.d) return c.d; } catch (e) { /* ignore */ }
    throw lastErr;
  }

  const normTitle = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  /* ---------- relevance checks ----------
     A news search matches words ANYWHERE in an article, so a market round-up that merely mentions the
     company (or a different company with a similar name) can slip in. Every headline is therefore checked
     before it is shown:
       - company news: the TITLE must name the company (full name, short name or ticker);
       - industry news: the TITLE must contain a keyword of the industry. */
  const GENERIC = new Set(['limited', 'ltd', 'inc', 'incorporated', 'corporation', 'corp', 'plc', 'company', 'co', 'pvt', 'private', 'llc', 'ag', 'nv', 'sa', 'the', 'of', 'and']);
  const TAIL = new Set(['india', 'indian', 'industries', 'industry', 'group', 'holdings', 'international', 'global', 'enterprises', 'services', 'technologies', 'technology', 'ltd', 'limited']);
  // first words shared by many unrelated companies: never accept these alone
  const BIG_PREFIX = new Set(['tata', 'bajaj', 'reliance', 'adani', 'mahindra', 'birla', 'aditya', 'larsen', 'hdfc', 'icici', 'axis', 'state', 'bank', 'hindustan', 'godrej', 'jindal', 'bharat', 'indian', 'national', 'general', 'united', 'american', 'first', 'great', 'new', 'jio', 'sun', 'power', 'oil', 'gas', 'coal', 'steel', 'life', 'max', 'kotak', 'punjab', 'canara', 'union', 'central', 'south', 'north', 'east', 'west', 'asian', 'indus', 'shree', 'sri', 'jai']);
  function companyAliases(name, sym) {
    const words = normTitle(name).split(' ').filter((w) => w && !GENERIC.has(w));
    const out = new Set();
    if (words.length) {
      out.add(words.join(' '));
      const w2 = words.slice(); while (w2.length > 1 && TAIL.has(w2[w2.length - 1])) w2.pop(); // "Hyundai Motor India" -> "Hyundai Motor"
      out.add(w2.join(' '));
      if (words.length > 1) out.add(words.slice(0, 2).join(' '));
      if (words[0].length >= 5 && !BIG_PREFIX.has(words[0])) out.add(words[0]);            // "Hyundai" is distinctive; "Tata" is not
    }
    return { names: Array.from(out).filter((a) => a.length >= 3), ticker: baseTicker(sym) };
  }
  function isAboutCompany(title, al) {
    const t = ' ' + normTitle(title);
    if (al.names.some((a) => t.includes(' ' + a))) return true;
    return al.ticker.length >= 3 && new RegExp('(^|[^A-Za-z0-9])' + al.ticker.replace(/[^A-Za-z0-9]/g, '') + '($|[^A-Za-z0-9])').test(String(title)); // ticker: exact upper-case word
  }
  const IND_WEAK = new Set(['manufacturers', 'manufacturing', 'services', 'service', 'general', 'specialty', 'diversified', 'regional', 'equipment', 'products', 'other', 'and', 'the', 'application', 'infrastructure', 'distribution', 'management', 'defensive', 'cyclical']);
  const IND_SYN = { auto: ['auto', 'car', 'cars', 'vehicle', 'vehicles', 'ev', 'evs', 'automobile', 'automaker', 'automakers', 'suv'], banks: ['bank', 'banks', 'banking', 'lender', 'lenders'], bank: ['bank', 'banks', 'banking', 'lender', 'lenders'], drug: ['drug', 'drugs', 'pharma', 'pharmaceutical', 'pharmaceuticals', 'medicine'], oil: ['oil', 'crude', 'petroleum', 'refinery', 'refining', 'fuel'], telecom: ['telecom', 'telecommunications', 'mobile', '5g', 'spectrum', 'broadband'], software: ['software', 'saas', 'tech', 'cloud'], information: ['software', 'tech', 'technology', 'digital', 'it services'], semiconductors: ['chip', 'chips', 'semiconductor', 'semiconductors'], insurance: ['insurance', 'insurer', 'insurers'], steel: ['steel'], utilities: ['power', 'electricity', 'utility', 'utilities'], airlines: ['airline', 'airlines', 'flight', 'flights', 'aviation'], tobacco: ['tobacco', 'cigarette', 'cigarettes'], beverages: ['beverage', 'beverages', 'drinks'], cement: ['cement'] };
  function industryKeywords(label) {
    const words = normTitle(label).split(' ').filter((w) => w.length > 1 && !IND_WEAK.has(w));
    const kw = new Set();
    words.forEach((w) => { (IND_SYN[w] || [w, w.replace(/(ies|es|s)$/, '')]).forEach((k) => k.length > 1 && kw.add(k)); });
    return Array.from(kw);
  }
  const isAboutIndustry = (title, kws) => !kws.length || kws.some((k) => (' ' + normTitle(title) + ' ').includes(' ' + k + ' ') || (k.length >= 5 && (' ' + normTitle(title)).includes(' ' + k)));

  // Bing wraps every link: bing.com/news/apiclick.aspx?...&url=<publisher link>. Unwrap to the real article address.
  function realLink(l) {
    try {
      const u = new URL(l);
      if (/(^|\.)bing\.com$/i.test(u.hostname)) {
        const t = u.searchParams.get('url');
        if (t && /^https?:\/\//i.test(t)) return t;
      }
    } catch (e) { /* keep as is */ }
    return l;
  }
  function fixImg(s) {
    s = String(s || '').trim();
    if (!s) return '';
    if (s.startsWith('//')) s = 'https:' + s;
    else if (s.startsWith('/')) s = 'https://www.bing.com' + s;
    return /^https?:\/\//i.test(s) ? s.replace(/^http:\/\//i, 'https://') : '';
  }
  // Bing News RSS -> [{ id, title, link, publisher, time, img }]
  function parseNews(xml) {
    if (!xml || xml.indexOf('<item') < 0) return [];
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    if (doc.querySelector('parsererror')) return [];
    return Array.from(doc.querySelectorAll('item')).map((it) => {
      const txt = (name, local) => {
        const e = it.getElementsByTagName(name)[0] || (local && it.getElementsByTagNameNS('*', local)[0]);
        return e ? (e.textContent || '').trim() : '';
      };
      const enc = it.getElementsByTagName('enclosure')[0];
      const link = realLink(txt('link'));
      const pub = Date.parse(txt('pubDate'));
      return {
        id: link, title: txt('title'), link,
        publisher: txt('News:Source', 'Source'),
        time: isFinite(pub) ? pub : 0,
        img: fixImg(txt('News:Image', 'Image') || (enc && enc.getAttribute('url')))
      };
    }).filter((n) => n.title && /^https?:\/\//i.test(n.link));
  }
  // Merge lists, drop duplicates (same link or same headline), newest first
  function mergeNews(lists, exclude) {
    const seen = new Set((exclude || []).flatMap((x) => [x.id, normTitle(x.title)]));
    const out = [];
    for (const it of lists.flat().sort((a, b) => b.time - a.time)) {
      const k = normTitle(it.title);
      if (seen.has(it.id) || seen.has(k)) continue;
      seen.add(it.id); seen.add(k); out.push(it);
    }
    return out;
  }
  const searchNews = (q, sym) =>
    getData(`${BING}?q=${encodeURIComponent(q)}&format=rss&setmkt=${marketOf(sym)}&count=${FETCH_COUNT}&qft=${encodeURIComponent('sortbydate="1"')}`, true).then(parseNews);

  const profileOf = (sym) => getData(`${YH}/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=price,assetProfile`).then((r) => {
    const s = (r && r.quoteSummary && r.quoteSummary.result && r.quoteSummary.result[0]) || {};
    const pr = s.price || {}, ap = s.assetProfile || {};
    return { name: pr.longName || pr.shortName || '', industry: ap.industry || '', sector: ap.sector || '' };
  });

  // ---- search words ----
  const stripLegal = (n) => String(n || '').replace(/\b(limited|ltd|incorporated|inc|corporation|corp|plc|company|co|pvt|private|llc|ag|nv)\b\.?/gi, ' ').replace(/[.,]+/g, ' ').replace(/\s+/g, ' ').trim();
  const companyQuery = (name, sym) => (stripLegal(name) ? `"${stripLegal(name)}" ${isIndia(sym) ? 'shares' : 'stock'}` : tickerQuery(sym));
  const tickerQuery = (sym) => `${baseTicker(sym)} ${isIndia(sym) ? 'share price' : 'stock'}`;
  // "Banks - Regional" -> "Banks Regional industry India"
  const industryQuery = (industry, country) => `${industry.replace(/[&\-\u2013\u2014/,]+/g, ' ').replace(/\s+/g, ' ').trim()} industry${country ? ' ' + country : ''}`;

  /* ---------- thumbnails ---------- */
  // Ask the Worker for the article's own picture (og:image). Cached in the browser; "" = none found.
  async function ogImage(link) {
    if (!workerBase()) return '';
    const key = 'plutus:og:' + link;
    try { const c = JSON.parse(sessionStorage.getItem(key)); if (c && typeof c.d === 'string') return c.d; } catch (e) { /* ignore */ }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 9000);
    try {
      const res = await fetch(workerBase() + '/?og=' + encodeURIComponent(link), { signal: ctrl.signal });
      if (!res.ok) return '';
      const d = await res.json();
      const img = fixImg(d && d.image);
      try { sessionStorage.setItem(key, JSON.stringify({ d: img })); } catch (e) { /* quota */ }
      return img;
    } catch (e) { return ''; } finally { clearTimeout(timer); }
  }
  const thumbHTML = (src) => `<span class="ni-img"><img src="${esc(src)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer"></span>`;
  // After the list is drawn, add pictures to the rows that came without one
  function backfillThumbs(items) {
    const mySeq = seq;
    items.filter((n) => !n.img && !n.imgTried).forEach(async (n) => {
      n.imgTried = true;
      const img = await ogImage(n.link);
      if (!img || mySeq !== seq) return;
      n.img = img;
      const a = Array.from(document.querySelectorAll('#newsBody a.news-item')).find((el) => el.dataset.id === n.id);
      if (a && !a.querySelector('.ni-img')) a.insertAdjacentHTML('beforeend', thumbHTML(img));
    });
  }

  /* ---------- investor usefulness ----------
     Headlines that explain the business (results, deals, demand, regulation, outlook) rank above
     generic price chatter. Within the same score, the newest headline wins. */
  const INVEST_RE = /\b(earnings|results?|profit|revenue|sales|quarter|q[1-4]|guidance|outlook|forecast|dividend|buyback|acquisition|acquires?|merger|stake|deal|order|contract|expansion|capacity|plant|launch|investment|invests?|capex|strategy|plan|margins?|costs?|demand|growth|market share|debt|funding|ipo|regulat\w*|polic(?:y|ies)|tariffs?|rates?|supply|exports?|imports?|rating|upgrade|downgrade|target)\b/i;
  const NOISE_RE = /\b(share price today|stock price today|live updates?|live blog|stocks? to buy|buy or sell|top gainers|top losers|horoscope|sensex today|nifty today)\b/i;
  const usefulness = (n) => (INVEST_RE.test(n.title) ? 2 : 0) - (NOISE_RE.test(n.title) ? 3 : 0);
  const bestOf = (list, n) => list.slice().sort((a, b) => usefulness(b) - usefulness(a) || b.time - a.time).slice(0, Math.max(0, n)).sort((a, b) => b.time - a.time);

  /* ---------- display ---------- */
  function ago(ms) {
    if (!ms) return '';
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 3600) return Math.max(1, Math.round(s / 60)) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    if (s < 7 * 86400) return Math.round(s / 86400) + ' d ago';
    return new Date(ms).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
  }
  const itemHTML = (n) => `<li><a class="news-item" data-id="${esc(n.id)}" href="${esc(n.link)}" target="_blank" rel="noopener noreferrer">
      <span class="ni-txt"><span class="ni-title">${esc(n.title)}</span>
        <span class="ni-meta"><span class="ni-tag ni-tag-${n.kind}">${n.kind === 'co' ? 'Company' : 'Industry'}</span>${n.publisher ? `<span class="ni-pub">${esc(n.publisher)}</span>` : ''}${n.time ? `<span class="ni-time">${esc(ago(n.time))}</span>` : ''}</span></span>
      ${n.img ? thumbHTML(n.img) : ''}
    </a></li>`;
  const skelItems = (n) => Array.from({ length: Math.max(0, n) }, () => '<li class="news-skel"><span></span><span></span></li>').join('');
  // items: headlines to show; pending: how many placeholder rows to add below them; note: optional message under the list
  function render(items, pending, note, retry) {
    const body = $('#newsBody'); if (!body) return;
    const list = items.length || pending ? `<ul class="news-list">${items.map(itemHTML).join('')}${skelItems(pending || 0)}</ul>` : '';
    body.innerHTML = list + (note ? `<p class="news-empty">${esc(note)}</p>` : '') + (retry ? '<button type="button" class="news-retry" data-retry="1">Try again</button>' : '');
    const cnt = $('#newsCount'); if (cnt) cnt.textContent = pending ? '' : items.length ? String(items.length) : ''; // headline count on the collapsed rail
    backfillThumbs(items);
  }
  function setSub(text) { const el = $('#newsSub'); if (el) el.textContent = text || ''; }

  /* ---------- controller ---------- */
  let seq = 0, current = '';
  async function load(sym) {
    const my = ++seq; current = sym;
    if (!$('#newsBody')) return;
    const country = listingCountry(sym);
    setSub(sym);
    render([], TOTAL);
    // the company name (from the Yahoo profile) makes a much better news search than the ticker
    const p = await profileOf(sym).catch(() => ({ name: '', industry: '', sector: '' }));
    if (my !== seq) return;
    const coName = p.name || sym;
    const label = p.industry || p.sector;
    setSub(coName);
    const alias = companyAliases(p.name, sym), onCo = (list) => list.filter((n) => isAboutCompany(n.title, alias));
    const onInd = (list, lbl) => { const k = industryKeywords(lbl); return list.filter((n) => isAboutIndustry(n.title, k)); };

    // company headlines (a candidate pool, trimmed below)
    const companyTask = (async () => {
      let list = [], failed = false;
      try { list = mergeNews([onCo(await searchNews(companyQuery(p.name, sym), sym))]); } catch (e) { failed = true; }
      if (list.length < PER_SIDE + 3) { // thin coverage: top up with a ticker search
        try { list = mergeNews([list, onCo(await searchNews(tickerQuery(sym), sym))]); failed = false; } catch (e) { /* keep what we have */ }
      }
      return { list, failed };
    })();

    // industry / sector headlines (a candidate pool, trimmed below)
    const industryTask = (async () => {
      if (!label) return { list: [], failed: false, shown: '', none: true };
      let lists = [], failed = false, shown = label;
      try { lists.push(onInd(await searchNews(industryQuery(label, country), sym), label)); } catch (e) { failed = true; }
      if (!lists.flat().length && p.industry && p.sector) { // nothing for the exact industry: widen to the sector
        try { lists = [onInd(await searchNews(industryQuery(p.sector, country), sym), p.sector)]; shown = p.sector; failed = false; } catch (e) { /* keep failed flag */ }
      }
      return { list: mergeNews(lists), failed, shown };
    })();

    const [co, ind] = await Promise.all([companyTask, industryTask]);
    if (my !== seq) return;

    // up to 5 each; if one side is short, the other fills the gap (never more than 10 in total)
    const indPool = mergeNews([ind.list], co.list);
    let coN = Math.min(PER_SIDE, co.list.length);
    let indN = Math.min(PER_SIDE, indPool.length);
    if (coN < PER_SIDE) indN = Math.min(indPool.length, TOTAL - coN);
    else if (indN < PER_SIDE) coN = Math.min(co.list.length, TOTAL - indN);
    const coItems = bestOf(co.list, coN).map((x) => ({ ...x, kind: 'co' }));
    const indItems = bestOf(indPool, indN).map((x) => ({ ...x, kind: 'ind' }));
    const all = coItems.concat(indItems).slice(0, TOTAL); // company headlines first, then industry

    if (indItems.length) setSub(`${coName} + ${ind.shown} industry${country ? ' \u00b7 ' + country : ''}`);
    const failed = co.failed || ind.failed;
    let note = '';
    if (!all.length) note = failed ? 'News is unavailable right now.' : 'No recent headlines found.';
    else if (ind.none) note = 'Industry information isn\u2019t available, so only company headlines are shown.';
    else if (failed && all.length < TOTAL) note = 'Some headlines couldn\u2019t be loaded.';
    render(all, 0, note, failed && all.length < TOTAL);
  }

  /* ---------- collapse (wide screens only) ----------
     On desktop / laptop widths the news is a sidebar. It starts COLLAPSED to a slim rail so the dashboard gets
     nearly the whole screen; the rail (or the » button in the header) opens / closes it. The choice holds while
     moving between stocks, and every new visit starts collapsed again. Below that width the news simply sits under
     the content and these controls are hidden by css/news.css. */
  const CHEV_L = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M15 6l-6 6 6 6"/></svg>';
  const CHEV_R = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M9 6l6 6-6 6"/></svg>';
  let collapsed = true;
  function setCollapsed(on, focus) {
    collapsed = on;
    const view = $('#viewDash'), rail = $('#newsRail'), btn = $('#newsCollapse');
    if (view) view.classList.toggle('news-collapsed', on);
    if (rail) rail.setAttribute('aria-expanded', on ? 'false' : 'true');
    if (btn) btn.setAttribute('aria-expanded', on ? 'false' : 'true');
    if (focus) { const t = on ? rail : btn; if (t) t.focus(); }
  }

  /* ---------- mount + routing ---------- */
  function mount() {
    const view = $('#viewDash');
    if (!view || $('#newsSide')) return;
    view.classList.add('has-news');
    view.insertAdjacentHTML('beforeend', `<aside class="news" id="newsSide" aria-label="Latest in news">
        <button type="button" class="news-rail" id="newsRail" aria-controls="newsSide" aria-expanded="false" aria-label="Show latest news" title="Show latest news">
          <span class="nr-ico">${CHEV_L}</span><span class="news-dot" aria-hidden="true"></span><span class="nr-label">Latest In News</span><span class="nr-count" id="newsCount"></span>
        </button>
        <div class="news-head"><span class="news-dot" aria-hidden="true"></span><h2>Latest In News</h2>
          <button type="button" class="news-collapse" id="newsCollapse" aria-controls="newsSide" aria-expanded="false" aria-label="Hide news" title="Hide news">${CHEV_R}</button></div>
        <p class="news-sub" id="newsSub"></p>
        <div class="news-body" id="newsBody"></div>
      </aside>`);
    setCollapsed(collapsed);
    $('#newsRail').addEventListener('click', () => setCollapsed(false, true));
    $('#newsCollapse').addEventListener('click', () => setCollapsed(true, true));
    $('#newsSide').addEventListener('click', (e) => { if (e.target.closest('[data-retry]') && current) load(current); });
    // broken thumbnails: just remove the picture
    $('#newsSide').addEventListener('error', (e) => { if (e.target instanceof HTMLImageElement) { const w = e.target.closest('.ni-img'); if (w) w.remove(); } }, true);
  }
  function route() {
    const m = location.hash.match(/^#\/s\/(.+)$/);
    if (!m) { seq++; current = ''; return; }
    load(decodeURIComponent(m[1]).toUpperCase());
  }
  function init() { mount(); window.addEventListener('hashchange', route); route(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
