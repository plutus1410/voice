/* ============================================================
   PLUTUS — analysis engine (pure functions, no DOM)
   Turns raw Yahoo Finance payloads into a clean company model,
   health scores, peer ranks and plain-English
   strengths/weaknesses. Nothing here gives a buy/sell/hold view.
   ============================================================ */
(function (root) {
  'use strict';

  // ---------- small helpers ----------
  const isNum = (v) => typeof v === 'number' && isFinite(v);
  const raw = (o) => (o && typeof o === 'object' ? (isNum(o.raw) ? o.raw : null) : (isNum(o) ? o : null));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const last = (arr) => (arr && arr.length ? arr[arr.length - 1] : null);
  const lastNum = (arr) => { if (!arr) return null; for (let i = arr.length - 1; i >= 0; i--) if (isNum(arr[i])) return arr[i]; return null; };
  const prevNum = (arr) => { if (!arr) return null; let seen = 0; for (let i = arr.length - 1; i >= 0; i--) if (isNum(arr[i])) { if (seen++) return arr[i]; } return null; };
  const avg = (xs) => { const v = xs.filter(isNum); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const median = (xs) => { const v = xs.filter(isNum).sort((a, b) => a - b); if (!v.length) return null; const m = Math.floor(v.length / 2); return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
  const lin = (v, a, b) => (isNum(v) ? clamp((v - a) / (b - a), 0, 1) * 100 : null); // a -> 0, b -> 100
  const growth = (now, before) => (isNum(now) && isNum(before) && before > 0 ? now / before - 1 : null);
  const cagr = (series) => {
    const pts = series.map((v, i) => ({ v, i })).filter((p) => isNum(p.v));
    if (pts.length < 2) return null;
    const a = pts[0], b = pts[pts.length - 1];
    if (a.v <= 0 || b.v <= 0) return null;
    return Math.pow(b.v / a.v, 1 / (b.i - a.i)) - 1;
  };

  const CUR_SYM = { USD: '$', INR: '₹', EUR: '€', GBP: '£', JPY: '¥', CNY: '¥', HKD: 'HK$', TWD: 'NT$', KRW: '₩', CAD: 'C$', AUD: 'A$', CHF: 'CHF ', SGD: 'S$', BRL: 'R$' };
  const curSym = (c) => CUR_SYM[c] || (c ? c + ' ' : '');

  // ---------- formatting (shared with UI) ----------
  function fmtMoney(v, cur) {
    if (!isNum(v)) return '—';
    const s = curSym(cur), sign = v < 0 ? '-' : '', a = Math.abs(v);
    if (cur === 'INR') {
      const cr = a / 1e7;
      if (cr >= 1e5) return `${sign}${s}${(cr / 1e5).toFixed(2)} L Cr`;
      if (cr >= 1) return `${sign}${s}${cr.toLocaleString('en-IN', { maximumFractionDigits: cr >= 100 ? 0 : 2 })} Cr`;
      if (a >= 1e5) return `${sign}${s}${(a / 1e5).toFixed(2)} L`;
      return `${sign}${s}${a.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
    }
    const units = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
    for (const [d, u] of units) if (a >= d) return `${sign}${s}${(a / d).toFixed(2)}${u}`;
    return `${sign}${s}${a.toFixed(2)}`;
  }
  const fmtPrice = (v, cur) => (isNum(v) ? `${curSym(cur)}${v.toLocaleString(cur === 'INR' ? 'en-IN' : 'en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—');
  const fmtPct = (v, d = 1, plus = false) => (isNum(v) ? `${plus && v > 0 ? '+' : ''}${(v * 100).toFixed(d)}%` : '—');
  const fmtX = (v, d = 1) => (isNum(v) ? `${v.toFixed(d)}×` : '—');

  // ---------- parsers ----------
  function parseChart(res) {
    const r = res && res.chart && res.chart.result && res.chart.result[0];
    if (!r) return null;
    const ts = r.timestamp || [];
    const close = (r.indicators && r.indicators.quote && r.indicators.quote[0] && r.indicators.quote[0].close) || [];
    const pts = [];
    ts.forEach((t, i) => { const v = close[i]; if (isNum(v)) pts.push({ t: t * 1000, v }); });
    const divs = r.events && r.events.dividends ? Object.values(r.events.dividends) : [];
    return { meta: r.meta || {}, pts, divs };
  }
  function parseTimeseries(res) {
    const out = {}; let currency = null;
    const results = (res && res.timeseries && res.timeseries.result) || [];
    for (const r of results) {
      const type = r.meta && r.meta.type && r.meta.type[0];
      if (!type || !Array.isArray(r[type])) continue;
      const rows = r[type].filter(Boolean)
        .map((x) => { if (!currency && x.currencyCode) currency = x.currencyCode; return { date: x.asOfDate, v: x.reportedValue ? x.reportedValue.raw : null }; })
        .filter((x) => x.date && isNum(x.v))
        .sort((a, b) => a.date.localeCompare(b.date));
      if (rows.length) out[type] = rows;
    }
    return { data: out, currency };
  }
  function parseSummary(res) {
    const r = res && res.quoteSummary && res.quoteSummary.result && res.quoteSummary.result[0];
    return r || {};
  }

  // ---------- model ----------
  const ANNUAL = ['TotalRevenue', 'NetIncome', 'NetIncomeCommonStockholders', 'GrossProfit', 'OperatingIncome', 'DilutedEPS', 'BasicEPS',
    'OperatingCashFlow', 'FreeCashFlow', 'CapitalExpenditure', 'TotalDebt', 'StockholdersEquity', 'CurrentAssets', 'CurrentLiabilities',
    'CashAndCashEquivalents', 'TotalAssets', 'DilutedAverageShares'];
  const QUARTERLY = ['TotalRevenue', 'NetIncome', 'NetIncomeCommonStockholders', 'GrossProfit', 'OperatingIncome', 'DilutedEPS', 'BasicEPS',
    'OperatingCashFlow', 'FreeCashFlow', 'CapitalExpenditure', 'TotalDebt', 'StockholdersEquity'];
  const TIMESERIES_TYPES = [...ANNUAL.map((t) => 'annual' + t), ...QUARTERLY.map((t) => 'quarterly' + t)];
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // Aligned period table (annual or quarterly)
  function periodTable(ts, prefix, keep, labelFn) {
    const map = (k) => { const m = {}; (ts[prefix + k] || []).forEach((r) => (m[r.date] = r.v)); return m; };
    const T = {}; ANNUAL.forEach((k) => (T[k] = map(k)));
    const ds = new Set([...Object.keys(T.TotalRevenue), ...Object.keys(T.NetIncome), ...Object.keys(T.NetIncomeCommonStockholders)]);
    const dates = [...ds].sort().slice(-keep);
    const col = (k, alt) => dates.map((dt) => (isNum(T[k][dt]) ? T[k][dt] : alt && isNum(T[alt][dt]) ? T[alt][dt] : null));
    const revenue = col('TotalRevenue'), netIncome = col('NetIncome', 'NetIncomeCommonStockholders');
    const grossProfit = col('GrossProfit'), opIncome = col('OperatingIncome'), eps = col('DilutedEPS', 'BasicEPS');
    const ocf = col('OperatingCashFlow'), capex = col('CapitalExpenditure');
    const fcf = col('FreeCashFlow').map((v, i) => (isNum(v) ? v : isNum(ocf[i]) && isNum(capex[i]) ? ocf[i] + capex[i] : null));
    const ratio = (a, b) => a.map((v, i) => (isNum(v) && isNum(b[i]) && b[i] !== 0 ? v / b[i] : null));
    return {
      labels: dates.map(labelFn), dates, revenue, netIncome, grossProfit, opIncome, eps, ocf, capex, fcf,
      debt: col('TotalDebt'), equity: col('StockholdersEquity'),
      curAssets: col('CurrentAssets'), curLiab: col('CurrentLiabilities'), totalAssets: col('TotalAssets'),
      cash: col('CashAndCashEquivalents'), shares: col('DilutedAverageShares'),
      netMarginS: ratio(netIncome, revenue), grossMarginS: ratio(grossProfit, revenue), opMarginS: ratio(opIncome, revenue)
    };
  }

  // ---------- statement-currency check ----------
  // Rough units of each currency per 1 USD. Used ONLY to tell whether two currencies are far apart
  // (INR vs USD) or close (USD vs EUR). Never used to convert a money amount.
  const PER_USD = { USD: 1, INR: 83, JPY: 150, KRW: 1350, TWD: 32, CNY: 7.2, HKD: 7.8, EUR: 0.92, GBP: 0.79, GBp: 79, CHF: 0.88, CAD: 1.37,
    AUD: 1.5, SGD: 1.35, BRL: 5.2, MXN: 18, ZAR: 18, SEK: 10.5, NOK: 10.5, DKK: 6.9, IDR: 15500, THB: 35, MYR: 4.6, ILS: 3.7, TRY: 32, PLN: 4, SAR: 3.75 };
  // Decide which currency the financial statements are really in.
  // Yahoo's own trailing EPS / P/E are always in the TRADING currency, so compare them with the statement EPS:
  // same currency -> within a few x of each other; far-apart currencies -> off by roughly the FX rate.
  function resolveFinCurrency(o) {
    const label = o.label, pc = o.priceCur;
    if (!label || label === pc) return { cur: label || pc, corrected: false };
    const a = PER_USD[label], b = PER_USD[pc];
    if (a && b) { const rate = a / b; if (rate > 0.6 && rate < 1.7) return { cur: label, corrected: false }; } // too close to tell apart: keep the label
    const within = (r, lo, hi) => isNum(r) && r >= lo && r <= hi;
    let same = null;
    if (isNum(o.yahooEps) && isNum(o.stmtEps) && o.yahooEps > 0 && o.stmtEps > 0) same = within(o.yahooEps / o.stmtEps, 0.25, 4);
    else if (isNum(o.yahooPe) && isNum(o.stmtEps) && isNum(o.price) && o.yahooPe > 0 && o.stmtEps > 0) same = within(o.price / o.stmtEps / o.yahooPe, 0.25, 4);
    if (same === true) return { cur: pc, corrected: true };  // numbers are in the trading currency: the label is wrong
    return { cur: label, corrected: false };                 // numbers really differ (or no way to tell): keep the label
  }
  function buildModel(symbol, chart5y, chart1y, tsRes, sumRes, searchHit) {
    const w = parseChart(chart5y), d = parseChart(chart1y);
    const { data: ts, currency: tsCur } = parseTimeseries(tsRes);
    const S = parseSummary(sumRes);
    const price = S.price || {}, sd = S.summaryDetail || {}, ks = S.defaultKeyStatistics || {}, fd = S.financialData || {}, ap = S.assetProfile || {};
    const meta = (d && d.meta) || (w && w.meta) || {};
    const currency = price.currency || meta.currency || 'USD';
    const finCurrencyLabel = fd.financialCurrency || tsCur || currency; // Yahoo's label - not always right (see resolveFinCurrency)
    const AN = periodTable(ts, 'annual', 5, (dt) => 'FY' + dt.slice(2, 4));
    const QT = periodTable(ts, 'quarterly', 8, (dt) => `${MON[+dt.slice(5, 7) - 1]} '${dt.slice(2, 4)}`);
    const { revenue, netIncome, opIncome, eps, fcf, debt, equity, curAssets, curLiab, totalAssets, shares, netMarginS, grossMarginS, opMarginS } = AN;

    // ----- price -----
    const lastPrice = raw(price.regularMarketPrice) ?? meta.regularMarketPrice ?? (d && last(d.pts) ? last(d.pts).v : null);
    let changePct = raw(price.regularMarketChangePercent), change = raw(price.regularMarketChange);
    if (!isNum(changePct) && d && d.pts.length > 1) {
      const p0 = d.pts[d.pts.length - 2].v; change = lastPrice - p0; changePct = change / p0;
    }
    const dailyVals = d ? d.pts.map((p) => p.v) : [];
    const high52 = raw(sd.fiftyTwoWeekHigh) ?? meta.fiftyTwoWeekHigh ?? (dailyVals.length ? Math.max(...dailyVals) : null);
    const low52 = raw(sd.fiftyTwoWeekLow) ?? meta.fiftyTwoWeekLow ?? (dailyVals.length ? Math.min(...dailyVals) : null);
    let ret1y = null, vol = null, maxDD = null;
    if (dailyVals.length > 20) {
      ret1y = dailyVals[dailyVals.length - 1] / dailyVals[0] - 1;
      const lr = []; for (let i = 1; i < dailyVals.length; i++) lr.push(Math.log(dailyVals[i] / dailyVals[i - 1]));
      const mu = avg(lr); vol = Math.sqrt(lr.reduce((s, x) => s + (x - mu) ** 2, 0) / (lr.length - 1)) * Math.sqrt(252);
      let peak = dailyVals[0]; maxDD = 0;
      for (const v of dailyVals) { peak = Math.max(peak, v); maxDD = Math.min(maxDD, v / peak - 1); }
    }
    let ret5y = null;
    if (w && w.pts.length > 50) ret5y = last(w.pts).v / w.pts[0].v - 1;

    // ----- EPS / PE -----
    const qEps = (ts.quarterlyDilutedEPS || []).map((r) => r.v);
    const ttmEps = raw(ks.trailingEps) ?? (qEps.length >= 4 ? qEps.slice(-4).reduce((a, b) => a + b, 0) : lastNum(eps));
    // Yahoo sometimes labels a statement currency wrongly (e.g. INFY.NS: figures in INR, label says USD).
    // Trust the label only if the numbers agree with it; otherwise use the currency the share trades in.
    const fin = resolveFinCurrency({ label: finCurrencyLabel, priceCur: currency, price: lastPrice,
      yahooEps: raw(ks.trailingEps), yahooPe: raw(sd.trailingPE), stmtEps: lastNum(eps) });
    const finCurrency = fin.cur;
    const sameCur = currency === finCurrency;
    let pe = raw(sd.trailingPE);
    if (!isNum(pe) && sameCur && isNum(ttmEps) && ttmEps > 0 && isNum(lastPrice)) pe = lastPrice / ttmEps;
    const negEarnings = isNum(ttmEps) ? ttmEps <= 0 : isNum(lastNum(netIncome)) ? lastNum(netIncome) <= 0 : false;
    const fwdPe = raw(sd.forwardPE) ?? raw(ks.forwardPE);
    const pb = raw(ks.priceToBook);
    // P/E history: weekly price ÷ latest annual EPS known at that date
    const peHistory = [];
    const epsRows = (ts.annualDilutedEPS || ts.annualBasicEPS || []).filter((r) => isNum(r.v));
    if (w && sameCur && epsRows.length) {
      const epsTs = epsRows.map((r) => ({ t: Date.parse(r.date), v: r.v }));
      for (const p of w.pts) {
        let e = null; for (const r of epsTs) if (r.t <= p.t) e = r.v;
        if (isNum(e) && e > 0) { const x = p.v / e; if (x > 0 && x < 400) peHistory.push({ t: p.t, v: x }); }
      }
    }
    const peMedian = median(peHistory.map((p) => p.v));

    // ----- headline numbers -----
    const marketCap = raw(price.marketCap) ?? raw(sd.marketCap) ?? (isNum(lastPrice) && isNum(lastNum(shares)) && sameCur ? lastPrice * lastNum(shares) : null);
    const revLast = lastNum(revenue), revPrev = prevNum(revenue);
    const niLast = lastNum(netIncome), niPrev = prevNum(netIncome);
    const netMargin = lastNum(netMarginS), netMarginPrev = prevNum(netMarginS);
    const eqLast = lastNum(equity), debtLast = lastNum(debt);
    const roe = isNum(niLast) && isNum(eqLast) && eqLast > 0 ? niLast / eqLast : raw(fd.returnOnEquity);
    const de = isNum(debtLast) && isNum(eqLast) && eqLast > 0 ? debtLast / eqLast : (isNum(raw(fd.debtToEquity)) ? raw(fd.debtToEquity) / 100 : null);
    const currentRatio = isNum(lastNum(curAssets)) && isNum(lastNum(curLiab)) && lastNum(curLiab) > 0 ? lastNum(curAssets) / lastNum(curLiab) : raw(fd.currentRatio);
    const equityToAssets = isNum(eqLast) && isNum(lastNum(totalAssets)) ? eqLast / lastNum(totalAssets) : null;
    const fcfLast = lastNum(fcf);
    const fcfMargin = isNum(fcfLast) && isNum(revLast) && revLast > 0 ? fcfLast / revLast : null;
    let divYield = raw(sd.dividendYield) ?? raw(sd.trailingAnnualDividendYield);
    if (!isNum(divYield) && d && d.divs.length && isNum(lastPrice)) {
      const yearAgo = Date.now() - 365 * 864e5;
      const sum = d.divs.filter((x) => x.date * 1000 >= yearAgo).reduce((s, x) => s + (x.amount || 0), 0);
      divYield = sum > 0 ? sum / lastPrice : 0;
    }
    const beta = raw(sd.beta) ?? raw(ks.beta);
    const sector = ap.sector || (searchHit && searchHit.sector) || '';
    const industry = ap.industry || (searchHit && searchHit.industry) || '';
    const isFinancial = /financial/i.test(sector) || /bank|insurance|capital markets|credit|asset management/i.test(industry);
    const revYoY = growth(revLast, revPrev), niYoY = growth(niLast, niPrev);
    const revCAGR = cagr(revenue), niCAGR = cagr(netIncome);
    const nYears = revenue.filter(isNum).length;
    const profitableYears = netIncome.filter((v) => isNum(v) && v > 0).length, niYears = netIncome.filter(isNum).length;
    let revUpYears = 0, revPairs = 0;
    for (let i = 1; i < revenue.length; i++) if (isNum(revenue[i]) && isNum(revenue[i - 1])) { revPairs++; if (revenue[i] > revenue[i - 1]) revUpYears++; }
    let niUpYears = 0, niPairs = 0;
    for (let i = 1; i < netIncome.length; i++) if (isNum(netIncome[i]) && isNum(netIncome[i - 1])) { niPairs++; if (netIncome[i] > netIncome[i - 1]) niUpYears++; }
    const fcfPositiveYears = fcf.filter((v) => isNum(v) && v > 0).length, fcfYears = fcf.filter(isNum).length;
    const pos52 = isNum(lastPrice) && isNum(high52) && isNum(low52) && high52 > low52 ? clamp((lastPrice - low52) / (high52 - low52), 0, 1) : null;

    const m = {
      symbol, currency, finCurrency, sameCur,
      name: price.longName || price.shortName || meta.longName || meta.shortName || (searchHit && searchHit.name) || symbol,
      exchange: price.exchangeName || meta.fullExchangeName || meta.exchangeName || (searchHit && searchHit.exch) || '',
      sector, industry, isFinancial,
      industryKey: ap.industryKey || '', sectorKey: ap.sectorKey || '',
      summary: ap.longBusinessSummary || '', website: ap.website || '', employees: ap.fullTimeEmployees || null,
      country: ap.country || '', city: ap.city || '',
      price: lastPrice, change, changePct, marketCap, high52, low52, pos52,
      pe, fwdPe, pb, peMedian, peHistory, negEarnings, ttmEps, divYield, beta,
      roe, de, currentRatio, equityToAssets, fcfLast, fcfMargin,
      revLast, revYoY, revCAGR, niLast, niYoY, niCAGR, netMargin, netMarginPrev,
      grossMargin: lastNum(grossMarginS), opMargin: lastNum(opMarginS),
      ret1y, ret5y, vol, maxDD,
      nYears, profitableYears, niYears, revUpYears, revPairs, niUpYears, niPairs, fcfPositiveYears, fcfYears,
      priceWeekly: w ? w.pts : [], priceDaily: d ? d.pts : [],
      annual: AN, quarterly: QT,
      hasFundamentals: nYears > 0,
      hasProfile: !!(S.price || S.assetProfile)
    };
    m.scores = score(m);
    const sw = strengthsWeaknesses(m);
    m.strengths = sw.strengths; m.weaknesses = sw.weaknesses;
    m.takeaways = takeaways(m);
    return m;
  }

  // ---------- scoring (0–100 per pillar; descriptive, not a recommendation) ----------
  function score(m) {
    const pillars = [
      { key: 'growth', name: 'Growth', hint: 'How fast sales and profits are rising',
        score: avg([lin(m.revCAGR, -0.05, 0.15), lin(isNum(m.niCAGR) ? m.niCAGR : m.niYoY, -0.10, 0.20)]) },
      { key: 'profit', name: 'Profitability', hint: 'How much of every sale turns into profit',
        score: avg([lin(m.netMargin, 0, 0.20), lin(m.roe, 0, 0.22), m.isFinancial ? null : lin(m.opMargin, 0, 0.25)]) },
      { key: 'strength', name: 'Balance Sheet', hint: 'How safely the company is funded',
        score: m.isFinancial
          ? avg([lin(m.equityToAssets, 0.04, 0.15)])
          : avg([lin(m.de, 2, 0), lin(m.currentRatio, 0.8, 2), isNum(m.fcfLast) ? (m.fcfLast > 0 ? 85 : 15) : null]) },
      { key: 'value', name: 'Price Tag', hint: 'Cheaper vs. profits scores higher',
        score: m.negEarnings ? 10 : avg([lin(m.pe, 60, 8), isNum(m.peMedian) && isNum(m.pe) ? lin(m.pe / m.peMedian, 1.5, 0.7) : null]) },
      { key: 'stability', name: 'Stability', hint: 'How calm the share price has been',
        score: avg([lin(m.vol, 0.6, 0.15), lin(m.maxDD, -0.5, -0.08)]) },
      { key: 'track', name: 'Track Record', hint: 'How consistently it grows and stays profitable',
        score: avg([m.niYears ? (m.profitableYears / m.niYears) * 100 : null, m.revPairs ? (m.revUpYears / m.revPairs) * 100 : null]) }
    ];
    pillars.forEach((p) => (p.score = isNum(p.score) ? Math.round(p.score) : null));
    const overall = avg(pillars.map((p) => p.score));
    const o = isNum(overall) ? Math.round(overall) : null;
    const tier = o == null ? { label: 'Insufficient data', cls: 'muted' } : o >= 80 ? { label: 'Very strong fundamentals', cls: 'good' } : o >= 60 ? { label: 'Solid fundamentals', cls: 'good' } : o >= 40 ? { label: 'Mixed signals', cls: 'warn' } : { label: 'Weak signals', cls: 'bad' };
    return { pillars, overall: o, tier };
  }

  // ---------- plain-English strengths & weaknesses ----------
  function strengthsWeaknesses(m) {
    const S = [], W = [];
    const c = m.finCurrency, sym = curSym(c).trim() || c;
    const add = (arr, title, text, metric) => arr.push({ title, text, metric });

    if (isNum(m.revCAGR)) {
      const n = m.revPairs;
      if (m.revCAGR >= 0.10) add(S, 'Sales are growing fast', `Revenue has grown about ${fmtPct(m.revCAGR, 0)} a year over the last ${n} years — customers are buying more and more.`, fmtPct(m.revCAGR, 1, true) + ' / yr');
      else if (m.revCAGR >= 0.04) add(S, 'Steady sales growth', `Revenue has grown about ${fmtPct(m.revCAGR, 0)} a year over the last ${n} years.`, fmtPct(m.revCAGR, 1, true) + ' / yr');
      else if (m.revCAGR < 0) add(W, 'Sales are shrinking', `Revenue has fallen about ${fmtPct(Math.abs(m.revCAGR), 0)} a year over the last ${n} years.`, fmtPct(m.revCAGR, 1, true) + ' / yr');
      else add(W, 'Sales are barely growing', `Revenue grew only about ${fmtPct(m.revCAGR, 1)} a year over the last ${n} years.`, fmtPct(m.revCAGR, 1, true) + ' / yr');
    }
    if (isNum(m.niLast) && isNum(m.niYoY)) {
      if (m.niYoY >= 0.15) add(S, 'Profit jumped last year', `Net profit rose ${fmtPct(m.niYoY, 0)} in the latest financial year.`, fmtPct(m.niYoY, 0, true));
      else if (m.niYoY <= -0.15) add(W, 'Profit fell last year', `Net profit dropped ${fmtPct(Math.abs(m.niYoY), 0)} in the latest financial year.`, fmtPct(m.niYoY, 0, true));
    } else if (isNum(m.niLast) && m.niLast <= 0) {
      add(W, 'The company is losing money', `It reported a net loss of ${fmtMoney(Math.abs(m.niLast), c)} in the latest financial year.`, 'Loss');
    }
    if (isNum(m.netMargin)) {
      const per100 = (m.netMargin * 100).toFixed(m.netMargin * 100 < 10 ? 1 : 0);
      if (m.netMargin >= 0.15) add(S, 'Keeps a big slice of every sale', `Out of every ${sym}100 of sales, about ${sym}${per100} is left as profit after all costs.`, fmtPct(m.netMargin) + ' margin');
      else if (m.netMargin > 0 && m.netMargin < 0.05) add(W, 'Thin profit cushion', `Out of every ${sym}100 of sales, only about ${sym}${per100} is left as profit — small cost increases can hurt.`, fmtPct(m.netMargin) + ' margin');
    }
    if (isNum(m.netMargin) && isNum(m.netMarginPrev)) {
      const dm = m.netMargin - m.netMarginPrev;
      if (dm >= 0.02) add(S, 'Becoming more profitable', `Profit margin improved by ${(dm * 100).toFixed(1)} percentage points versus the year before.`, `+${(dm * 100).toFixed(1)} pts`);
      else if (dm <= -0.02) add(W, 'Profit margin is shrinking', `Profit margin slipped by ${(Math.abs(dm) * 100).toFixed(1)} percentage points versus the year before.`, `${(dm * 100).toFixed(1)} pts`);
    }
    if (isNum(m.roe)) {
      if (m.roe >= 0.18) add(S, 'Uses shareholder money efficiently', `For every ${sym}100 owned by shareholders, it earned about ${sym}${(m.roe * 100).toFixed(0)} of profit last year.`, fmtPct(m.roe, 0) + ' ROE');
      else if (m.roe > 0 && m.roe < 0.08) add(W, 'Low return on shareholder money', `For every ${sym}100 owned by shareholders, it earned only about ${sym}${(m.roe * 100).toFixed(1)} of profit last year.`, fmtPct(m.roe, 1) + ' ROE');
    }
    if (m.niYears >= 3 && m.profitableYears === m.niYears) add(S, 'Profitable every year', `Made a profit in all ${m.niYears} years of reported data.`, `${m.niYears}/${m.niYears} yrs`);
    else if (m.niYears >= 3 && m.profitableYears < m.niYears) add(W, 'Profits are not consistent', `Made a loss in ${m.niYears - m.profitableYears} of the last ${m.niYears} reported years.`, `${m.profitableYears}/${m.niYears} yrs`);

    if (m.isFinancial) {
      if (isNum(m.equityToAssets)) {
        if (m.equityToAssets >= 0.12) add(S, 'Strong capital cushion', `Shareholders' own money funds about ${fmtPct(m.equityToAssets, 0)} of total assets (borrowing is normal for financial companies).`, fmtPct(m.equityToAssets, 0));
        else if (m.equityToAssets < 0.07) add(W, 'Thin capital cushion', `Shareholders' own money funds only about ${fmtPct(m.equityToAssets, 1)} of total assets.`, fmtPct(m.equityToAssets, 1));
      }
    } else {
      if (isNum(m.de)) {
        if (m.de < 0.3) add(S, 'Very little debt', `It owes only ${sym}${(m.de * 100).toFixed(0)} for every ${sym}100 that shareholders own — low pressure from lenders.`, fmtX(m.de, 2) + ' D/E');
        else if (m.de > 1.5) add(W, 'Carries heavy debt', `It owes about ${sym}${(m.de * 100).toFixed(0)} for every ${sym}100 that shareholders own — interest payments can squeeze profits.`, fmtX(m.de, 2) + ' D/E');
      }
      if (isNum(m.currentRatio)) {
        if (m.currentRatio < 1) add(W, 'Short-term bills exceed short-term assets', `For every ${sym}1 due within a year it has about ${sym}${m.currentRatio.toFixed(2)} of assets that turn into cash within a year.`, fmtX(m.currentRatio, 2));
        else if (m.currentRatio >= 1.8) add(S, 'Comfortable short-term liquidity', `Has about ${sym}${m.currentRatio.toFixed(2)} of near-cash assets for every ${sym}1 of bills due within a year.`, fmtX(m.currentRatio, 2));
      }
      if (m.fcfYears >= 3 && m.fcfPositiveYears === m.fcfYears) add(S, 'Generates real cash', `Produced positive free cash flow (cash left after investing in the business) in all ${m.fcfYears} reported years.`, fmtMoney(m.fcfLast, c));
      else if (isNum(m.fcfLast) && m.fcfLast < 0) add(W, 'Burning cash', `Spent ${fmtMoney(Math.abs(m.fcfLast), c)} more than it brought in last year after investments.`, fmtMoney(m.fcfLast, c));
    }
    if (m.negEarnings) add(W, 'No earnings to value it on', 'Because the company is not currently profitable, the usual price-to-earnings yardstick does not work.', 'P/E n/a');
    else if (isNum(m.pe)) {
      if (isNum(m.peMedian) && m.pe > m.peMedian * 1.25) add(W, 'Priced higher than its own history', `Investors now pay ${fmtX(m.pe, 1)} its yearly profit, above its 5-year typical level of ${fmtX(m.peMedian, 1)}.`, fmtX(m.pe, 1) + ' P/E');
      else if (isNum(m.peMedian) && m.pe < m.peMedian * 0.8) add(S, 'Priced lower than its own history', `Investors now pay ${fmtX(m.pe, 1)} its yearly profit, below its 5-year typical level of ${fmtX(m.peMedian, 1)}.`, fmtX(m.pe, 1) + ' P/E');
      if (m.pe > 45) add(W, 'Expensive price tag', `The share price equals about ${Math.round(m.pe)} years of current profit — high expectations are baked in.`, fmtX(m.pe, 0) + ' P/E');
      else if (m.pe < 12) add(S, 'Modest price tag', `The share price equals about ${m.pe.toFixed(0)} years of current profit.`, fmtX(m.pe, 1) + ' P/E');
    }
    if (isNum(m.divYield) && m.divYield >= 0.02) add(S, 'Pays shareholders regularly', `Pays a yearly dividend of about ${fmtPct(m.divYield, 1)} of the share price.`, fmtPct(m.divYield, 1) + ' yield');
    if (isNum(m.vol)) {
      if (m.vol >= 0.45) add(W, 'Bumpy ride', `The share price swings a lot — typical yearly movement is around ±${fmtPct(m.vol, 0)}.`, fmtPct(m.vol, 0) + ' vol');
      else if (m.vol <= 0.22) add(S, 'Relatively calm share price', `Typical yearly price movement is around ±${fmtPct(m.vol, 0)}, calmer than many stocks.`, fmtPct(m.vol, 0) + ' vol');
    }
    if (isNum(m.maxDD) && m.maxDD <= -0.35) add(W, 'Had a deep fall this year', `At its worst point in the last 12 months the price was ${fmtPct(Math.abs(m.maxDD), 0)} below its previous high.`, fmtPct(m.maxDD, 0));
    return { strengths: S, weaknesses: W };
  }

  // ---------- one-line factual takeaways for each chart ----------
  function takeaways(m) {
    const t = {}, c = m.finCurrency;
    if (isNum(m.ret5y)) t.price = `Share price is ${m.ret5y >= 0 ? 'up' : 'down'} ${fmtPct(Math.abs(m.ret5y), 0)} over 5 years${isNum(m.ret1y) ? ` and ${m.ret1y >= 0 ? 'up' : 'down'} ${fmtPct(Math.abs(m.ret1y), 0)} over the last 12 months` : ''}.`;
    else if (isNum(m.ret1y)) t.price = `Share price is ${m.ret1y >= 0 ? 'up' : 'down'} ${fmtPct(Math.abs(m.ret1y), 0)} over the last 12 months.`;
    if (m.revPairs) t.revenue = `Revenue rose in ${m.revUpYears} of ${m.revPairs} years; net profit rose in ${m.niUpYears} of ${m.niPairs} years.`;
    if (isNum(m.netMargin)) t.margins = `Latest net margin: ${fmtPct(m.netMargin)}${isNum(m.netMarginPrev) ? ` (previous year ${fmtPct(m.netMarginPrev)})` : ''}.`;
    if (isNum(m.pe) && isNum(m.peMedian)) t.pe = `Current P/E ${fmtX(m.pe, 1)} vs. 5-year median ${fmtX(m.peMedian, 1)} — ${m.pe > m.peMedian ? 'above' : 'below'} its usual level.`;
    else if (m.negEarnings) t.pe = 'Earnings are negative, so P/E is not meaningful right now.';
    if (m.fcfYears) t.cash = `Free cash flow was positive in ${m.fcfPositiveYears} of ${m.fcfYears} years (latest ${fmtMoney(m.fcfLast, c)}).`;
    if (isNum(m.de)) t.debt = m.isFinancial ? 'Banks and insurers borrow as part of their business model — compare with peers.' : `Debt is ${fmtX(m.de, 2)} equity in the latest year.`;
    const e = m.annual.eps.filter(isNum);
    if (e.length > 1) t.eps = `Earnings per share went from ${e[0].toFixed(2)} to ${e[e.length - 1].toFixed(2)} (${c}).`;
    return t;
  }

  // ---------- industry-peer comparison ----------
  const PEER_METRICS = [
    { key: 'marketCap', name: 'Size', label: 'Market Cap', better: 'high', fmt: 'money', best: 'Largest' },
    { key: 'revGrowth', name: 'Sales Growth', label: 'Revenue Growth (YoY)', better: 'high', fmt: 'pct', best: 'Fastest-growing' },
    { key: 'netMargin', name: 'Profit Margin', label: 'Net Margin', better: 'high', fmt: 'pct', best: 'Most profitable' },
    { key: 'roe', name: 'Efficiency', label: 'Return on Equity', better: 'high', fmt: 'pct', best: 'Most efficient' },
    { key: 'de', name: 'Low Debt', label: 'Debt / Equity', better: 'low', fmt: 'x', best: 'Least indebted' },
    { key: 'pe', name: 'Price Tag', label: 'P/E Ratio', better: 'low', fmt: 'x', best: 'Lowest P/E' },
    { key: 'ret1y', name: 'Momentum', label: '1-Year Return', better: 'high', fmt: 'pct', best: 'Best 1-yr return' }
  ];

  // A P/E that is zero, negative or absurdly large is not a usable value for ranking or averaging
  const validPe = (v) => (isNum(v) && v > 0 && v < 300 ? v : null);

  // Turn a full company model into a flat row for the peer table / ranking
  function peerRowFromModel(m, isMain) {
    return {
      symbol: m.symbol, name: m.name, website: m.website, currency: m.currency, isMain: !!isMain,
      marketCap: m.marketCap,
      revGrowth: m.revYoY,
      netMargin: m.netMargin,
      roe: m.roe,
      de: m.isFinancial ? null : m.de,
      pe: m.negEarnings ? null : validPe(m.pe),
      ret1y: m.ret1y
    };
  }

  function peerCompare(main, peers, isFinancial) {
    const rows = [main, ...peers];
    // Simple average of the industry peers (the company itself is not included)
    const avgRow = { symbol: 'AVG', name: 'Industry average', isAvg: true };
    PEER_METRICS.forEach((mt) => {
      const vs = peers.map((r) => r[mt.key]).filter((v) => isNum(v) && !(mt.key === 'pe' && !validPe(v)));
      avgRow[mt.key] = vs.length >= 2 ? avg(vs) : null;
    });
    const ranks = PEER_METRICS.filter((mt) => !(isFinancial && mt.key === 'de')).map((mt) => {
      const vals = rows.filter((r) => isNum(r[mt.key]) && !(mt.key === 'pe' && r[mt.key] <= 0));
      const sorted = [...vals].sort((a, b) => (mt.better === 'high' ? b[mt.key] - a[mt.key] : a[mt.key] - b[mt.key]));
      const pos = sorted.indexOf(main);
      return { ...mt, value: main[mt.key], rank: pos >= 0 ? pos + 1 : null, of: sorted.length, avg: avgRow[mt.key], leader: sorted[0] || null };
    });
    const S = [], W = [];
    for (const r of ranks) {
      if (r.key === 'marketCap' || r.rank == null || r.of < 3 || !isNum(r.avg)) continue;
      const v = r.value, a = r.avg;
      const show = (x) => (r.fmt === 'pct' ? fmtPct(x, 1) : r.fmt === 'x' ? fmtX(x, 1) : fmtMoney(x, main.currency));
      const better = r.better === 'high' ? v > a : v < a;
      const gapBig = r.fmt === 'pct' ? Math.abs(v - a) >= 0.03 : Math.abs(v / a - 1) >= 0.2;
      if (!gapBig) continue;
      const text = `${r.label} is ${show(v)} vs. an industry average of ${show(a)} (ranked ${r.rank} of ${r.of} among its industry peers).`;
      const metric = `#${r.rank} of ${r.of}`;
      if (r.key === 'pe') (better ? S : W).push({ title: better ? 'Cheaper than its industry peers' : 'Pricier than its industry peers', text, metric });
      else if (r.key === 'de') (better ? S : W).push({ title: better ? 'Less debt than its industry peers' : 'More debt than its industry peers', text, metric });
      else (better ? S : W).push({ title: `${better ? 'Beats' : 'Trails'} industry peers on ${r.name.toLowerCase()}`, text, metric });
    }
    return { rows, ranks, avgRow, strengths: S, weaknesses: W };
  }

  root.Analysis = {
    buildModel, parseSummary, peerRowFromModel, peerCompare, PEER_METRICS, TIMESERIES_TYPES,
    fmtMoney, fmtPrice, fmtPct, fmtX, curSym, isNum, validPe
  };
})(typeof window !== 'undefined' ? window : globalThis);
