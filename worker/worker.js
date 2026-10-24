/* ============================================================
   PLUTUS — Cloudflare Worker proxy (free tier) · v7
   • Adds CORS headers so the GitHub Pages site can call Yahoo
   • Handles Yahoo's cookie + "crumb" handshake (needed for
     quoteSummary: company profile, P/E, dividend, peers, etc.)
   • Only forwards to Yahoo Finance data hosts and Bing News RSS
     (not an open proxy)
   • Caches GET responses at the edge for 10 minutes
   • POST is forwarded to Yahoo's screener endpoint only
     (used to list companies in the same industry for peers)
   • ?og=<article url> returns { image } — the article's own
     picture (og:image), used for news thumbnails
   v7 — adds the Plutus voice bot: POST /ask and POST /prepare (see the "v7" block below). Everything above is unchanged.
   v6 — fewer "Signal lost" errors:
   • FIX: answers served from the edge cache carried a doubled
     "Access-Control-Allow-Origin: *, *" header, which browsers
     reject — every cache HIT failed like a network error
   • the cookie/crumb handshake is shared by requests arriving
     together (it used to run once PER request when the Worker
     was cold, which itself triggered Yahoo's rate limit)
   • a 429 / 5xx from Yahoo is retried once on its twin host
     (query1 ↔ query2)
   • a 24-hour "last good copy" is kept at the edge and served
     when Yahoo refuses (X-Cache: STALE)
   • Retry-After is passed through and readable by the site
   ============================================================ */

// After your site is live, lock this down, e.g. ['https://<user>.github.io']
const ALLOWED_ORIGINS = ['*'];
const ALLOWED_HOSTS = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
const NEWS_HOSTS = ['www.bing.com'];
const NEWS_PATHS = ['/news/search'];
const ALLOWED_POST_PATHS = ['/v1/finance/screener'];
const CACHE_SECONDS = 600;          // fresh copy
const STALE_SECONDS = 24 * 3600;    // last good copy, served only when the live request fails
const OG_CACHE_SECONDS = 24 * 3600;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const twinHost = (u) => { const x = new URL(u); x.hostname = x.hostname === 'query1.finance.yahoo.com' ? 'query2.finance.yahoo.com' : 'query1.finance.yahoo.com'; return x.toString(); };

let session = null;        // { cookie, crumb, ts }
let pendingSession = null; // the handshake in progress, shared by every request that needs it
let sessionFailedAt = 0;   // don't hammer Yahoo with handshakes right after one failed

async function getSession(force) {
  if (!force && session && Date.now() - session.ts < 30 * 60e3) return session;
  if (pendingSession) return pendingSession;
  if (!force && Date.now() - sessionFailedAt < 60e3) return session; // may be null: some endpoints work without a crumb
  pendingSession = (async () => {
    const r = await fetch('https://fc.yahoo.com/', { headers: { 'User-Agent': UA }, redirect: 'manual' });
    const setCookies = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [r.headers.get('set-cookie') || ''];
    const cookie = setCookies.map((c) => c.split(';')[0]).filter(Boolean).join('; ');
    const c = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', { headers: { 'User-Agent': UA, Cookie: cookie } });
    const crumb = (await c.text()).trim();
    if (!c.ok || !crumb || crumb.includes('<') || crumb.length > 40) throw new Error('crumb handshake failed');
    session = { cookie, crumb, ts: Date.now() };
    return session;
  })().catch((e) => { sessionFailedAt = Date.now(); throw e; }).finally(() => { pendingSession = null; });
  return pendingSession;
}

// init (optional): { method, body } for POST requests
async function callYahoo(target, force, init) {
  let s = null;
  try { s = await getSession(force); } catch (e) { /* some endpoints work without a crumb */ }
  const u = new URL(target);
  if (s && s.crumb) u.searchParams.set('crumb', s.crumb);
  const headers = { 'User-Agent': UA, Accept: 'application/json' };
  if (s && s.cookie) headers.Cookie = s.cookie;
  const opts = { headers };
  if (init && init.method === 'POST') {
    opts.method = 'POST';
    opts.body = init.body;
    headers['Content-Type'] = 'application/json';
  }
  return fetch(u.toString(), opts);
}

// crumb refresh on 401/403; one retry on the twin host on 429 / 5xx
async function yahoo(target, init) {
  let res = await callYahoo(target, false, init);
  if (res.status === 401 || res.status === 403) res = await callYahoo(target, true, init);
  if (res.status === 429 || res.status >= 500) {
    await sleep(300 + Math.random() * 400);
    res = await callYahoo(twinHost(target), false, init);
  }
  return res;
}

function corsHeaders(req) {
  const origin = req.headers.get('Origin') || '';
  const allow = ALLOWED_ORIGINS.includes('*') ? '*' : ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return { 'Access-Control-Allow-Origin': allow, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Expose-Headers': 'Retry-After, X-Cache', Vary: 'Origin' };
}

const json = (obj, status, extra) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...extra } });
// Re-serve a cached response. Headers must be SET, not merged from a plain object: the cached copy already carries
// "access-control-allow-origin" (lower case), and merging the capitalised one on top makes "*, *" — a value browsers
// reject, so every cache HIT failed as "TypeError: Failed to fetch" (shown by the site as "Signal lost"). Fixed in v6.
function withCors(res, cors, tag) {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(cors)) h.set(k, v);
  h.set('X-Cache', tag);
  return new Response(res.body, { status: res.status, headers: h });
}

/* ---------- news thumbnails: the article's og:image / twitter:image ---------- */
async function readHead(res, limit) {
  const reader = res.body.getReader(), dec = new TextDecoder();
  let html = '';
  while (html.length < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    html += dec.decode(value, { stream: true });
    if (/<\/head>/i.test(html)) break;
  }
  try { reader.cancel(); } catch (e) { /* ignore */ }
  return html;
}
async function ogImage(link) {
  let u;
  try { u = new URL(link); } catch (e) { return ''; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
  if (/^[\d.]+$|^\[|^localhost$/i.test(u.hostname)) return ''; // public sites only
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch(u.toString(), { headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' }, redirect: 'follow', signal: ctrl.signal });
    if (!res.ok || !/html/i.test(res.headers.get('Content-Type') || '')) return '';
    const html = await readHead(res, 300000);
    const tags = html.match(/<meta\b[^>]*>/gi) || [];
    for (const want of [/^og:image(:secure_url)?$/i, /^twitter:image(:src)?$/i]) {
      for (const t of tags) {
        const key = (t.match(/\b(?:property|name)\s*=\s*["']([^"']+)["']/i) || [])[1];
        const val = (t.match(/\bcontent\s*=\s*["']([^"']+)["']/i) || [])[1];
        if (key && val && want.test(key.trim())) {
          try { const img = new URL(val.replace(/&amp;/g, '&').trim(), res.url || u.toString()); if (/^https?:$/.test(img.protocol)) return img.toString(); } catch (e) { /* bad url */ }
        }
      }
    }
    return '';
  } catch (e) { return ''; } finally { clearTimeout(timer); }
}

/* ============================================================
   v7 — PLUTUS VOICE BOT  (POST /ask · POST /prepare)
   • /ask     — answers a question about a company's annual report. The browser finds the best passages in the
                prepared report (data/reports/<SYMBOL>.json) and sends only those; this Worker adds the strict
                rules, calls a free AI model (Groq → Gemini → Workers AI, whichever has a key / quota left),
                checks every number in the answer against the passages, and returns the result.
   • /prepare — asks GitHub Actions to fetch + index a company's latest annual report (first request for a company).
   Settings (Worker → Settings → Variables and Secrets):
     secrets : GROQ_API_KEY, GEMINI_API_KEY, GITHUB_TOKEN   (any one AI key is enough)
     text    : GITHUB_REPO = "<user>/<repo>", GITHUB_REF = "main" (optional)
               GROQ_MODEL, GEMINI_MODEL, WORKERS_AI_MODEL, PROVIDER_ORDER = "groq,gemini,workersai" (optional)
     binding : AI → Workers AI (optional third fallback)
   ============================================================ */
const SYMBOL_RE = /^[A-Z0-9][A-Z0-9.&^-]{0,19}$/;
const V = {
  maxQuestion: 400, maxExcerpts: 6, maxExcerptChars: 1600, maxHistory: 2, maxBody: 40000,
  askPerMinute: 8,            // per visitor (best-effort counter in the edge cache)
  preparePerHourPerIp: 6, prepareGlobalPerHour: 40, prepareCooldownSeconds: 20 * 60,
  providerTimeoutMs: 25000,
  defaults: { groq: 'openai/gpt-oss-120b', gemini: 'gemini-3.1-flash-lite', workersai: '@cf/meta/llama-3.1-8b-instruct-fp8-fast' }
};

const SYSTEM_PROMPT = `You are Plutus, a voice assistant that explains ONE company's latest annual report to an everyday investor.

RULES — follow all of them:
1. Use ONLY the numbered excerpts you are given. Never use outside knowledge, never guess a cause, never fill gaps.
2. If the excerpts do not answer the question, write exactly: "The annual report excerpts I searched don't explain this." in both parts and stop.
3. Put a citation like [S2] after every factual sentence in DETAILED. Cite only numbers that exist in the excerpts.
4. Separate what MANAGEMENT SAYS from plain figures, e.g. "Management attributes the fall to higher working capital [S1]."
5. Quote numbers exactly as written in the excerpts, with their units and currency. Do NOT calculate, round, convert or compare numbers yourself; if a change is not stated, give the two figures instead.
6. If the question is about a period the excerpts do not cover, say which period they do cover.
7. Never recommend buying, selling or holding anything.

Reply in exactly this format and nothing else:
SPOKEN: <2 or 3 short plain sentences that sound natural when read aloud — no markdown, no citation tags>
DETAILED: <up to 6 short sentences or lines, each ending with its [S#] citation>`;

const cleanStr = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ').slice(0, max);

async function softCounter(cache, key, ttlSeconds) {
  const k = new Request('https://plutus-cache/rl/' + encodeURIComponent(key));
  const hit = await cache.match(k);
  const n = (hit ? parseInt(await hit.text(), 10) || 0 : 0) + 1;
  await cache.put(k, new Response(String(n), { headers: { 'Cache-Control': `public, max-age=${ttlSeconds}` } }));
  return n;
}
async function hasMarker(cache, key) { return !!(await cache.match(new Request('https://plutus-cache/mk/' + encodeURIComponent(key)))); }
async function setMarker(cache, key, ttlSeconds) {
  await cache.put(new Request('https://plutus-cache/mk/' + encodeURIComponent(key)), new Response('1', { headers: { 'Cache-Control': `public, max-age=${ttlSeconds}` } }));
}
const clientIp = (req) => req.headers.get('CF-Connecting-IP') || req.headers.get('X-Forwarded-For') || 'unknown';

function originAllowed(req) {
  if (ALLOWED_ORIGINS.includes('*')) return true;
  return ALLOWED_ORIGINS.includes(req.headers.get('Origin') || '');
}

async function readJson(req, cors) {
  const text = await req.text();
  if (text.length > V.maxBody) return { err: json({ error: 'request too large' }, 413, cors) };
  try { return { body: JSON.parse(text) }; } catch (e) { return { err: json({ error: 'bad json' }, 400, cors) }; }
}

/* ---------- POST /prepare ---------- */
async function handlePrepare(req, env, cors, cache) {
  if (!originAllowed(req)) return json({ error: 'origin not allowed' }, 403, cors);
  const r = await readJson(req, cors); if (r.err) return r.err;
  const symbol = String(r.body.symbol || '').trim().toUpperCase();
  if (!SYMBOL_RE.test(symbol)) return json({ error: 'bad symbol' }, 400, cors);
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) return json({ error: 'not_configured' }, 503, cors);
  const force = r.body.force === true;
  if (!force && await hasMarker(cache, 'prep/' + symbol)) return json({ ok: true, status: 'already_requested' }, 200, cors);
  const hour = Math.floor(Date.now() / 3600e3);
  if (await softCounter(cache, `prepip/${clientIp(req)}/${hour}`, 3600) > V.preparePerHourPerIp) return json({ error: 'rate_limited' }, 429, cors);
  if (await softCounter(cache, `prepall/${hour}`, 3600) > V.prepareGlobalPerHour) return json({ error: 'busy' }, 429, cors);
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/prepare-report.yml/dispatches`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'plutus-worker', 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: env.GITHUB_REF || 'main', inputs: { symbol, force: force ? 'true' : 'false' } })
  });
  if (res.status !== 204) return json({ error: 'dispatch_failed', status: res.status }, 502, cors);
  await setMarker(cache, 'prep/' + symbol, V.prepareCooldownSeconds);
  return json({ ok: true, status: 'started' }, 200, cors);
}

/* ---------- number guard ---------- */
const numTokens = (s) => (String(s).match(/\d[\d,]*(?:\.\d+)?/g) || []).map((x) => String(Number(x.replace(/,/g, '').replace(/\.$/, ''))));
function unverifiedNumbers(answer, allowedText) {
  const allowed = new Set(numTokens(allowedText));
  const seen = new Set(), bad = [];
  for (const raw of (String(answer).replace(/\[S\d+\]/g, ' ').match(/\d[\d,]*(?:\.\d+)?/g) || [])) {
    const n = String(Number(raw.replace(/,/g, '').replace(/\.$/, '')));
    if (seen.has(n)) continue; seen.add(n);
    const v = Number(n);
    if (!Number.isFinite(v)) continue;
    if (Number.isInteger(v) && v < 10) continue;                   // "3 sentences", list numbers
    if (Number.isInteger(v) && v >= 1990 && v <= 2100) continue;   // years
    if (!allowed.has(n)) bad.push(raw);
  }
  return bad;
}

/* ---------- AI providers (all free tiers) ---------- */
async function withTimeout(fn) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), V.providerTimeoutMs);
  try { return await fn(ctrl.signal); } finally { clearTimeout(t); }
}
async function callGroq(env, system, user) {
  const model = env.GROQ_MODEL || V.defaults.groq;
  const body = { model, temperature: 0.1, max_completion_tokens: 900, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
  if (/gpt-oss/i.test(model)) body.reasoning_effort = 'low';
  const res = await withTimeout((signal) => fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST', signal, headers: { Authorization: `Bearer ${env.GROQ_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
  if (!res.ok) throw new Error('groq ' + res.status);
  const j = await res.json();
  return { text: (((j.choices || [])[0] || {}).message || {}).content || '', model };
}
async function callGemini(env, system, user) {
  const model = env.GEMINI_MODEL || V.defaults.gemini;
  const res = await withTimeout((signal) => fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST', signal, headers: { 'x-goog-api-key': env.GEMINI_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: user }] }], generationConfig: { temperature: 0.1, maxOutputTokens: 1200 } }) }));
  if (!res.ok) throw new Error('gemini ' + res.status);
  const j = await res.json();
  const parts = (((j.candidates || [])[0] || {}).content || {}).parts || [];
  return { text: parts.map((p) => p.text || '').join(''), model };
}
async function callWorkersAI(env, system, user) {
  const model = env.WORKERS_AI_MODEL || V.defaults.workersai;
  const out = await env.AI.run(model, { messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: 700, temperature: 0.1 });
  const text = typeof out === 'string' ? out : (out && (out.response || (out.choices && out.choices[0] && out.choices[0].message && out.choices[0].message.content))) || '';
  return { text, model };
}
function providerList(env) {
  const order = String(env.PROVIDER_ORDER || 'groq,gemini,workersai').split(',').map((s) => s.trim().toLowerCase());
  const table = {
    groq: env.GROQ_API_KEY && callGroq,
    gemini: env.GEMINI_API_KEY && callGemini,
    workersai: env.AI && callWorkersAI
  };
  return order.filter((n) => table[n]).map((n) => ({ name: n, fn: table[n] }));
}

/* ---------- POST /ask ---------- */
async function handleAsk(req, env, cors, cache) {
  if (!originAllowed(req)) return json({ error: 'origin not allowed' }, 403, cors);
  const providers = providerList(env);
  if (!providers.length) return json({ error: 'not_configured' }, 503, cors);
  const r = await readJson(req, cors); if (r.err) return r.err;
  const b = r.body || {};
  const symbol = String(b.symbol || '').trim().toUpperCase();
  const question = cleanStr(b.question, V.maxQuestion).trim();
  if (!SYMBOL_RE.test(symbol) || question.length < 2) return json({ error: 'bad request' }, 400, cors);
  const ex = (Array.isArray(b.excerpts) ? b.excerpts : []).slice(0, V.maxExcerpts).map((e) => ({
    section: cleanStr(e && e.section, 90), page: Number.isInteger(e && e.page) ? e.page : null, text: cleanStr(e && e.text, V.maxExcerptChars)
  })).filter((e) => e.text.length > 20);
  if (!ex.length) return json({ error: 'no excerpts' }, 400, cors);
  const minute = Math.floor(Date.now() / 60e3);
  if (await softCounter(cache, `askip/${clientIp(req)}/${minute}`, 90) > V.askPerMinute) return json({ error: 'rate_limited' }, 429, cors);

  const meta = b.meta || {};
  const rep = meta.report || {};
  const header = [
    `Company: ${cleanStr(meta.company || symbol, 90)}`,
    `Report: ${cleanStr(rep.form || 'Annual report', 30)}${rep.period_label ? ', ' + cleanStr(rep.period_label, 50) : ''}${rep.filed ? ', filed ' + cleanStr(rep.filed, 12) : ''}${rep.source ? ' (source: ' + cleanStr(rep.source, 40) + ')' : ''}`
  ].join('\n');
  const hist = (Array.isArray(b.history) ? b.history : []).slice(-V.maxHistory)
    .map((h) => `Earlier question: ${cleanStr(h && h.q, 200)}\nEarlier answer: ${cleanStr(h && h.a, 300)}`).join('\n');
  const excerptText = ex.map((e, i) => `[S${i + 1}] Section: ${e.section}${e.page ? ' · page ' + e.page : ''}\n${e.text}`).join('\n\n');
  const user = `${header}\n${hist ? hist + '\n' : ''}\nQuestion: ${question}\n\nExcerpts:\n${excerptText}`;

  let result = null; const errors = [];
  for (const p of providers) {
    try {
      const out = await p.fn(env, SYSTEM_PROMPT, user);
      if (out.text && out.text.trim()) { result = { ...out, provider: p.name }; break; }
      errors.push(p.name + ': empty');
    } catch (e) { errors.push(p.name + ': ' + String(e.message || e).slice(0, 60)); }
  }
  if (!result) return json({ error: 'all_providers_failed', details: errors }, 503, cors);

  let text = result.text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const m = text.match(/SPOKEN:\s*([\s\S]*?)\s*DETAILED:\s*([\s\S]*)$/i);
  let spoken = m ? m[1].trim() : text, detailed = m ? m[2].trim() : '';
  const strip = (s) => s.replace(/\[S(\d+)\]/g, (all, n) => (+n >= 1 && +n <= ex.length ? all : '')).replace(/\*\*/g, '');
  spoken = strip(spoken).replace(/\[S\d+\]/g, '').replace(/\s{2,}/g, ' ').trim();
  detailed = strip(detailed);
  const cites = [...new Set((detailed.match(/\[S(\d+)\]/g) || []).map((x) => +x.slice(2, -1)))].sort((x, y) => x - y);
  const allowedText = excerptText + ' ' + question + ' ' + JSON.stringify(rep) + ' ' + cleanStr(meta.company, 90);
  const unverified = unverifiedNumbers(spoken + ' ' + detailed, allowedText);
  const answered = !/don'?t explain this/i.test(spoken);
  return json({ spoken, detailed, cites, unverified, answered, provider: result.provider }, 200, cors);
}

export default {
  async fetch(req, env, ctx) {
    const cors = corsHeaders(req);
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (req.method !== 'GET' && req.method !== 'POST') return json({ error: 'GET or POST only' }, 405, cors);
    const params = new URL(req.url).searchParams;
    const cache = caches.default;

    // ---- v7: voice bot routes ----
    const path = new URL(req.url).pathname.replace(/\/+$/, '');
    if (path === '/ask' || path === '/prepare') {
      if (req.method !== 'POST') return json({ error: 'POST only' }, 405, cors);
      try { return await (path === '/ask' ? handleAsk(req, env, cors, cache) : handlePrepare(req, env, cors, cache)); }
      catch (e) { return json({ error: 'server_error' }, 500, cors); }
    }

    // ---- ?og=<article url>: news thumbnail lookup (cached for a day) ----
    const og = params.get('og');
    if (og && req.method === 'GET') {
      const key = new Request('https://plutus-cache/og/' + encodeURIComponent(og));
      const hit = await cache.match(key);
      if (hit) return withCors(hit, cors, 'HIT');
      const out = json({ image: await ogImage(og) }, 200, { 'Cache-Control': `public, max-age=${OG_CACHE_SECONDS}` });
      ctx.waitUntil(cache.put(key, out.clone()));
      return withCors(out, cors, 'MISS');
    }

    const target = params.get('url');
    if (!target) return json({ ok: true, usage: '?url=<encoded Yahoo Finance or Bing News RSS URL> | ?og=<article URL>' }, 200, cors);
    let parsed;
    try { parsed = new URL(target); } catch (e) { return json({ error: 'bad url' }, 400, cors); }
    const isNews = NEWS_HOSTS.includes(parsed.hostname) && NEWS_PATHS.includes(parsed.pathname);
    if (parsed.protocol !== 'https:' || !(ALLOWED_HOSTS.includes(parsed.hostname) || isNews)) return json({ error: 'host not allowed' }, 403, cors);

    // ---- POST: screener only (no edge caching) ----
    if (req.method === 'POST') {
      if (isNews || !ALLOWED_POST_PATHS.includes(parsed.pathname)) return json({ error: 'POST not allowed for this path' }, 403, cors);
      const body = await req.text();
      if (body.length > 20000) return json({ error: 'body too large' }, 413, cors);
      const res = await yahoo(parsed.toString(), { method: 'POST', body });
      const text = await res.text();
      const extra = res.headers.get('Retry-After') ? { 'Retry-After': res.headers.get('Retry-After') } : {};
      return new Response(text, { status: res.status, headers: { 'Content-Type': 'application/json', ...extra, ...cors } });
    }

    // ---- GET (cached; last good copy kept for when Yahoo / Bing refuse) ----
    const cacheKey = new Request('https://plutus-cache/' + encodeURIComponent(parsed.toString()));
    const staleKey = new Request('https://plutus-cache/stale/' + encodeURIComponent(parsed.toString()));
    const cached = await cache.match(cacheKey);
    if (cached) return withCors(cached, cors, 'HIT');

    let res;
    try {
      res = isNews
        ? await fetch(parsed.toString(), { headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml' } })
        : await yahoo(parsed.toString());
    } catch (e) { res = new Response(JSON.stringify({ error: 'upstream unreachable' }), { status: 502 }); }
    const type = isNews ? 'application/rss+xml; charset=utf-8' : 'application/json';
    const body = await res.text();
    if (res.ok) {
      const out = new Response(body, { status: 200, headers: { 'Content-Type': type, 'Cache-Control': `public, max-age=${CACHE_SECONDS}`, ...cors, 'X-Cache': 'MISS' } });
      ctx.waitUntil(Promise.all([
        cache.put(cacheKey, out.clone()),
        cache.put(staleKey, new Response(body, { headers: { 'Content-Type': type, 'Cache-Control': `public, max-age=${STALE_SECONDS}` } }))
      ]));
      return out;
    }
    // refused / failed: an older good copy is better than an error ("not found" stays an error)
    if (res.status !== 400 && res.status !== 404) {
      const stale = await cache.match(staleKey);
      if (stale) return withCors(stale, cors, 'STALE');
    }
    const extra = res.headers.get('Retry-After') ? { 'Retry-After': res.headers.get('Retry-After') } : {};
    return new Response(body, { status: res.status, headers: { 'Content-Type': type, ...extra, ...cors } });
  }
};
