/* ============================================================
   PLUTUS — voice bot ("Ask Plutus")
   A floating button on every stock page opens a small panel where visitors ask about the company's latest
   annual report, by voice or by typing. How it works:
     1. data/reports/<SYMBOL>.json  — the report, pre-split into labelled chunks by the GitHub Actions job
        (scripts/prepare_report.py). If it doesn't exist yet, the Worker is asked to start that job and this
        panel waits for it.
     2. the best passages for the question are found here in the browser (keyword search, BM25)
     3. the Worker (POST /ask) gives only those passages to a free AI model, with strict "answer only from
        these, cite them" rules, and checks every number in the answer against the passages
     4. the answer is shown with its sources and read aloud (browser speech)
   Everything the AI says is put on the page as plain text (never as HTML).
   ============================================================ */
(function () {
  'use strict';
  const CFG = window.APP_CONFIG || {};
  if (CFG.VOICE_BOT === false) return;
  const WORKER = String(CFG.WORKER_URL || '').replace(/\/+$/, '');
  const REPORTS = String(CFG.REPORTS_PATH || 'data/reports/').replace(/\/?$/, '/');
  if (!WORKER) return; // everything goes through the Worker

  const POLL_MS = Number(CFG.VOICE_POLL_MS) || 15000, POLL_MAX_MS = 15 * 60 * 1000;
  const SPEAK_KEY = 'plutus.voice.speak.v1';
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const TTS = 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
  const $ = (s, r) => (r || document).querySelector(s);

  /* ---------------------------------------------------------------- helpers */
  const safeName = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '_'); // same rule as scripts/prepare_report.py
  function currentSymbol() {
    const m = location.hash.match(/^#\/s\/(.+)$/);
    if (!m) return null;
    try { return decodeURIComponent(m[1]).toUpperCase(); } catch (e) { return null; }
  }
  function h(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
  };

  /* ---------------------------------------------------------------- state */
  const S = {
    sym: null, report: null, index: null, history: [],
    loadToken: 0, pollTimer: null, askAbort: null,
    speakOn: store.get(SPEAK_KEY, '1') !== '0',
    listening: false, speaking: false, busy: false, open: false, rec: null, greeted: false
  };
  let ui = null;

  /* ---------------------------------------------------------------- search: BM25 over the report's chunks */
  const STOP = new Set(('a an the of and or to in on for with by at from is are was were be been being it its this that these those as than then which who whom what why how did does do ' +
    'has have had not no into over under per about between during after before can could would should will i me my we our you your they their there here so if but also very more most').split(' '));
  const stem = (w) => (w.length > 4 ? w.replace(/(ations?|ments?|ing|ed|es|s)$/, '') : w);
  function tokens(text) {
    return (String(text).toLowerCase().match(/[a-z]+|\d[\d,]*\.?\d*/g) || [])
      .map((t) => (/^\d/.test(t) ? t.replace(/,/g, '').replace(/\.$/, '') : t))
      .filter((t) => t.length > 1 || /\d/.test(t))
      .filter((t) => !STOP.has(t)).map(stem);
  }
  function buildIndex(chunks) {
    const docs = chunks.map((c) => { const t = tokens(c.section + ' ' + c.text); const tf = new Map(); t.forEach((w) => tf.set(w, (tf.get(w) || 0) + 1)); return { tf, len: t.length || 1 }; });
    const df = new Map();
    docs.forEach((d) => d.tf.forEach((_, w) => df.set(w, (df.get(w) || 0) + 1)));
    return { docs, df, N: docs.length, avg: docs.reduce((a, d) => a + d.len, 0) / Math.max(docs.length, 1) };
  }

  // plain-English questions use different words than annual reports; widen the query a little
  const EXPAND = [
    [/cash[\s-]?flows?/i, 'cash flows operating activities'],
    [/\b(decreas\w*|declin\w*|fall\w*|fell|drop\w*|lower|reduc\w*|down)\b/i, 'decrease decreased decline lower reduction'],
    [/\b(increas\w*|rise|rose|risen|grow\w*|higher|jump\w*|up)\b/i, 'increase increased growth higher'],
    [/\b(revenue|sales|turnover|top[\s-]?line)\b/i, 'revenue sales turnover income from operations'],
    [/\b(profit|earnings|net income|pat|bottom[\s-]?line)\b/i, 'profit net income earnings'],
    [/\b(margin|ebitda)\b/i, 'margin ebitda operating profit'],
    [/\b(debt|borrow\w*|leverage|loans?)\b/i, 'borrowings debt loans liabilities'],
    [/\b(capex|capital expenditure|investments?)\b/i, 'capital expenditure purchase property plant equipment investing'],
    [/\b(dividends?|payout)\b/i, 'dividend paid per share'],
    [/\b(outlook|guidance|future|plans?|strategy|expect\w*)\b/i, 'outlook strategy opportunities expect future'],
    [/\b(risk\w*|threat\w*|concern\w*)\b/i, 'risk factors uncertainties adverse'],
    [/\b(employees?|headcount|workforce|people)\b/i, 'employees headcount workforce'],
    [/\b(tax|taxes)\b/i, 'tax income taxes paid'],
    [/\b(inventory|inventories|working capital|receivables?)\b/i, 'inventories receivables payables working capital']
  ];
  const TAG_BOOST = [
    [/cash|liquidity/i, { cashflow: 1.6, mdna: 1.3 }],
    [/\b(why|reason|because|driver|cause|explain|due to|led to)\b/i, { mdna: 1.45, directors: 1.2, notes: 1.1 }],
    [/\brisk|threat|uncertaint/i, { risk: 1.7 }],
    [/\b(outlook|strategy|plan|future|business|segment|products?)\b/i, { business: 1.3, mdna: 1.3, directors: 1.2 }],
    [/\b(balance sheet|assets?|liabilit\w*|equity|debt|borrow\w*)\b/i, { balance: 1.5, notes: 1.2 }],
    [/\b(revenue|sales|profit|income|earnings|margin|expenses?)\b/i, { income: 1.4, mdna: 1.3 }]
  ];
  function fyHints(q) {
    const out = [];
    for (const m of q.matchAll(/\bfy\s?'?(\d{2,4})(?:\s?[-–/]\s?(\d{2,4}))?\b|\b(20\d{2})\s?[-–/]\s?(\d{2,4})\b/gi)) {
      const a = m[1] || m[3], b = m[2] || m[4];
      [a, b].forEach((x) => { if (!x) return; out.push(x.length === 2 ? '20' + x : x); });
    }
    return out;
  }
  function retrieve(question, prevQuestion) {
    const idx = S.index, chunks = S.report.chunks;
    let q = question;
    // a follow-up ("and why?", "what about debt?", "why did it fall?") borrows the topic of the previous question; a fresh question does not
    if (prevQuestion && (tokens(question).length < 2 || /^(and|also|what about|how about|but)\b|\b(it|that|this|they|those|them)\b/i.test(question))) q = prevQuestion + ' ' + question;
    const base = tokens(q).concat(fyHints(q));
    if (!base.length) return [];
    const exp = [];
    EXPAND.forEach(([rx, add]) => { if (rx.test(q)) exp.push(...tokens(add)); });
    const weights = new Map();
    base.forEach((t) => weights.set(t, Math.max(weights.get(t) || 0, 1)));
    exp.forEach((t) => { if (!weights.has(t)) weights.set(t, 0.45); });
    const boost = {};
    TAG_BOOST.forEach(([rx, b]) => { if (rx.test(q)) Object.keys(b).forEach((k) => { boost[k] = Math.max(boost[k] || 1, b[k]); }); });
    const k1 = 1.4, bb = 0.75, baseSet = new Set(base);
    const scored = [];
    idx.docs.forEach((d, i) => {
      let s = 0, hits = 0;
      weights.forEach((wt, t) => {
        const tf = d.tf.get(t); if (!tf) return;
        const df = idx.df.get(t) || 0;
        const idf = Math.log(1 + (idx.N - df + 0.5) / (df + 0.5));
        s += wt * idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - bb + bb * d.len / idx.avg)));
        if (baseSet.has(t)) hits++;
      });
      if (hits) scored.push({ i, s: s * (boost[chunks[i].tag] || 1) * (1 + 0.08 * Math.min(hits, 5)) });
    });
    scored.sort((a, b) => b.s - a.s);
    const picked = [], perTag = {};
    for (const x of scored) {
      const tag = chunks[x.i].tag;
      if ((perTag[tag] || 0) >= 3) continue;
      perTag[tag] = (perTag[tag] || 0) + 1; picked.push(x);
      if (picked.length >= 6) break;
    }
    return picked.map((x) => { const c = chunks[x.i]; return { id: c.id, section: c.section, tag: c.tag, page: c.page, text: c.text.slice(0, 1500) }; });
  }

  /* "Why did cash flow fall in FY26?" when the newest report we hold is FY25 -> say so instead of guessing */
  function requestedYearEnd(q) {
    let m = q.match(/\bfy\s?'?(\d{2,4})(?:\s?[-–/]\s?(\d{2,4}))?\b/i);
    let a, b;
    if (m) { a = m[1]; b = m[2]; } else if ((m = q.match(/\b(20\d{2})\s?[-–/]\s?(\d{2,4})\b/))) { a = m[1]; b = m[2]; }
    else if ((m = q.match(/\bfiscal\s+(?:year\s+)?'?(\d{2,4})\b/i))) { a = m[1]; }
    if (!a) return null;
    const full = (x) => { x = String(x); return x.length === 2 ? 2000 + Number(x) : Number(x); };
    return full(b || a);
  }
  function periodMismatch(q) {
    const rep = S.report.report || {};
    const want = requestedYearEnd(q);
    if (!want || !rep.fy_end_year) return null;
    if (want <= rep.fy_end_year && want >= rep.fy_end_year - 1) return null; // a report also shows the previous year
    const covers = rep.period_label ? `the ${rep.period_label}` : `fiscal ${rep.fy_end_year}`;
    return `The latest annual report I have for ${S.report.company || S.sym} covers ${covers}, so I can't explain ${want > rep.fy_end_year ? 'a later period' : 'an older period'} like FY${String(want).slice(2)} from it. ` +
      `Ask me about fiscal ${rep.fy_end_year}, or how it compares with the year before.`;
  }

  /* ---------------------------------------------------------------- report loading / preparation */
  async function fetchReport(sym) {
    let res;
    try { res = await fetch(`${REPORTS}${encodeURIComponent(safeName(sym))}.json?t=${Date.now()}`, { cache: 'no-store' }); }
    catch (e) { return { state: 'error' }; }
    if (res.status === 404) return { state: 'missing' };
    if (!res.ok) return { state: 'error' };
    let j; try { j = await res.json(); } catch (e) { return { state: 'missing' }; } // an HTML 404 page served with 200
    if (j && j.status === 'ready' && Array.isArray(j.chunks) && j.chunks.length) return { state: 'ready', data: j };
    if (j && j.status === 'failed') return { state: 'failed', data: j };
    return { state: 'missing' };
  }
  async function requestPrepare(sym, force) {
    try {
      const res = await fetch(WORKER + '/prepare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol: sym, force: !!force }) });
      if (res.ok) return { ok: true };
      let err = ''; try { err = (await res.json()).error; } catch (e) { /* ignore */ }
      return { ok: false, error: err || String(res.status) };
    } catch (e) { return { ok: false, error: 'network' }; }
  }
  function stopPolling() { if (S.pollTimer) { clearTimeout(S.pollTimer); S.pollTimer = null; } }

  async function ensureReport(force) {
    const sym = S.sym; if (!sym) return;
    const token = ++S.loadToken; stopPolling();
    setStatus('checking');
    const r = await fetchReport(sym);
    if (token !== S.loadToken) return;
    if (r.state === 'ready') return adopt(r.data);
    if (r.state === 'error') return setStatus('error');
    if (r.state === 'failed' && !force) return setStatus('failed', r.data);
    // missing (or a retry after a failure): ask the Worker to start the GitHub Actions job, then wait for the file
    const since = Date.now();
    const p = await requestPrepare(sym, force || r.state === 'failed');
    if (token !== S.loadToken) return;
    if (!p.ok) {
      if (p.error === 'not_configured') return setStatus('unconfigured');
      if (p.error === 'rate_limited' || p.error === 'busy') return setStatus('busy');
      return setStatus('error');
    }
    setStatus('preparing', { since });
    const tick = async () => {
      if (token !== S.loadToken) return;
      if (Date.now() - since > POLL_MAX_MS) return setStatus('slow');
      const x = await fetchReport(sym);
      if (token !== S.loadToken) return;
      if (x.state === 'ready') return adopt(x.data);
      if (x.state === 'failed' && Date.parse(x.data.prepared_at || 0) > since - 120000) return setStatus('failed', x.data);
      setStatus('preparing', { since });
      S.pollTimer = setTimeout(tick, POLL_MS);
    };
    S.pollTimer = setTimeout(tick, Math.min(POLL_MS, 8000));
  }
  function adopt(data) {
    S.report = data; S.index = buildIndex(data.chunks);
    setStatus('ready');
    if (!S.greeted) {
      S.greeted = true;
      addBotNote(`Hi, I'm Plutus. Ask me anything about ${data.company || S.sym}'s latest annual report — tap the mic or type. I only answer from the report, and I'll show you where each answer comes from.`);
      if (!SR) addBotNote('Voice input isn’t available in this browser (try Chrome, Edge or Safari). You can still type, and I can read answers aloud.');
    }
    renderChips();
  }

  /* ---------------------------------------------------------------- asking */
  async function ask(question) {
    question = question.trim(); if (!question || S.busy) return;
    stopSpeaking(); stopListening();
    addUser(question);
    if (!S.report) { addBotNote('The annual report isn’t ready yet — one moment.'); return; }
    const mismatch = periodMismatch(question);
    if (mismatch) { addBotSimple(mismatch); return; }
    const prevQ = S.history.length ? S.history[S.history.length - 1].q : '';
    const excerpts = retrieve(question, prevQ);
    if (!excerpts.length) { addBotSimple('I couldn’t find anything about that in the annual report. Try asking about revenue, profit, cash flow, debt, risks or the outlook.'); return; }
    S.busy = true; ui.send.disabled = true; setOrb('thinking');
    const typing = addTyping();
    const rep = S.report.report || {};
    const ctrl = new AbortController(); S.askAbort = ctrl;
    const symAtStart = S.sym;
    try {
      const res = await fetch(WORKER + '/ask', {
        method: 'POST', signal: ctrl.signal, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: S.sym, question, history: S.history.slice(-2), excerpts: excerpts.map((e) => ({ id: e.id, section: e.section, page: e.page, text: e.text })),
          meta: { company: S.report.company, report: { form: rep.form, period_label: rep.period_label, filed: rep.filed, source: rep.source } } })
      });
      typing.remove();
      if (symAtStart !== S.sym) return;
      let j = null; try { j = await res.json(); } catch (e) { /* ignore */ }
      if (!res.ok) { addBotSimple(errorText(res.status, j && j.error)); return; }
      renderAnswer(j, excerpts);
      S.history.push({ q: question, a: String(j.spoken || '').slice(0, 300) });
      if (S.history.length > 6) S.history.shift();
      if (j.spoken) speak(j.spoken);
    } catch (e) {
      typing.remove();
      if (e.name !== 'AbortError') addBotSimple('I couldn’t reach the Plutus service. Check your connection and try again.');
    } finally {
      S.busy = false; if (ui) ui.send.disabled = false; if (!S.speaking) setOrb('idle');
    }
  }
  function errorText(status, code) {
    if (status === 429) return 'You’re asking quickly — give me a minute and try again.';
    if (code === 'not_configured') return 'Voice answers aren’t switched on for this site yet (the Worker has no AI key).';
    if (status === 503) return 'The free AI services are busy or out of quota right now. Please try again in a little while.';
    return 'Something went wrong while answering. Please try again.';
  }

  /* ---------------------------------------------------------------- speech out / in */
  let voicesCache = [];
  function loadVoices() { try { voicesCache = window.speechSynthesis.getVoices() || []; } catch (e) { voicesCache = []; } }
  function recLang() { return /\.(NS|BO)$/.test(S.sym || '') ? 'en-IN' : (/^en/i.test(navigator.language || '') ? navigator.language : 'en-US'); }
  function pickVoice(lang) {
    const en = voicesCache.filter((v) => /^en/i.test(v.lang));
    const exact = en.filter((v) => v.lang.replace('_', '-').toLowerCase() === lang.toLowerCase());
    const pool = exact.length ? exact : en;
    const rank = (v) => (/natural|neural|online/i.test(v.name) ? 0 : /google/i.test(v.name) ? 1 : 2);
    return pool.sort((a, b) => rank(a) - rank(b))[0] || null;
  }
  function speechText(t) { return String(t).replace(/\[S\d+\]/g, '').replace(/[*_`#]/g, '').replace(/\s+/g, ' ').trim(); }
  function sentences(t, max) {
    const parts = t.match(/[^.!?;]+[.!?;]*\s*/g) || [t];
    const out = []; let cur = '';
    parts.forEach((p) => { if ((cur + p).length > max && cur) { out.push(cur.trim()); cur = ''; } cur += p; });
    if (cur.trim()) out.push(cur.trim());
    return out;
  }
  function speak(text, force) {
    if (!TTS || (!S.speakOn && !force)) return;
    stopSpeaking();
    const chunks = sentences(speechText(text), 170); if (!chunks.length) return;
    const lang = recLang(); const voice = pickVoice(lang);
    S.speaking = true; setOrb('speaking'); ui.stop.classList.remove('hidden');
    chunks.forEach((c, i) => {
      const u = new SpeechSynthesisUtterance(c);
      u.lang = voice ? voice.lang : lang; if (voice) u.voice = voice; u.rate = 1;
      const done = () => { if (i === chunks.length - 1) { S.speaking = false; ui && ui.stop.classList.add('hidden'); if (!S.busy && !S.listening) setOrb('idle'); } };
      u.onend = done; u.onerror = done;
      window.speechSynthesis.speak(u);
    });
  }
  function stopSpeaking() {
    if (!TTS) return;
    try { window.speechSynthesis.cancel(); } catch (e) { /* ignore */ }
    S.speaking = false; if (ui) { ui.stop.classList.add('hidden'); if (!S.busy && !S.listening) setOrb('idle'); }
  }
  function startListening() {
    stopSpeaking(); // tapping the mic interrupts Plutus
    if (!SR) { addBotNote('Voice input isn’t available in this browser (try Chrome, Edge or Safari). Type your question instead.'); ui.input.focus(); return; }
    if (S.listening) { stopListening(); return; }
    if (!S.report) { addBotNote('The annual report isn’t ready yet — one moment.'); return; }
    let rec;
    try { rec = new SR(); } catch (e) { addBotNote('I couldn’t start the microphone.'); return; }
    S.rec = rec; rec.lang = recLang(); rec.interimResults = true; rec.continuous = false; rec.maxAlternatives = 1;
    let finalText = '', heard = false;
    rec.onstart = () => { S.listening = true; setOrb('listening'); ui.mic.classList.add('on'); ui.mic.setAttribute('aria-pressed', 'true'); ui.input.placeholder = 'Listening…'; };
    rec.onresult = (e) => {
      heard = true; let interim = ''; finalText = '';
      for (let i = 0; i < e.results.length; i++) { const t = e.results[i][0].transcript; if (e.results[i].isFinal) finalText += t; else interim += t; }
      ui.input.value = (finalText + ' ' + interim).trim();
    };
    rec.onerror = (e) => {
      const m = { 'not-allowed': 'The microphone is blocked. Allow it in your browser’s site settings, or type your question.', 'service-not-allowed': 'The microphone is blocked. Allow it in your browser’s site settings, or type your question.',
        'no-speech': 'I didn’t hear anything — tap the mic and try again.', 'network': 'Voice recognition needs an internet connection. You can type instead.', 'audio-capture': 'I couldn’t find a microphone.' }[e.error];
      if (m) addBotNote(m);
    };
    rec.onend = () => {
      S.listening = false; ui.mic.classList.remove('on'); ui.mic.setAttribute('aria-pressed', 'false'); ui.input.placeholder = ui.placeholder;
      if (!S.busy && !S.speaking) setOrb('idle');
      const q = (finalText || ui.input.value).trim();
      if (heard && q) { ui.input.value = ''; ask(q); }
    };
    try { rec.start(); } catch (e) { addBotNote('I couldn’t start the microphone.'); }
  }
  function stopListening() { if (S.rec) { try { S.rec.stop(); } catch (e) { /* ignore */ } } }
  function abortListening() { if (S.rec) { try { S.rec.onend = null; S.rec.abort(); } catch (e) { /* ignore */ } } S.listening = false; if (ui) { ui.mic.classList.remove('on'); ui.mic.setAttribute('aria-pressed', 'false'); ui.input.placeholder = ui.placeholder; } }

  /* ---------------------------------------------------------------- UI */
  const ICON = {
    mic: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
    send: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12l16-7-6 16-3-6-7-3z"/></svg>',
    sound: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path class="pv-waves" d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/></svg>',
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    stop: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5l11 7-11 7z"/></svg>'
  };
  function build() {
    const fab = h('button', 'pv-fab hidden'); fab.type = 'button'; fab.id = 'pvFab';
    fab.setAttribute('aria-haspopup', 'dialog'); fab.setAttribute('aria-expanded', 'false'); fab.setAttribute('aria-controls', 'pvPanel');
    fab.innerHTML = `<span class="pv-orb">${ICON.mic}</span><span class="pv-fab-t">Ask Plutus</span>`;
    const panel = h('section', 'pv-panel hidden'); panel.id = 'pvPanel'; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Plutus voice assistant');
    panel.innerHTML =
      `<header class="pv-head"><div class="pv-title"><span class="pv-orb sm" id="pvOrb"></span><b>PLUTUS</b><span class="pv-sub">Ask the annual report</span></div>` +
      `<div class="pv-hbtns"><button type="button" class="pv-ib" id="pvSpeak" aria-pressed="true" aria-label="Read answers aloud" title="Read answers aloud">${ICON.sound}</button>` +
      `<button type="button" class="pv-ib" id="pvClose" aria-label="Close" title="Close">${ICON.close}</button></div></header>` +
      `<div class="pv-status" id="pvStatus" role="status" aria-live="polite"></div>` +
      `<div class="pv-log" id="pvLog" aria-live="polite"></div>` +
      `<div class="pv-chips" id="pvChips"></div>` +
      `<div class="pv-stoprow"><button type="button" class="pv-stop hidden" id="pvStop">${ICON.stop}<span>Stop speaking</span></button></div>` +
      `<form class="pv-form" id="pvForm" autocomplete="off"><button type="button" class="pv-mic" id="pvMic" aria-pressed="false" aria-label="Ask by voice" title="Ask by voice">${ICON.mic}</button>` +
      `<input id="pvInput" type="text" maxlength="400" placeholder="Ask about the annual report…" enterkeyhint="send" aria-label="Your question" />` +
      `<button type="submit" class="pv-send" id="pvSend" aria-label="Send">${ICON.send}</button></form>` +
      `<p class="pv-foot">Answers come only from the company’s latest annual report. Not investment advice.</p>`;
    document.body.appendChild(fab); document.body.appendChild(panel);
    ui = { fab, panel, orb: $('#pvOrb', panel), status: $('#pvStatus', panel), log: $('#pvLog', panel), chips: $('#pvChips', panel), form: $('#pvForm', panel),
      input: $('#pvInput', panel), mic: $('#pvMic', panel), send: $('#pvSend', panel), stop: $('#pvStop', panel), speak: $('#pvSpeak', panel), close: $('#pvClose', panel) };
    ui.placeholder = ui.input.placeholder;
    if (!SR) { ui.mic.classList.add('off'); ui.mic.title = 'Voice input isn’t supported in this browser'; }
    syncSpeakBtn();
    fab.addEventListener('click', () => (S.open ? closePanel() : openPanel()));
    ui.close.addEventListener('click', closePanel);
    ui.form.addEventListener('submit', (e) => { e.preventDefault(); const q = ui.input.value; ui.input.value = ''; ask(q); });
    ui.mic.addEventListener('click', startListening);
    ui.stop.addEventListener('click', stopSpeaking);
    ui.speak.addEventListener('click', () => { S.speakOn = !S.speakOn; store.set(SPEAK_KEY, S.speakOn ? '1' : '0'); if (!S.speakOn) stopSpeaking(); syncSpeakBtn(); });
    ui.chips.addEventListener('click', (e) => { const b = e.target.closest('button[data-q]'); if (b) ask(b.dataset.q); });
    panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); closePanel(); ui.fab.focus(); } });
    if (TTS) { loadVoices(); window.speechSynthesis.addEventListener && window.speechSynthesis.addEventListener('voiceschanged', loadVoices); }
    else { ui.speak.classList.add('hidden'); }
  }
  function syncSpeakBtn() { ui.speak.setAttribute('aria-pressed', S.speakOn ? 'true' : 'false'); ui.speak.classList.toggle('muted', !S.speakOn); ui.speak.title = S.speakOn ? 'Reading answers aloud — tap to mute' : 'Muted — tap to read answers aloud'; }
  function setOrb(state) { ui.orb.dataset.state = state; ui.fab.dataset.state = state; }
  function openPanel() {
    if (!S.sym) return;
    S.open = true; ui.panel.classList.remove('hidden'); ui.fab.setAttribute('aria-expanded', 'true'); document.documentElement.classList.add('pv-open');
    if (!S.report && !S.pollTimer && ui.status.dataset.s !== 'preparing') ensureReport();
    if (window.matchMedia && window.matchMedia('(hover: hover)').matches) setTimeout(() => ui.input.focus(), 50);
  }
  function closePanel() {
    S.open = false; ui.panel.classList.add('hidden'); ui.fab.setAttribute('aria-expanded', 'false'); document.documentElement.classList.remove('pv-open');
    stopSpeaking(); abortListening();
  }

  function setStatus(state, info) {
    const el = ui.status; el.dataset.s = state; el.textContent = ''; el.classList.remove('hidden');
    ui.form.classList.toggle('disabled', state !== 'ready'); ui.input.disabled = state !== 'ready'; ui.send.disabled = state !== 'ready'; ui.mic.disabled = state !== 'ready';
    const retry = (label, fn) => { const b = h('button', 'pv-link', label); b.type = 'button'; b.addEventListener('click', fn); el.appendChild(b); };
    if (state === 'checking') { el.appendChild(h('span', 'pv-spin')); el.appendChild(h('span', 'pv-st', 'Checking for the annual report…')); }
    else if (state === 'preparing') {
      el.appendChild(h('span', 'pv-spin'));
      const mins = Math.max(0, Math.round((Date.now() - (info && info.since || Date.now())) / 60000));
      el.appendChild(h('span', 'pv-st', `Plutus is reading ${S.sym}’s annual report for the first time — usually 2–6 minutes${mins ? ` (${mins} min so far)` : ''}. Keep this page open.`));
    }
    else if (state === 'ready') {
      const r = S.report.report || {};
      const bits = [r.form || 'Annual report', r.period_label || (r.fy_end_year ? `FY${r.fy_end_year}` : null)].filter(Boolean).join(' · ');
      el.appendChild(h('span', 'pv-doc', 'Source: ' + bits + ' · '));
      if (/^https?:\/\//.test(r.url || '')) { const a = h('a', 'pv-link', (r.source || 'Source') + ' ↗'); a.href = r.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; el.appendChild(a); }
      const w = (S.report.quality && S.report.quality.warnings) || [];
      if (w.length) el.appendChild(h('div', 'pv-warnline', 'Heads-up: ' + w.join('; ') + '. Some answers may be less complete.'));
    }
    else if (state === 'failed') {
      el.appendChild(h('span', null, ((info && info.reason) || 'I couldn’t prepare this company’s annual report.') + ' '));
      retry('Try again', () => ensureReport(true));
    }
    else if (state === 'unconfigured') el.appendChild(h('span', null, 'The annual-report assistant isn’t switched on for this site yet (the Worker needs its GitHub settings).'));
    else if (state === 'busy') { el.appendChild(h('span', null, 'Lots of reports are being prepared right now. ')); retry('Try again later', () => ensureReport()); }
    else if (state === 'slow') { el.appendChild(h('span', null, 'This is taking longer than expected. ')); retry('Check again', () => ensureReport()); }
    else if (state === 'error') { el.appendChild(h('span', null, 'I couldn’t load the annual report just now. ')); retry('Try again', () => ensureReport()); }
  }

  function scrollLog() { ui.log.scrollTop = ui.log.scrollHeight; }
  function addUser(t) { const m = h('div', 'pv-msg user'); m.appendChild(h('p', null, t)); ui.log.appendChild(m); renderChips(); scrollLog(); }
  function addBotNote(t) { const m = h('div', 'pv-msg bot note'); m.appendChild(h('p', null, t)); ui.log.appendChild(m); scrollLog(); }
  function addBotSimple(t) {
    const m = h('div', 'pv-msg bot'); m.appendChild(h('p', 'pv-spoken', t));
    const play = h('button', 'pv-replay'); play.type = 'button'; play.innerHTML = ICON.play + '<span>Listen</span>'; play.addEventListener('click', () => speak(t, true));
    m.appendChild(play); ui.log.appendChild(m); scrollLog(); speak(t);
  }
  function addTyping() { const m = h('div', 'pv-msg bot typing'); m.innerHTML = '<span></span><span></span><span></span>'; ui.log.appendChild(m); scrollLog(); return m; }
  function pageLabel(p) {
    const k = S.report && S.report.report && S.report.report.page_kind;
    if (!p || !k || k === 'none') return '';
    return k === 'pdf' ? `PDF page ${p}` : `≈ page ${p}`;
  }
  function withCites(text, container, onCite) {
    text.split(/(\[S\d+\])/).forEach((part) => {
      const m = part.match(/^\[S(\d+)\]$/);
      if (m) { const b = h('button', 'pv-cite', 'S' + m[1]); b.type = 'button'; b.setAttribute('aria-label', 'Show source ' + m[1]); b.addEventListener('click', () => onCite(+m[1])); container.appendChild(b); }
      else if (part) container.appendChild(document.createTextNode(part));
    });
  }
  function renderAnswer(j, excerpts) {
    const m = h('div', 'pv-msg bot');
    m.appendChild(h('p', 'pv-spoken', j.spoken || 'I couldn’t put an answer together from the report.'));
    const cites = Array.isArray(j.cites) ? j.cites.filter((n) => n >= 1 && n <= excerpts.length) : [];
    if (j.answered !== false && (j.detailed || cites.length)) {
      const det = h('details', 'pv-more'); det.appendChild(h('summary', null, 'Details & sources'));
      const srcEls = {};
      const lines = String(j.detailed || '').split(/\n+/).map((l) => l.replace(/^\s*[-•*]\s*/, '').trim()).filter(Boolean);
      const ul = h('ul', 'pv-det');
      lines.forEach((l) => { const li = h('li'); withCites(l, li, (n) => { det.open = true; const s = srcEls[n]; if (s) { s.open = true; s.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } }); ul.appendChild(li); });
      if (lines.length) det.appendChild(ul);
      if (cites.length) {
        const box = h('div', 'pv-srcs');
        cites.forEach((n) => {
          const e = excerpts[n - 1];
          const d = h('details', 'pv-src');
          const pg = pageLabel(e.page);
          d.appendChild(h('summary', null, `S${n} · ${e.section}${pg ? ' · ' + pg : ''}`));
          const q = h('blockquote', null, e.text.length > 420 ? e.text.slice(0, 420).replace(/\s+\S*$/, '') + '…' : e.text); d.appendChild(q);
          srcEls[n] = d; box.appendChild(d);
        });
        det.appendChild(box);
      }
      m.appendChild(det);
    }
    if (Array.isArray(j.unverified) && j.unverified.length) {
      m.appendChild(h('p', 'pv-warn', `⚠ I couldn’t match ${j.unverified.length === 1 ? 'this figure' : 'these figures'} (${j.unverified.slice(0, 4).join(', ')}) to the report text — please check the source before relying on ${j.unverified.length === 1 ? 'it' : 'them'}.`));
    }
    const play = h('button', 'pv-replay'); play.type = 'button'; play.innerHTML = ICON.play + '<span>Listen</span>'; play.addEventListener('click', () => speak(j.spoken || '', true));
    m.appendChild(play);
    ui.log.appendChild(m); scrollLog();
  }
  function renderChips() {
    ui.chips.textContent = '';
    if (!S.report || S.history.length || ui.log.querySelector('.pv-msg.user')) return;
    ['Why did cash flow change?', 'How did revenue and profit change?', 'What are the biggest risks?', 'What does management say about the outlook?', 'How much debt does it have?'].forEach((q) => {
      const b = h('button', 'pv-chip', q); b.type = 'button'; b.dataset.q = q; ui.chips.appendChild(b);
    });
  }

  /* ---------------------------------------------------------------- routing */
  function resetForSymbol(sym) {
    S.loadToken++; stopPolling(); stopSpeaking(); abortListening();
    if (S.askAbort) { try { S.askAbort.abort(); } catch (e) { /* ignore */ } }
    S.sym = sym; S.report = null; S.index = null; S.history = []; S.greeted = false; S.busy = false;
    ui.log.textContent = ''; ui.chips.textContent = ''; ui.status.textContent = ''; ui.status.dataset.s = '';
    ui.send.disabled = false; setOrb('idle');
    if (S.open && sym) ensureReport();
  }
  function onRoute() {
    const sym = currentSymbol();
    ui.fab.classList.toggle('hidden', !sym);
    if (!sym) { if (S.open) closePanel(); if (S.sym) resetForSymbol(null); return; }
    if (sym !== S.sym) resetForSymbol(sym);
  }

  function init() {
    build();
    window.addEventListener('hashchange', onRoute);
    window.addEventListener('pagehide', () => { stopSpeaking(); abortListening(); });
    document.addEventListener('visibilitychange', () => { if (document.hidden) stopSpeaking(); });
    onRoute();
    window.PlutusVoice = { open: openPanel, close: closePanel, ask, _retrieve: retrieve, _state: S }; // handy for debugging / tests
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
