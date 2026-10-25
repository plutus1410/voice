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
     4. the answer is shown with its sources and read aloud:
          • "Natural (HD)" voice  — the Worker (POST /speak) turns the spoken answer into natural-sounding audio
          • "This device" voice   — the browser's own speech (used automatically if the HD voice is unavailable)
        The ⚙ button in the panel lets the visitor choose the voice type, the voice and the speed.
     5. an animated orb (canvas) shows what Plutus is doing — idle, listening, thinking or speaking; tapping it starts / stops the mic.
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
  const HD_ALLOWED = CFG.VOICE_HD !== false;       // set VOICE_HD: false in config.js to use device voices only
  const K = { speak: 'plutus.voice.speak.v1', engine: 'plutus.voice.engine.v2', hd: 'plutus.voice.hd.v2', dev: 'plutus.voice.dev.v2', rate: 'plutus.voice.rate.v2' };
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const TTS = 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
  const HD_VOICES = ['Asteria', 'Luna', 'Stella', 'Athena', 'Hera', 'Orion', 'Arcas', 'Perseus', 'Angus', 'Orpheus', 'Helios', 'Zeus'];
  const SAMPLE = 'Hi, I\u2019m Plutus. This is how I will read the annual report answers to you.';
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
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
  };
  const errX = (code, status) => Object.assign(new Error(code), { code, status });
  const clampRate = (x) => Math.min(1.4, Math.max(0.75, Number(x) || 1));

  /* ---------------------------------------------------------------- state */
  const S = {
    sym: null, report: null, index: null, history: [],
    loadToken: 0, pollTimer: null, askAbort: null,
    speakOn: store.get(K.speak, '1') !== '0',
    engine: HD_ALLOWED && store.get(K.engine, 'hd') !== 'device' ? 'hd' : 'device',
    hdVoice: store.get(K.hd, 'arcas'), devVoice: store.get(K.dev, ''), rate: clampRate(store.get(K.rate, '1')),
    speakToken: 0, ttsAbort: null, hdResolve: null, hdBlockedUntil: 0, hdNoted: '', audioUrl: null,
    listening: false, speaking: false, busy: false, open: false, rec: null, greeted: false
  };
  if (!HD_VOICES.some((v) => v.toLowerCase() === S.hdVoice)) S.hdVoice = 'arcas';
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
      addBotNote(`Hi, I'm Plutus. Ask me anything about ${data.company || S.sym} — tap the mic or type. I only answer from the report, and I'll show you where each answer comes from.`);
      if (!SR) addBotNote('Voice input isn’t available in this browser (try Chrome, Edge or Safari). You can still type, and I can read answers aloud.');
    }
    renderChips();
  }

  /* ---------------------------------------------------------------- asking */
  async function ask(question) {
    question = question.trim(); if (!question || S.busy) return;
    unlockAudio(); stopSpeaking(); stopListening();
    addUser(question);
    if (!S.report) { addBotNote('The annual report isn’t ready yet — one moment.'); return; }
    const mismatch = periodMismatch(question);
    if (mismatch) { addBotSimple(mismatch); return; }
    const prevQ = S.history.length ? S.history[S.history.length - 1].q : '';
    const excerpts = retrieve(question, prevQ);
    if (!excerpts.length) { addBotSimple('I couldn’t find anything about that in the annual report. Try asking about revenue, profit, cash flow, debt, risks or the outlook.'); return; }
    S.busy = true; ui.send.disabled = true; setOrb();
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
      S.busy = false; if (ui) ui.send.disabled = false; setOrb();
    }
  }
  function errorText(status, code) {
    if (status === 429) return 'You’re asking quickly — give me a minute and try again.';
    if (code === 'not_configured') return 'Voice answers aren’t switched on for this site yet (the Worker has no AI key).';
    if (status === 503) return 'The free AI services are busy or out of quota right now. Please try again in a little while.';
    return 'Something went wrong while answering. Please try again.';
  }

  /* ---------------------------------------------------------------- speech out
     Two engines: "hd" (Worker /speak → natural audio, played in one <audio> element) and "device" (browser speech).
     If HD fails (not switched on, daily allowance used, network hiccup, autoplay blocked) the answer is read with the
     device voice instead, and HD is paused for a while so we don't keep asking. */
  let voicesCache = [], audioEl = null, audioUnlocked = false;
  function loadVoices() { try { voicesCache = window.speechSynthesis.getVoices() || []; } catch (e) { voicesCache = []; } }
  function recLang() { return /\.(NS|BO)$/.test(S.sym || '') ? 'en-IN' : (/^en/i.test(navigator.language || '') ? navigator.language : 'en-US'); }
  const rankVoice = (v) => (/natural|neural|online/i.test(v.name) ? 0 : /premium|enhanced|siri/i.test(v.name) ? 1 : /google/i.test(v.name) ? 2 : v.localService === false ? 3 : 4);
  function englishVoices() { return voicesCache.filter((v) => /^en/i.test(v.lang)).sort((a, b) => rankVoice(a) - rankVoice(b) || a.name.localeCompare(b.name)); }
  function pickVoice(lang) {
    if (S.devVoice) { const saved = voicesCache.find((v) => v.voiceURI === S.devVoice || v.name === S.devVoice); if (saved) return saved; }
    const en = englishVoices();
    const exact = en.filter((v) => v.lang.replace('_', '-').toLowerCase() === lang.toLowerCase());
    const pool = exact.length ? exact : en;
    return pool.slice().sort((a, b) => rankVoice(a) - rankVoice(b))[0] || null;
  }
  function speechText(t) { return String(t).replace(/\[S\d+\]/g, '').replace(/[*_`#]/g, '').replace(/\s+/g, ' ').trim(); }
  function sentences(t, max) {
    const parts = t.match(/[^.!?;]+[.!?;]*\s*/g) || [t];
    const out = []; let cur = '';
    parts.forEach((p) => { if ((cur + p).length > max && cur) { out.push(cur.trim()); cur = ''; } cur += p; });
    if (cur.trim()) out.push(cur.trim());
    return out;
  }
  function silentWav() {
    const n = 800, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, 8000, true); v.setUint32(28, 16000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
    return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  }
  function getAudio() { if (!audioEl && window.Audio) { audioEl = new Audio(); audioEl.preload = 'auto'; } return audioEl; }
  // Phones only let audio start from a tap. The first tap "unlocks" this audio element with a silent clip, so the
  // answer (which arrives a moment later) can then be played without another tap.
  function unlockAudio() {
    if (audioUnlocked || S.engine !== 'hd') return;
    const a = getAudio(); if (!a) return;
    try {
      a.src = silentWav(); audioUnlocked = true;
      const p = a.play(); if (p && p.catch) p.catch((e) => { if (e && e.name === 'NotAllowedError') audioUnlocked = false; });
    } catch (e) { audioUnlocked = false; }
  }
  const hdReady = () => S.engine === 'hd' && HD_ALLOWED && !!window.Audio && Date.now() >= S.hdBlockedUntil;

  async function speakHD(text, token) {
    const a = getAudio();
    const ctrl = new AbortController(); S.ttsAbort = ctrl;
    const res = await fetch(WORKER + '/speak', { method: 'POST', signal: ctrl.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, speaker: S.hdVoice }) });
    if (!res.ok) { let code = ''; try { code = (await res.json()).error; } catch (e) { /* ignore */ } throw errX(code || 'http', res.status); }
    const blob = await res.blob();
    if (token !== S.speakToken) return;
    if (!blob.size) throw errX('empty');
    if (S.audioUrl) { try { URL.revokeObjectURL(S.audioUrl); } catch (e) { /* ignore */ } }
    S.audioUrl = URL.createObjectURL(blob);
    await new Promise((resolve, reject) => {
      S.hdResolve = resolve;
      a.onended = () => { S.hdResolve = null; resolve(); };
      a.onerror = () => { S.hdResolve = null; reject(errX('decode')); };
      a.defaultPlaybackRate = S.rate; a.src = S.audioUrl; a.playbackRate = S.rate;
      const p = a.play();
      if (p && p.catch) p.catch((e) => { if (token !== S.speakToken) return; S.hdResolve = null; reject(errX(e && e.name === 'NotAllowedError' ? 'autoplay' : 'play')); });
    });
  }
  function noteHdFailure(e) {
    const code = (e && e.code) || '', st = (e && e.status) || 0;
    let why;
    if (code === 'not_configured') { S.hdBlockedUntil = Infinity; why = 'off'; }
    else if (code === 'tts_budget' || st === 429 && code !== 'rate_limited') { S.hdBlockedUntil = Date.now() + 30 * 60e3; why = 'limit'; }
    else if (code === 'rate_limited') { S.hdBlockedUntil = Date.now() + 60e3; why = 'busy'; }
    else if (code === 'autoplay') { S.hdBlockedUntil = Date.now() + 20e3; why = 'autoplay'; }
    else { S.hdBlockedUntil = Date.now() + 2 * 60e3; why = 'error'; }
    if (S.hdNoted !== why && ui) {
      S.hdNoted = why;
      addBotNote({ off: 'The natural HD voice isn’t switched on for this site yet, so I’m using your device’s voice.',
        limit: 'The free natural-voice allowance for today is used up, so I’m using your device’s voice for now.',
        busy: 'The natural voice is busy for a moment, so I’m using your device’s voice.',
        autoplay: 'Your browser blocked automatic audio — tap Listen under an answer to hear it.',
        error: 'The natural voice isn’t available right now, so I’m using your device’s voice.' }[why]);
    }
    if (ui && !ui.set.classList.contains('hidden')) renderSettings();
  }
  function speakDevice(text, token, done) {
    const chunks = sentences(text, 170); if (!chunks.length) { done(); return; }
    const lang = recLang(); const voice = pickVoice(lang);
    chunks.forEach((c, i) => {
      const u = new SpeechSynthesisUtterance(c);
      u.lang = voice ? voice.lang : lang; if (voice) u.voice = voice; u.rate = S.rate;
      const end = () => { if (i === chunks.length - 1 && token === S.speakToken) done(); };
      u.onend = end; u.onerror = end; u.onboundary = () => Orb.pulse(0.9);
      window.speechSynthesis.speak(u);
    });
  }
  function speak(text, force) {
    if (!force && !S.speakOn) return;
    unlockAudio();
    stopSpeaking();
    const clean = speechText(text); if (!clean) return;
    const token = ++S.speakToken;
    S.speaking = true; setOrb(); ui.stop.classList.remove('hidden');
    const finish = () => { if (token !== S.speakToken) return; S.speaking = false; ui.stop.classList.add('hidden'); setOrb(); };
    const device = () => { if (TTS) speakDevice(clean, token, finish); else finish(); };
    if (hdReady()) {
      speakHD(clean.length > 480 ? clean.slice(0, 480).replace(/\s+\S*$/, '') : clean, token).then(finish, (e) => { if (token !== S.speakToken) return; noteHdFailure(e); device(); });
    } else device();
  }
  function stopSpeaking() {
    S.speakToken++;
    if (S.ttsAbort) { try { S.ttsAbort.abort(); } catch (e) { /* ignore */ } S.ttsAbort = null; }
    if (audioEl) { audioEl.onended = null; audioEl.onerror = null; try { audioEl.pause(); } catch (e) { /* ignore */ } }
    if (S.hdResolve) { const r = S.hdResolve; S.hdResolve = null; r(); }
    if (TTS) { try { window.speechSynthesis.cancel(); } catch (e) { /* ignore */ } }
    S.speaking = false; if (ui) { ui.stop.classList.add('hidden'); setOrb(); }
  }

  /* ---------------------------------------------------------------- speech in */
  function startListening() {
    unlockAudio();
    stopSpeaking(); // tapping the mic interrupts Plutus
    if (!SR) { addBotNote('Voice input isn’t available in this browser (try Chrome, Edge or Safari). Type your question instead.'); ui.input.focus(); return; }
    if (S.listening) { stopListening(); return; }
    if (!S.report) { addBotNote('The annual report isn’t ready yet — one moment.'); return; }
    let rec;
    try { rec = new SR(); } catch (e) { addBotNote('I couldn’t start the microphone.'); return; }
    S.rec = rec; rec.lang = recLang(); rec.interimResults = true; rec.continuous = false; rec.maxAlternatives = 1;
    let finalText = '', heard = false;
    rec.onstart = () => { S.listening = true; setOrb(); ui.mic.classList.add('on'); ui.mic.setAttribute('aria-pressed', 'true'); ui.input.placeholder = 'Listening…'; };
    rec.onsoundstart = () => Orb.pulse(0.5);
    rec.onspeechstart = () => Orb.pulse(0.85);
    rec.onresult = (e) => {
      Orb.pulse(0.6 + Math.random() * 0.35); // words are arriving: the orb surges
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
      setOrb();
      const q = (finalText || ui.input.value).trim();
      if (heard && q) { ui.input.value = ''; ask(q); }
    };
    try { rec.start(); } catch (e) { addBotNote('I couldn’t start the microphone.'); }
  }
  function stopListening() { if (S.rec) { try { S.rec.stop(); } catch (e) { /* ignore */ } } }
  function abortListening() { if (S.rec) { try { S.rec.onend = null; S.rec.abort(); } catch (e) { /* ignore */ } } S.listening = false; if (ui) { ui.mic.classList.remove('on'); ui.mic.setAttribute('aria-pressed', 'false'); ui.input.placeholder = ui.placeholder; setOrb(); } }

  /* ---------------------------------------------------------------- the Plutus flow (canvas animation)
     A breathing torus sits inside a field of flowing lines. Every visible canvas colour is read from the current
     style.css theme tokens; a theme mutation refreshes the palette immediately, without rebuilding the panel.
     Four moods change movement and energy while preserving the same site-controlled accent pair. */
  const Orb = (function () {
    const TAU = Math.PI * 2;
    const MOODS = ['idle', 'listening', 'thinking', 'speaking'];
    const SPEED = { idle: 0.22, listening: 0.72, thinking: 1.65, speaking: 0.95 };
    const w = { idle: 1, listening: 0, thinking: 0, speaking: 0 };
    const root = document.documentElement;
    let cv = null, g = null, cw = 0, ch = 0, dpr = 1, raf = 0, last = 0, t = 0, phase = 0;
    let mood = 'idle', energy = 0.06, level = 0, speed = SPEED.idle, broken = false, ro = null, themeObserver = null;
    let palette = null, paletteSignature = '';
    const reduce = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    const clamp01 = (v) => Math.max(0, Math.min(1, v));
    const rgba = (c, a) => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${clamp01(a).toFixed(3)})`;
    const mix = (a, b, n) => [a[0] + (b[0] - a[0]) * n, a[1] + (b[1] - a[1]) * n, a[2] + (b[2] - a[2]) * n];

    function parseColor(value) {
      const v = String(value || '').trim();
      let m = v.match(/^#([\da-f]{3,8})$/i);
      if (m) {
        let h = m[1];
        if (h.length === 3 || h.length === 4) h = h.split('').map((x) => x + x).join('');
        if (h.length === 6 || h.length === 8) return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
      }
      m = v.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
      return m ? [+m[1], +m[2], +m[3]] : null;
    }
    function refreshTheme(force) {
      const styles = getComputedStyle(root);
      const names = ['--accent', '--accent-2', '--pop-bg', '--row-main', '--hi', '--muted', '--line-2', '--on-accent'];
      const values = names.map((name) => styles.getPropertyValue(name).trim());
      const signature = values.join('|');
      if (!force && signature === paletteSignature) return;
      paletteSignature = signature;
      const base = parseColor(values[4]);
      const accent = parseColor(values[0]);
      if (!base || !accent) { palette = null; return; }
      palette = {
        accent,
        accent2: parseColor(values[1]) || accent,
        background: parseColor(values[2]) || base,
        stage: parseColor(values[3]) || parseColor(values[2]) || base,
        text: parseColor(values[4]) || base,
        muted: parseColor(values[5]) || base,
        line: parseColor(values[6]) || base,
        onAccent: parseColor(values[7]) || base
      };
      if (!raf && cv) still();
    }

    function fit() {
      if (!cv) return;
      const nw = cv.clientWidth, nh = cv.clientHeight;
      dpr = Math.min(2, window.devicePixelRatio || 1);
      const pw = Math.max(1, Math.round(nw * dpr)), ph = Math.max(1, Math.round(nh * dpr));
      if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph; }
      cw = nw; ch = nh;
      if (!raf) still();
    }
    function mount(canvas) {
      cv = canvas;
      try { g = cv.getContext('2d'); } catch (e) { g = null; }
      if (!g) { broken = true; return; }
      refreshTheme(true);
      if (window.ResizeObserver) { ro = new ResizeObserver(fit); ro.observe(cv); } else window.addEventListener('resize', fit);
      if (window.MutationObserver) {
        themeObserver = new MutationObserver(() => refreshTheme(false));
        themeObserver.observe(root, { attributes: true, attributeFilter: ['data-theme', 'style'] });
      }
      fit();
    }

    function step(dt) {
      t += dt;
      const k = 1 - Math.exp(-dt * 5);
      MOODS.forEach((m) => { w[m] += ((m === mood ? 1 : 0) - w[m]) * k; });
      const speechEnvelope = 0.55 * Math.abs(Math.sin(t * 7.5 + Math.sin(t * 2.1))) + 0.45 * Math.abs(Math.sin(t * 3.7 + 0.6));
      const target = w.idle * (0.08 + 0.035 * Math.sin(t * 1.25)) + w.listening * (0.24 + 0.7 * level) +
        w.thinking * (0.42 + 0.1 * Math.sin(t * 4.5)) + w.speaking * (0.35 + 0.48 * speechEnvelope + 0.17 * level);
      speed = MOODS.reduce((sum, m) => sum + w[m] * SPEED[m], 0);
      energy += (target - energy) * (1 - Math.exp(-dt * (target > energy ? 13 : 5)));
      level = Math.max(0, level - dt * 1.7);
      phase += dt * speed;
    }

    function drawFlowField(cx, cy, radius, pal) {
      const count = Math.max(13, Math.min(25, Math.round(ch / 10)));
      const half = (count - 1) / 2;
      const bend = radius * (0.18 + 0.18 * energy);
      const travel = phase * (1.2 + 0.8 * w.thinking);
      const gradient = g.createLinearGradient(0, 0, cw, 0);
      gradient.addColorStop(0, rgba(pal.accent, 0));
      gradient.addColorStop(0.18, rgba(pal.accent, 0.18 + 0.12 * energy));
      gradient.addColorStop(0.55, rgba(pal.accent2, 0.34 + 0.2 * energy));
      gradient.addColorStop(0.84, rgba(pal.accent, 0.16 + 0.12 * energy));
      gradient.addColorStop(1, rgba(pal.accent2, 0));
      g.save();
      g.lineCap = 'round';
      g.globalCompositeOperation = 'source-over';
      for (let i = 0; i < count; i++) {
        const lane = i - half;
        const normalized = half ? lane / half : 0;
        const baseY = cy + normalized * Math.min(ch * 0.48, radius * 1.36);
        const side = normalized === 0 ? Math.sin(travel) : Math.sign(normalized);
        g.beginPath();
        const steps = 76;
        for (let j = 0; j <= steps; j++) {
          const q = j / steps;
          const x = q * cw;
          const dx = (x - cx) / Math.max(radius, 1);
          const near = Math.exp(-dx * dx * 1.45);
          const ripple = Math.sin(q * TAU * 1.65 - travel * 2.4 + lane * 0.52) * radius * (0.012 + 0.018 * energy);
          const split = side * near * bend * (1 - Math.min(0.82, Math.abs(normalized) * 0.5));
          const curl = Math.sin(dx * 2.2 - travel + lane * 0.28) * near * radius * 0.035;
          const y = baseY + split + ripple + curl;
          if (j) g.lineTo(x, y); else g.moveTo(x, y);
        }
        g.strokeStyle = gradient;
        g.lineWidth = Math.max(0.7, 0.75 + (1 - Math.abs(normalized)) * 0.65 + energy * 0.55);
        g.globalAlpha = 0.42 + (1 - Math.abs(normalized)) * 0.45;
        g.stroke();
      }
      g.globalAlpha = 1;
      g.restore();
    }

    function torusPoint(u, v, cx, cy, major, minor, tilt, spin) {
      const ring = major + minor * Math.cos(v);
      const a = u + spin;
      const x = ring * Math.cos(a);
      const y = ring * Math.sin(a);
      const z = minor * Math.sin(v);
      const ct = Math.cos(tilt), st = Math.sin(tilt);
      const yy = y * ct - z * st;
      const zz = y * st + z * ct;
      const perspective = 1 + zz / Math.max(major * 7, 1);
      return { x: cx + x * perspective, y: cy + yy * perspective, z: zz };
    }

    function drawTorus(cx, cy, radius, pal) {
      const breathe = 1 + 0.035 * Math.sin(t * 1.35) + energy * 0.045;
      const major = radius * 0.62 * breathe;
      const minor = radius * (0.205 + energy * 0.025) * breathe;
      const tilt = 0.92 + 0.06 * Math.sin(t * 0.33);
      const spin = phase * 0.42;

      const halo = g.createRadialGradient(cx, cy, major * 0.12, cx, cy, radius * 1.18);
      halo.addColorStop(0, rgba(pal.accent2, 0.12 + 0.12 * energy));
      halo.addColorStop(0.52, rgba(pal.accent, 0.12 + 0.2 * energy));
      halo.addColorStop(1, rgba(pal.accent, 0));
      g.fillStyle = halo;
      g.beginPath(); g.arc(cx, cy, radius * 1.18, 0, TAU); g.fill();

      const body = g.createLinearGradient(cx - major - minor, cy, cx + major + minor, cy);
      body.addColorStop(0, rgba(pal.accent, 0.28 + 0.12 * energy));
      body.addColorStop(0.46, rgba(pal.accent2, 0.48 + 0.14 * energy));
      body.addColorStop(1, rgba(pal.accent, 0.28 + 0.12 * energy));
      g.save();
      g.translate(cx, cy);
      g.rotate(-0.08 + 0.035 * Math.sin(t * 0.45));
      g.strokeStyle = body;
      g.lineWidth = minor * 2.05;
      g.beginPath(); g.ellipse(0, 0, major, major * Math.cos(tilt), 0, 0, TAU); g.stroke();
      g.restore();

      const crossSections = [];
      for (let i = 0; i < 30; i++) {
        const u = (i / 30) * TAU;
        const depth = Math.sin(u + spin) * Math.sin(tilt);
        crossSections.push({ u, depth });
      }
      crossSections.sort((a, b) => a.depth - b.depth);
      crossSections.forEach((section, index) => {
        g.beginPath();
        const steps = 30;
        for (let j = 0; j <= steps; j++) {
          const v = (j / steps) * TAU;
          const p = torusPoint(section.u, v, cx, cy, major, minor, tilt, spin);
          if (j) g.lineTo(p.x, p.y); else g.moveTo(p.x, p.y);
        }
        const front = (section.depth + 1) / 2;
        const movingBand = 0.5 + 0.5 * Math.sin(section.u * 4 - phase * 5.2);
        g.strokeStyle = rgba(mix(pal.accent, pal.accent2, movingBand), 0.12 + front * 0.46 + energy * 0.12);
        g.lineWidth = Math.max(0.65, 0.65 + front * 0.95);
        g.stroke();
      });

      for (let i = 0; i < 13; i++) {
        const v = (i / 13) * TAU + phase * (0.55 + w.thinking * 0.7);
        g.beginPath();
        const steps = 92;
        for (let j = 0; j <= steps; j++) {
          const u = (j / steps) * TAU;
          const p = torusPoint(u, v, cx, cy, major, minor, tilt, spin);
          if (j) g.lineTo(p.x, p.y); else g.moveTo(p.x, p.y);
        }
        const ribbon = 0.5 + 0.5 * Math.sin(v + phase * 1.8);
        g.strokeStyle = rgba(mix(pal.accent2, pal.accent, ribbon), 0.28 + 0.34 * energy);
        g.lineWidth = Math.max(0.75, 0.85 + energy * 0.9);
        g.stroke();
      }

      const inner = major - minor * 1.08;
      g.strokeStyle = rgba(pal.accent2, 0.42 + 0.28 * energy);
      g.lineWidth = Math.max(0.8, radius * 0.008);
      g.beginPath(); g.ellipse(cx, cy, inner, inner * Math.cos(tilt), -0.08, 0, TAU); g.stroke();

      const highlight = mix(pal.onAccent, pal.accent2, 0.35);
      const marker = torusPoint(phase * 1.7, phase * 2.3, cx, cy, major, minor, tilt, spin);
      g.shadowColor = rgba(pal.accent, 0.72);
      g.shadowBlur = radius * (0.08 + energy * 0.08);
      g.fillStyle = rgba(highlight, 0.72 + 0.2 * energy);
      g.beginPath(); g.arc(marker.x, marker.y, Math.max(1.2, radius * (0.012 + energy * 0.008)), 0, TAU); g.fill();
      g.shadowBlur = 0;
    }

    function draw() {
      if (!g || broken || !palette || cw < 8 || ch < 8) return;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, cw, ch);
      g.setLineDash([]);
      g.shadowBlur = 0;
      const cx = cw / 2, cy = ch * 0.47;
      const radius = Math.max(24, Math.min(cw * 0.3, ch * 0.47));
      drawFlowField(cx, cy, radius, palette);
      drawTorus(cx, cy, radius, palette);
    }

    function still() {
      if (!cv || !g) return;
      MOODS.forEach((m) => { w[m] = m === mood ? 1 : 0; });
      step(0.18); draw();
    }
    function loop(now) {
      const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000)); last = now;
      try { step(dt); draw(); } catch (e) { broken = true; raf = 0; return; }
      raf = requestAnimationFrame(loop);
    }
    return {
      mount, fit,
      refreshTheme: () => refreshTheme(true),
      setMood(m) { if (MOODS.indexOf(m) < 0 || m === mood) return; mood = m; if (!raf && cv) still(); },
      pulse(v) { level = Math.max(level, Math.min(1, v)); },
      start() { if (raf || !cv || broken) return; refreshTheme(false); fit(); if (reduce()) { still(); return; } last = performance.now(); raf = requestAnimationFrame(loop); },
      stop() { if (raf) cancelAnimationFrame(raf); raf = 0; },
      get mood() { return mood; }, get running() { return !!raf; }
    };
  })();

  /* ---------------------------------------------------------------- UI */
  const ICON = {
    mic: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
    send: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12l16-7-6 16-3-6-7-3z"/></svg>',
    sound: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path class="pv-waves" d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/></svg>',
    gear: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h9M19 7h1M4 17h1M11 17h9"/><circle cx="16" cy="7" r="2.2"/><circle cx="8" cy="17" r="2.2"/></svg>',
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
      `<header class="pv-head"><div class="pv-title"><span class="pv-orb sm" id="pvOrb"></span><b>PLUTUS</b><span class="pv-sub">Annual report</span></div>` +
      `<div class="pv-hbtns"><button type="button" class="pv-ib" id="pvSpeak" aria-pressed="true" aria-label="Read answers aloud" title="Read answers aloud">${ICON.sound}</button>` +
      `<button type="button" class="pv-ib" id="pvGear" aria-expanded="false" aria-controls="pvSet" aria-label="Voice settings" title="Voice settings">${ICON.gear}</button>` +
      `<button type="button" class="pv-ib" id="pvClose" aria-label="Close" title="Close">${ICON.close}</button></div></header>` +
      `<div class="pv-set hidden" id="pvSet" role="group" aria-label="Voice settings"></div>` +
      `<div class="pv-status" id="pvStatus" role="status" aria-live="polite"></div>` +
      `<div class="pv-stage" id="pvStage" data-state="idle"><button type="button" class="pv-orbbtn" id="pvOrbBtn" aria-label="Ask by voice" title="Tap to ask by voice"><canvas id="pvCanvas" aria-hidden="true"></canvas></button>` +
      `<div class="pv-stage-txt" role="status" aria-live="polite"><b class="pv-stt" id="pvStTitle">Ready</b><span class="pv-sth" id="pvStHint"></span></div></div>` +
      `<div class="pv-log" id="pvLog" aria-live="polite"></div>` +
      `<div class="pv-chips" id="pvChips"></div>` +
      `<div class="pv-stoprow"><button type="button" class="pv-stop hidden" id="pvStop">${ICON.stop}<span>Stop speaking</span></button></div>` +
      `<form class="pv-form" id="pvForm" autocomplete="off"><button type="button" class="pv-mic" id="pvMic" aria-pressed="false" aria-label="Ask by voice" title="Ask by voice">${ICON.mic}</button>` +
      `<input id="pvInput" type="text" maxlength="400" placeholder="Ask about the annual report…" enterkeyhint="send" aria-label="Your question" />` +
      `<button type="submit" class="pv-send" id="pvSend" aria-label="Send">${ICON.send}</button></form>` +
      `<p class="pv-foot">Answers come only from the company’s latest annual report. Not investment advice.</p>`;
    document.body.appendChild(fab); document.body.appendChild(panel);
    ui = { fab, panel, orb: $('#pvOrb', panel), status: $('#pvStatus', panel), log: $('#pvLog', panel), chips: $('#pvChips', panel), form: $('#pvForm', panel),
      input: $('#pvInput', panel), mic: $('#pvMic', panel), send: $('#pvSend', panel), stop: $('#pvStop', panel), speak: $('#pvSpeak', panel), close: $('#pvClose', panel),
      gear: $('#pvGear', panel), set: $('#pvSet', panel), stage: $('#pvStage', panel), orbBtn: $('#pvOrbBtn', panel), canvas: $('#pvCanvas', panel), stTitle: $('#pvStTitle', panel), stHint: $('#pvStHint', panel) };
    ui.placeholder = ui.input.placeholder;
    if (!SR) { ui.mic.classList.add('off'); ui.mic.title = 'Voice input isn’t supported in this browser'; }
    syncSpeakBtn();
    fab.addEventListener('click', () => (S.open ? closePanel() : openPanel()));
    ui.close.addEventListener('click', closePanel);
    ui.form.addEventListener('submit', (e) => { e.preventDefault(); const q = ui.input.value; ui.input.value = ''; ask(q); });
    ui.mic.addEventListener('click', startListening);
    ui.orbBtn.addEventListener('click', () => { if (S.speaking) stopSpeaking(); else if (S.listening) stopListening(); else if (!S.busy) startListening(); });
    Orb.mount(ui.canvas); setOrb();
    ui.stop.addEventListener('click', stopSpeaking);
    ui.speak.addEventListener('click', () => { S.speakOn = !S.speakOn; store.set(K.speak, S.speakOn ? '1' : '0'); if (!S.speakOn) stopSpeaking(); syncSpeakBtn(); });
    ui.gear.addEventListener('click', () => toggleSettings());
    ui.chips.addEventListener('click', (e) => { const b = e.target.closest('button[data-q]'); if (b) ask(b.dataset.q); });
    panel.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (!ui.set.classList.contains('hidden')) { toggleSettings(false); ui.gear.focus(); return; }
      closePanel(); ui.fab.focus();
    });
    // click outside the settings closes them (composedPath: the clicked button may already have been re-rendered away)
    panel.addEventListener('click', (e) => { const path = e.composedPath ? e.composedPath() : []; if (!ui.set.classList.contains('hidden') && !path.includes(ui.set) && !path.includes(ui.gear)) toggleSettings(false); });
    if (TTS) { loadVoices(); if (window.speechSynthesis.addEventListener) window.speechSynthesis.addEventListener('voiceschanged', () => { loadVoices(); if (!ui.set.classList.contains('hidden')) renderSettings(); }); }
  }
  function syncSpeakBtn() { ui.speak.setAttribute('aria-pressed', S.speakOn ? 'true' : 'false'); ui.speak.classList.toggle('muted', !S.speakOn); ui.speak.title = S.speakOn ? 'Reading answers aloud — tap to mute' : 'Muted — tap to read answers aloud'; }

  /* ---- voice settings (⚙) ---- */
  function toggleSettings(force) {
    const open = typeof force === 'boolean' ? force : ui.set.classList.contains('hidden');
    ui.set.classList.toggle('hidden', !open); ui.gear.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) renderSettings();
  }
  function selectRow(label, options, current, onChange) {
    const row = h('div', 'pv-set-row'); const l = h('label', null, label); const id = 'pvSel' + Math.random().toString(36).slice(2, 7); l.htmlFor = id; row.appendChild(l);
    const sel = h('select'); sel.id = id;
    options.forEach(([val, txt]) => { const o = h('option', null, txt); o.value = val; if (val === current) o.selected = true; sel.appendChild(o); });
    sel.addEventListener('change', () => onChange(sel.value)); row.appendChild(sel);
    return row;
  }
  function renderSettings() {
    const el = ui.set; el.textContent = '';
    if (HD_ALLOWED) {
      const row = h('div', 'pv-set-row'); row.appendChild(h('div', 'pv-lbl', 'Voice type'));
      const seg = h('div', 'pv-seg'); seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', 'Voice type');
      [['hd', 'Natural (HD)'], ['device', 'This device']].forEach(([k, t]) => {
        const b = h('button', null, t); b.type = 'button'; b.setAttribute('aria-pressed', S.engine === k ? 'true' : 'false');
        b.addEventListener('click', () => { S.engine = k; store.set(K.engine, k); if (k === 'hd') { S.hdBlockedUntil = 0; S.hdNoted = ''; } renderSettings(); });
        seg.appendChild(b);
      });
      row.appendChild(seg); el.appendChild(row);
    }
    if (S.engine === 'hd') {
      el.appendChild(selectRow('Voice', HD_VOICES.map((n) => [n.toLowerCase(), n]), S.hdVoice, (v) => { S.hdVoice = v; store.set(K.hd, v); }));
    } else {
      const vs = englishVoices();
      const cur = (pickVoice(recLang()) || {}).voiceURI || '';
      const opts = vs.length ? vs.map((v) => [v.voiceURI, `${v.name} (${v.lang})`]) : [['', 'Default voice']];
      el.appendChild(selectRow('Voice', opts, cur, (v) => { S.devVoice = v; store.set(K.dev, v); }));
    }
    const rate = h('div', 'pv-set-row'); const rl = h('label', null, 'Speed '); rl.htmlFor = 'pvRate'; const rv = h('span', null, S.rate.toFixed(2) + '×'); rl.appendChild(rv); rate.appendChild(rl);
    const rng = h('input'); rng.type = 'range'; rng.id = 'pvRate'; rng.min = '0.75'; rng.max = '1.4'; rng.step = '0.05'; rng.value = String(S.rate);
    rng.addEventListener('input', () => { S.rate = clampRate(rng.value); rv.textContent = S.rate.toFixed(2) + '×'; if (audioEl && S.speaking) audioEl.playbackRate = S.rate; });
    rng.addEventListener('change', () => store.set(K.rate, String(S.rate)));
    rate.appendChild(rng); el.appendChild(rate);
    let note, warn = false;
    if (S.engine === 'hd') {
      if (S.hdBlockedUntil === Infinity) { note = 'The natural voice isn’t switched on for this site yet (the Worker needs the Workers AI binding). I’m using your device’s voice.'; warn = true; }
      else if (Date.now() < S.hdBlockedUntil) { note = 'The natural voice is resting (free daily allowance or a short hiccup). I’m using your device’s voice for now.'; warn = true; }
      else note = 'Natural voices run on a free daily allowance. If it runs out, I switch to your device’s voice automatically.';
    } else note = 'Uses the voices installed on this device. Voices marked Natural, Enhanced or Premium are listed first when your device has them.';
    const n = h('p', 'pv-set-note' + (warn ? ' warn' : ''), note); el.appendChild(n);
    const act = h('div', 'pv-set-actions');
    const test = h('button', 'pv-btn', 'Play sample'); test.type = 'button';
    test.addEventListener('click', () => { if (S.engine === 'hd') { S.hdBlockedUntil = 0; S.hdNoted = ''; } speak(SAMPLE, true); });
    const done = h('button', 'pv-btn ghost', 'Done'); done.type = 'button'; done.addEventListener('click', () => { toggleSettings(false); ui.gear.focus(); });
    act.appendChild(test); act.appendChild(done); el.appendChild(act);
  }

  // The orb's mood (and the little caption next to it) is worked out from what is actually happening, in one place.
  function setOrb() {
    if (!ui) return;
    const ds = ui.status.dataset.s || '';
    const st = S.listening ? 'listening' : S.speaking ? 'speaking' : (S.busy || ds === 'checking' || ds === 'preparing') ? 'thinking' : 'idle';
    ui.orb.dataset.state = st; ui.fab.dataset.state = st; ui.panel.dataset.state = st; ui.stage.dataset.state = st;
    Orb.setMood(st);
    let title, hint;
    if (st === 'listening') { title = 'Listening'; hint = 'Go ahead — I’m listening'; }
    else if (st === 'speaking') { title = 'Speaking'; hint = 'Tap the orb to stop'; }
    else if (S.busy) { title = 'Thinking'; hint = 'Searching the annual report…'; }
    else if (ds === 'checking') { title = 'Checking'; hint = 'Looking for the annual report…'; }
    else if (ds === 'preparing') { title = 'Reading report'; hint = 'First time for this company — a few minutes'; }
    else if (ds === 'ready') { title = 'Ready'; hint = SR ? 'Tap the orb to ask, or type below' : 'Type your question below'; }
    else { title = 'Offline'; hint = 'The annual report isn’t available yet'; }
    if (ui.stTitle.textContent !== title) ui.stTitle.textContent = title;
    if (ui.stHint.textContent !== hint) ui.stHint.textContent = hint;
  }
  function openPanel() {
    if (!S.sym) return;
    S.open = true; ui.panel.classList.remove('hidden'); ui.fab.setAttribute('aria-expanded', 'true'); document.documentElement.classList.add('pv-open');
    if (!S.report && !S.pollTimer && ui.status.dataset.s !== 'preparing') ensureReport();
    Orb.start();
    if (window.matchMedia && window.matchMedia('(hover: hover)').matches) setTimeout(() => ui.input.focus(), 50);
  }
  function closePanel() {
    S.open = false; ui.panel.classList.add('hidden'); ui.fab.setAttribute('aria-expanded', 'false'); document.documentElement.classList.remove('pv-open');
    toggleSettings(false); stopSpeaking(); abortListening(); Orb.stop();
  }

  function setStatus(state, info) {
    const el = ui.status; el.dataset.s = state; el.textContent = ''; el.classList.remove('hidden');
    ui.form.classList.toggle('disabled', state !== 'ready'); ui.input.disabled = state !== 'ready'; ui.send.disabled = state !== 'ready'; ui.mic.disabled = state !== 'ready'; ui.orbBtn.disabled = state !== 'ready';
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
    setOrb();
  }

  function scrollLog() { ui.log.scrollTop = ui.log.scrollHeight; }
  function addUser(t) { const m = h('div', 'pv-msg user'); m.appendChild(h('p', null, t)); ui.log.appendChild(m); ui.stage.classList.add('compact'); renderChips(); scrollLog(); }
  function addBotNote(t) { const m = h('div', 'pv-msg bot note'); m.appendChild(h('p', null, t)); ui.log.appendChild(m); scrollLog(); }
  function listenBtn(text) {
    const play = h('button', 'pv-replay'); play.type = 'button'; play.innerHTML = ICON.play + '<span>Listen</span>';
    play.addEventListener('click', () => { unlockAudio(); speak(text, true); });
    return play;
  }
  function addBotSimple(t) {
    const m = h('div', 'pv-msg bot'); m.appendChild(h('p', 'pv-spoken', t));
    m.appendChild(listenBtn(t)); ui.log.appendChild(m); scrollLog(); speak(t);
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
    m.appendChild(listenBtn(j.spoken || ''));
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
    ui.log.textContent = ''; ui.chips.textContent = ''; ui.status.textContent = ''; ui.status.dataset.s = ''; ui.stage.classList.remove('compact');
    ui.send.disabled = false; setOrb();
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
    document.addEventListener('visibilitychange', () => { if (document.hidden) { stopSpeaking(); Orb.stop(); } else if (S.open) Orb.start(); });
    onRoute();
    window.PlutusVoice = { open: openPanel, close: closePanel, ask, _retrieve: retrieve, _state: S, _orb: Orb }; // handy for debugging / tests
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
