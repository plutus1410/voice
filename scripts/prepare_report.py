#!/usr/bin/env python3
"""
PLUTUS - annual-report preparation job (runs in GitHub Actions, free).

For one stock symbol it:
  1. finds the company's latest annual report
       US  : SEC EDGAR (10-K / 20-F)        - official API, no key
       India (.NS / .BO): NSE annual-reports API -> BSE API -> company website
       data/report_sources.json can pin a direct PDF/HTML URL for any symbol (optional escape hatch)
  2. extracts the text (page numbers kept, financial tables kept as rows)
  3. splits it into labelled chunks (section + page)
  4. writes data/reports/<SYMBOL>.json  (the website's voice bot searches this file)

If anything fails, a small {"status": "failed", "reason": ...} file is written instead, so the bot can tell the
visitor honestly instead of guessing.

Usage:
  python scripts/prepare_report.py --symbol AAPL [--force]
  python scripts/prepare_report.py --refresh          # nightly: look for newly published reports
"""
import argparse
import datetime as dt
import json
import os
import re
import sys
import time
from pathlib import Path
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup, Comment, NavigableString

try:
    import fitz  # PyMuPDF
except Exception:  # pragma: no cover - only needed for PDF reports
    fitz = None

OUT_DIR = Path(os.environ.get("REPORTS_DIR", "data/reports"))
SOURCES_FILE = Path(os.environ.get("REPORT_SOURCES_FILE", "data/report_sources.json"))
WORKER_URL = (os.environ.get("WORKER_URL") or "").rstrip("/")
SEC_UA = os.environ.get("SEC_USER_AGENT") or "PlutusReportPrep contact-not-set@example.com"
BROWSER_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
              "Chrome/126.0 Safari/537.36")
SCHEMA = 1
SYMBOL_RE = re.compile(r"^[A-Z0-9][A-Z0-9.&^-]{0,19}$")
ANNUAL_FORMS = ("10-K", "10-K405", "10-KT", "20-F", "40-F")
MAX_DOWNLOAD_BYTES = 150 * 1024 * 1024
MAX_TOTAL_CHARS = 2_600_000          # keeps the JSON small enough to load quickly in a browser
CHUNK_TARGET = 1400
CHUNK_MAX = 1900
MIN_TEXT_CHARS = 20_000              # below this the file is almost certainly a scan (no OCR here)
REFRESH_OK_DAYS = 7
REFRESH_FAILED_DAYS = 3
REFRESH_MAX_PER_RUN = 10

MONTHS = {m: i for i, m in enumerate(
    ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october",
     "november", "december"], 1)}


def log(*a):
    print("[plutus]", *a, flush=True)


def now_iso():
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def safe_name(symbol):
    """Must match safeName() in js/voice.js."""
    return re.sub(r"[^A-Za-z0-9._-]", "_", symbol)


def clean(s):
    s = (s or "").replace("\xa0", " ").replace("\u200b", "").replace("\u2009", " ")
    return re.sub(r"\s+", " ", s).strip()


# =============================================================================================== HTTP helpers
def http_get(url, *, headers=None, timeout=60, stream=False, session=None, tries=3):
    last = None
    for i in range(tries):
        try:
            r = (session or requests).get(url, headers=headers, timeout=timeout, stream=stream)
            if r.status_code in (429, 500, 502, 503, 504):
                last = RuntimeError(f"HTTP {r.status_code}")
                time.sleep(2 + i * 3)
                continue
            r.raise_for_status()
            return r
        except requests.RequestException as e:
            last = e
            time.sleep(1.5 + i * 2)
    raise RuntimeError(f"GET {url[:90]} failed: {last}")


def sec_get(url, **kw):
    time.sleep(0.25)  # SEC fair-access: well under 10 requests / second
    return http_get(url, headers={"User-Agent": SEC_UA, "Accept-Encoding": "gzip, deflate"}, **kw)


def download(url, session=None, headers=None):
    h = {"User-Agent": BROWSER_UA, "Accept": "*/*"}
    if headers:
        h.update(headers)
    r = http_get(url, headers=h, stream=True, timeout=180, session=session)
    size = 0
    parts = []
    for part in r.iter_content(1 << 20):
        size += len(part)
        if size > MAX_DOWNLOAD_BYTES:
            raise RuntimeError("report file is larger than 150 MB")
        parts.append(part)
    return b"".join(parts), r.headers.get("Content-Type", "")


# =============================================================================================== finders
class Candidate(dict):
    """A report found by a finder: source, url, kind ('html'|'pdf'), form, filed, period_end, fy_end_year, source_id, company."""


def find_override(symbol):
    try:
        m = json.loads(SOURCES_FILE.read_text(encoding="utf-8"))
    except Exception:
        return None
    url = m.get(symbol)
    if not url:
        return None
    kind = "pdf" if urlparse(url).path.lower().endswith(".pdf") else "html"
    return Candidate(source="Pinned source (data/report_sources.json)", url=url, kind=kind, form="Annual report",
                     source_id=url)


def find_sec(symbol):
    base = symbol.upper()
    tickers = sec_get("https://www.sec.gov/files/company_tickers.json").json()
    want = {base, base.replace("-", "."), base.replace(".", "-")}
    hit = next((v for v in tickers.values() if str(v.get("ticker", "")).upper() in want), None)
    if not hit:
        raise RuntimeError("ticker not found in the SEC company list (is it a US-listed company?)")
    cik = str(hit["cik_str"]).zfill(10)
    subs = sec_get(f"https://data.sec.gov/submissions/CIK{cik}.json").json()
    rec = subs["filings"]["recent"]
    for i, form in enumerate(rec["form"]):
        if form in ANNUAL_FORMS:
            acc = rec["accessionNumber"][i]
            doc = rec["primaryDocument"][i]
            period = rec.get("reportDate", [None] * (i + 1))[i] or None
            url = f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{acc.replace('-', '')}/{doc}"
            return Candidate(source="SEC EDGAR", url=url, kind="html", form=form, filed=rec["filingDate"][i],
                             period_end=period, fy_end_year=int(period[:4]) if period else None, source_id=acc,
                             company=subs.get("name") or hit.get("title"))
    raise RuntimeError("no 10-K / 20-F filing in the company's recent SEC filings")


def _year_end(txt):
    """'2024-25' / '2025' / 'FY25' -> 2025"""
    txt = str(txt or "")
    m = re.search(r"(20\d{2})\s*[-–/]\s*(\d{2,4})", txt)
    if m:
        a, b = m.group(1), m.group(2)
        return int(b) if len(b) == 4 else int(a[:2] + b)
    m = re.search(r"(20\d{2})", txt)
    return int(m.group(1)) if m else None


def find_nse(symbol):
    base = symbol.rsplit(".", 1)[0]
    s = requests.Session()
    s.headers.update({"User-Agent": BROWSER_UA, "Accept-Language": "en-US,en;q=0.9"})
    http_get("https://www.nseindia.com/", session=s, timeout=30)  # sets the cookies the API expects
    r = s.get("https://www.nseindia.com/api/annual-reports", params={"index": "equities", "symbol": base}, timeout=40,
              headers={"Referer": "https://www.nseindia.com/companies-listing/corporate-filings-annual-reports",
                       "Accept": "application/json, text/plain, */*"})
    r.raise_for_status()
    data = r.json().get("data") or []
    rows = []
    for d in data:
        f = str(d.get("fileName") or "")
        if f.lower().endswith(".pdf"):
            rows.append((_year_end(d.get("toYr")) or _year_end(d.get("fromYr")) or 0, d))
    if not rows:
        raise RuntimeError("NSE returned no annual-report PDFs for this symbol")
    year, d = max(rows, key=lambda x: x[0])
    return Candidate(source="NSE India", url=d["fileName"], kind="pdf", form="Annual report",
                     filed=str(d.get("broadcast_dttm") or d.get("submissionDate") or "")[:10] or None,
                     fy_end_year=year or None, source_id=d["fileName"], company=d.get("companyName"),
                     _session=s)


def find_bse(symbol):
    code = symbol.rsplit(".", 1)[0]
    if not code.isdigit():
        raise RuntimeError("BSE needs the numeric scrip code (e.g. 500325.BO)")
    r = requests.get("https://api.bseindia.com/BseIndiaAPI/api/AnnualReport_New/w", params={"scripcode": code},
                     headers={"User-Agent": BROWSER_UA, "Referer": "https://www.bseindia.com/",
                              "Origin": "https://www.bseindia.com"}, timeout=40)
    r.raise_for_status()
    j = r.json()
    rows = j.get("Table") if isinstance(j, dict) else j
    best = None
    for row in rows or []:
        if not isinstance(row, dict):
            continue
        pdf = next((str(v) for v in row.values() if isinstance(v, str) and v.lower().endswith(".pdf")), None)
        if not pdf:
            continue
        year = _year_end(next((row[k] for k in row if "year" in k.lower()), "")) or _year_end(pdf) or 0
        if not best or year > best[0]:
            best = (year, pdf)
    if not best:
        raise RuntimeError("BSE returned no annual-report PDFs for this scrip code")
    url = best[1] if best[1].startswith("http") else "https://www.bseindia.com/bseplus/AnnualReport/" + code + "/" + best[1]
    return Candidate(source="BSE India", url=url, kind="pdf", form="Annual report", fy_end_year=best[0] or None,
                     source_id=url)


def yahoo_profile(symbol):
    """Website + name through the project's own Worker (Yahoo blocks direct calls)."""
    if not WORKER_URL:
        return {}
    from urllib.parse import quote
    u = f"https://query2.finance.yahoo.com/v10/finance/quoteSummary/{quote(symbol)}?modules=assetProfile,price"
    try:
        j = http_get(f"{WORKER_URL}/?url={quote(u, safe='')}", timeout=40).json()
        res = j["quoteSummary"]["result"][0]
        return {"website": (res.get("assetProfile") or {}).get("website"),
                "name": (res.get("price") or {}).get("longName")}
    except Exception as e:
        log("yahoo profile unavailable:", e)
        return {}


def find_company_site(symbol):
    prof = yahoo_profile(symbol)
    site = prof.get("website")
    if not site:
        raise RuntimeError("company website unknown (set the WORKER_URL repository variable to enable this fallback)")
    host = urlparse(site).netloc.replace("www.", "")
    seen, queue, found = set(), [(site, 0)], []
    while queue and len(seen) < 14:
        url, depth = queue.pop(0)
        if url in seen:
            continue
        seen.add(url)
        try:
            html = http_get(url, headers={"User-Agent": BROWSER_UA}, timeout=30).text
        except Exception:
            continue
        for a in BeautifulSoup(html, "lxml").find_all("a", href=True):
            href = urljoin(url, a["href"])
            text = clean(a.get_text(" "))
            blob = (text + " " + href).lower()
            if href.lower().split("?")[0].endswith(".pdf") and re.search(r"annual[\s_-]*report|integrated[\s_-]*report", blob):
                y = _year_end(blob) or 0
                if y >= dt.date.today().year - 2:
                    found.append((y, href))
            elif depth < 2 and host in urlparse(href).netloc and re.search(r"investor|annual|financial|report", blob):
                queue.append((href, depth + 1))
    if not found:
        raise RuntimeError("no annual-report PDF found on the company website")
    y, href = max(found, key=lambda x: x[0])
    return Candidate(source="Company website", url=href, kind="pdf", form="Annual report", fy_end_year=y or None,
                     source_id=href, company=prof.get("name"))


def finders_for(symbol):
    if symbol.endswith(".NS"):
        return [find_nse, find_company_site]
    if symbol.endswith(".BO"):
        return [find_bse, find_company_site] if symbol[:-3].isdigit() else [find_nse, find_company_site]
    if "." in symbol.replace("-", ""):
        return []  # other exchanges are not supported yet
    return [find_sec]


# =============================================================================================== headings
def _h(label, tag, pat):
    return (re.compile(pat, re.I), label, tag)


HEADINGS = [
    _h("Cash Flow Statement", "cashflow", r"^(?:the\s+)?(?:consolidated\s+|standalone\s+|condensed\s+)*(?:statements?\s+of\s+cash\s+flows?|cash\s+flow\s+statements?)\b"),
    _h("Balance Sheet", "balance", r"^(?:the\s+)?(?:consolidated\s+|standalone\s+|condensed\s+)*(?:balance\s+sheets?|statements?\s+of\s+financial\s+position)\b"),
    _h("Income Statement", "income", r"^(?:the\s+)?(?:consolidated\s+|standalone\s+|condensed\s+)*statements?\s+of\s+(?:profit\s+and\s+loss|profit\s+or\s+loss|operations|income|comprehensive\s+income|earnings)\b"),
    _h("Notes to Financial Statements", "notes", r"^notes?\s+(?:to|forming\s+part\s+of)\s+(?:the\s+)?(?:consolidated\s+|standalone\s+)*(?:financial\s+statements|accounts)"),
    _h("Management Discussion & Analysis", "mdna", r"management(?:['’]?s)?\s+discussion\s+(?:and|&)\s+analysis|^item\s*7\b(?!\s*a)|operating\s+and\s+financial\s+review"),
    _h("Risk Factors", "risk", r"^item\s*1a\b|^risk\s+factors\b|^(?:key\s+)?risks?\s+and\s+(?:concerns|uncertainties|mitigation)"),
    _h("Business", "business", r"^item\s*1\b\.?\s*[-—–:.]?\s*business|^business\s+overview"),
    _h("Directors' Report", "directors", r"^(?:board(?:['’]?s)?|directors?(?:['’]s?)?)\s+report"),
    _h("Corporate Governance", "governance", r"^(?:report\s+on\s+)?corporate\s+governance"),
    _h("Auditor's Report", "auditor", r"^independent\s+auditor|^report\s+of\s+independent"),
    _h("Sustainability / BRSR", "esg", r"^business\s+responsibility|^sustainability\s+report|^brsr\b"),
    _h("AGM Notice", "notice", r"^notice\b.*annual\s+general\s+meeting"),
    _h("Other sections", "other", r"^item\s*\d+[abc]?\b"),   # any other 10-K / 20-F item: ends the previous section
]
HEADINGS_20F = [_h("Management Discussion & Analysis", "mdna", r"^item\s*5\b")] + HEADINGS


def detect_heading(text, form=None):
    t = clean(text)
    if not t or len(t) > 110 or len(t) < 6:
        return None
    t = re.sub(r"^[\W_]+", "", t)
    for rx, label, tag in (HEADINGS_20F if form == "20-F" else HEADINGS):
        if rx.search(t):
            if tag in ("cashflow", "balance", "income"):
                low = t.lower()
                scope = "Consolidated" if "consolidated" in low else ("Standalone" if "standalone" in low else "")
                return (f"{label} ({scope})" if scope else label, tag)
            return (label, tag)
    return None


# =============================================================================================== HTML -> blocks
BLOCK_TAGS = {"p", "div", "li", "h1", "h2", "h3", "h4", "h5", "h6", "section", "article", "ul", "ol", "center",
              "blockquote", "dl", "dd", "dt", "body", "html", "header", "footer", "main"}
SKIP_TAGS = {"script", "style", "head", "ix:header", "noscript", "svg"}
CURRENCY_ONLY = {"$", "€", "£", "₹", "(", "US$"}
SUFFIX_ONLY = {")", "%", ")%", "%)"}


def _pb_before(style):
    return "page-break-before:always" in style or "break-before:page" in style


def _pb_after(style):
    return "page-break-after:always" in style or "break-after:page" in style


def _table_rows(tbl):
    rows = []
    for tr in tbl.find_all("tr"):
        cells = []
        for td in tr.find_all(["td", "th"]):
            t = clean(td.get_text(" "))
            if not t or t in CURRENCY_ONLY:
                continue
            if t in SUFFIX_ONLY and cells:
                cells[-1] += t
                continue
            cells.append(t)
        if cells:
            rows.append(" | ".join(cells))
    return rows


def html_to_blocks(html):
    """-> (blocks [(text, page|None)], page_breaks_found)"""
    soup = BeautifulSoup(html, "lxml")
    out, st = [], {"buf": [], "page": 1, "pb": 0}

    def flush():
        t = clean(" ".join(st["buf"]))
        st["buf"] = []
        if t:
            out.append((t, st["page"]))

    def walk(el):
        for ch in el.children:
            if isinstance(ch, Comment):
                continue
            if isinstance(ch, NavigableString):
                t = clean(str(ch))
                if t:
                    st["buf"].append(t)
                continue
            name = (ch.name or "").lower()
            style = (ch.get("style") or "").lower().replace(" ", "")
            if name in SKIP_TAGS or "display:none" in style:
                continue
            if _pb_before(style):
                flush(); st["page"] += 1; st["pb"] += 1
            if name == "table":
                flush()
                for row in _table_rows(ch):
                    out.append((row, st["page"]))
            elif name == "br":
                flush()
            elif name in BLOCK_TAGS:
                flush(); walk(ch); flush()
            else:
                walk(ch)
            if _pb_after(style):
                flush(); st["page"] += 1; st["pb"] += 1

    walk(soup.body or soup)
    flush()
    return out, st["pb"]


# =============================================================================================== PDF -> blocks
def pdf_to_blocks(data):
    if fitz is None:
        raise RuntimeError("PyMuPDF is not installed")
    doc = fitz.open(stream=data, filetype="pdf")
    blocks, total_chars = [], 0
    fin_rx = re.compile(r"cash\s+flows?|balance\s+sheet|profit\s+and\s+loss|statements?\s+of|financial\s+position|operating\s+activities", re.I)
    for pno, page in enumerate(doc, 1):
        items = []
        raw_blocks = page.get_text("blocks", sort=True)
        page_text = " ".join(b[4] for b in raw_blocks if len(b) > 4)
        total_chars += len(page_text)
        table_rects = []
        if fin_rx.search(page_text) and len(re.findall(r"\d[\d,]{2,}", page_text)) > 12:
            try:
                for t in page.find_tables().tables:
                    rows = [[clean(c) for c in r if c and clean(c)] for r in t.extract()]
                    rows = [r for r in rows if r]
                    if len(rows) >= 3 and max(len(r) for r in rows) >= 2:
                        table_rects.append(fitz.Rect(t.bbox))
                        for i, r in enumerate(rows):
                            items.append((t.bbox[1] + i * 0.001, " | ".join(r)))
            except Exception:
                table_rects = []
        for b in raw_blocks:
            if len(b) < 5 or (len(b) > 6 and b[6] != 0):
                continue
            rect = fitz.Rect(b[:4])
            if any((rect & tr).get_area() > 0.5 * max(rect.get_area(), 1) for tr in table_rects):
                continue
            t = clean(b[4])
            if t and not re.fullmatch(r"\d{1,3}", t):
                items.append((b[1], t))
        items.sort(key=lambda x: x[0])
        blocks.extend((t, pno) for _, t in items)
    n_pages = len(doc)
    doc.close()
    return blocks, n_pages, total_chars


# =============================================================================================== chunking
def _split_long(text, limit=CHUNK_MAX):
    if len(text) <= limit:
        return [text]
    parts, cur = [], ""
    for s in re.split(r"(?<=[.;:!?])\s+", text):
        if len(cur) + len(s) + 1 > limit and cur:
            parts.append(cur)
            cur = ""
        while len(s) > limit:
            parts.append(s[:limit]); s = s[limit:]
        cur = (cur + " " + s).strip()
    if cur:
        parts.append(cur)
    return parts


def build_chunks(blocks, form=None, use_pages=True):
    section, chunks = ("Front matter", "other"), []
    cur, cur_len, cur_page = [], 0, None

    def flush(carry=True):
        nonlocal cur, cur_len, cur_page
        if not cur:
            return
        text = "\n".join(cur).strip()
        if len(text) >= 80:
            chunks.append({"id": f"c{len(chunks) + 1}", "section": section[0], "tag": section[1],
                           "page": cur_page if use_pages else None, "text": text})
        tail = cur[-1] if (carry and cur and len(cur[-1]) < 300 and len(cur) > 1) else None
        cur, cur_len = ([tail], len(tail)) if tail else ([], 0)
        cur_page = None

    for text, page in blocks:
        h = detect_heading(text, form)
        if h and h != section:
            flush(carry=False)
            section = h
        for piece in _split_long(text):
            if cur_len + len(piece) > CHUNK_TARGET and cur:
                flush()
            if cur_page is None:
                cur_page = page
            cur.append(piece)
            cur_len += len(piece) + 1
    flush(carry=False)
    return chunks


def trim_to_budget(chunks):
    total = sum(len(c["text"]) for c in chunks)
    for drop in ("notice", "esg", "governance", "auditor", "other"):
        if total <= MAX_TOTAL_CHARS:
            break
        kept = [c for c in chunks if c["tag"] != drop]
        total = sum(len(c["text"]) for c in kept)
        chunks = kept
    if total > MAX_TOTAL_CHARS:  # still too large: keep the most useful tags first
        priority = ["cashflow", "mdna", "income", "balance", "risk", "business", "directors", "notes", "other"]
        chunks = sorted(chunks, key=lambda c: priority.index(c["tag"]) if c["tag"] in priority else 99)
        kept, size = [], 0
        for c in chunks:
            if size + len(c["text"]) > MAX_TOTAL_CHARS:
                continue
            kept.append(c); size += len(c["text"])
        chunks = sorted(kept, key=lambda c: int(c["id"][1:]))
    return chunks


# =============================================================================================== period detection
def detect_period(text):
    """Find 'year ended 31 March 2025' style statements near the start of the report -> (iso date | None, end year | None)."""
    mon = "|".join(MONTHS)
    pats = [
        rf"(?:financial\s+year|fiscal\s+year|year|period)\s+ended\s+(?:on\s+)?(?:the\s+)?(\d{{1,2}})(?:st|nd|rd|th)?\s+({mon}),?\s+(\d{{4}})",
        rf"(?:financial\s+year|fiscal\s+year|year|period)\s+ended\s+(?:on\s+)?({mon})\s+(\d{{1,2}}),?\s+(\d{{4}})",
    ]
    found = []
    for i, p in enumerate(pats):
        for m in re.finditer(p, text, re.I):
            try:
                if i == 0:
                    d, mo, y = int(m.group(1)), MONTHS[m.group(2).lower()], int(m.group(3))
                else:
                    mo, d, y = MONTHS[m.group(1).lower()], int(m.group(2)), int(m.group(3))
                found.append(dt.date(y, mo, d))
            except (ValueError, KeyError):
                pass
    cutoff = dt.date.today() + dt.timedelta(days=200)
    found = [d for d in found if d <= cutoff and d.year >= 2000]
    if found:
        # the most frequently stated date wins; ties -> latest
        best = max(set(found), key=lambda d: (found.count(d), d))
        return best.isoformat(), best.year
    m = re.search(r"annual\s+report\s+(20\d{2})\s*[-–]\s*(\d{2,4})", text, re.I)
    if m:
        return None, _year_end(m.group(0))
    return None, None


def period_label(iso):
    if not iso:
        return None
    d = dt.date.fromisoformat(iso)
    return f"year ended {d.day} {d.strftime('%B %Y')}"


# =============================================================================================== orchestration
def write_json(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def read_existing(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def fail(symbol, reason, tried):
    log("FAILED:", reason)
    write_json(OUT_DIR / f"{safe_name(symbol)}.json",
               {"status": "failed", "schema": SCHEMA, "symbol": symbol, "reason": reason, "tried": tried,
                "prepared_at": now_iso()})
    return False


def prepare(symbol, force=False):
    symbol = symbol.strip().upper()
    if not SYMBOL_RE.match(symbol):
        raise SystemExit(f"bad symbol: {symbol!r}")
    path = OUT_DIR / f"{safe_name(symbol)}.json"
    existing = read_existing(path)
    log("symbol", symbol)

    finders = finders_for(symbol)
    pinned = find_override(symbol)
    if not finders and not pinned:
        return fail(symbol, "Only US (SEC EDGAR) and Indian (NSE/BSE) companies are supported right now.", [])

    cand, tried = None, []
    if pinned:
        cand = pinned
    else:
        for f in finders:
            try:
                cand = f(symbol)
                log("found via", f.__name__, "->", cand.get("url"))
                break
            except Exception as e:
                tried.append(f"{f.__name__.replace('find_', '')}: {str(e)[:160]}")
                log("finder", f.__name__, "failed:", e)
    if not cand:
        return fail(symbol, "I couldn't find the company's latest annual report automatically.", tried)

    if (not force and existing and existing.get("status") == "ready"
            and existing.get("report", {}).get("source_id") == cand.get("source_id")):
        existing["checked_at"] = now_iso()
        write_json(path, existing)
        log("already up to date")
        return True

    session = cand.pop("_session", None)
    try:
        data, ctype = download(cand["url"], session=session,
                               headers={"User-Agent": SEC_UA} if cand["source"] == "SEC EDGAR" else None)
    except Exception as e:
        return fail(symbol, "The annual report was found but could not be downloaded.", tried + [str(e)[:200]])

    is_pdf = data[:5] == b"%PDF-"
    try:
        if is_pdf:
            blocks, n_pages, total_chars = pdf_to_blocks(data)
            use_pages, page_kind = True, "pdf"
        else:
            html = data.decode("utf-8", errors="replace")
            blocks, pb = html_to_blocks(html)
            n_pages, total_chars = max(pb, 1), sum(len(t) for t, _ in blocks)
            use_pages, page_kind = pb >= 5, "html_est"
    except Exception as e:
        return fail(symbol, "The annual report could not be read.", tried + [str(e)[:200]])

    if total_chars < MIN_TEXT_CHARS:
        return fail(symbol, "The report file has almost no selectable text (it may be a scanned document).", tried)

    head_text = " ".join(t for t, p in blocks[:400])
    period_iso, fy_end = detect_period(head_text)
    period_iso = cand.get("period_end") or period_iso
    fy_end = cand.get("fy_end_year") or fy_end or (int(period_iso[:4]) if period_iso else None)

    chunks = trim_to_budget(build_chunks(blocks, cand.get("form"), use_pages))
    if len(chunks) < 20:
        return fail(symbol, "Too little readable text was found in the report.", tried)
    tags = {c["tag"] for c in chunks}
    cash_text = any(re.search(r"operating\s+activities", c["text"], re.I) and re.search(r"cash\s+flows?", c["text"], re.I)
                    for c in chunks)
    warnings = []
    if "mdna" not in tags:
        warnings.append("Management Discussion section not detected")
    if "cashflow" not in tags and not cash_text:
        warnings.append("Cash-flow statement not detected")

    company = cand.get("company") or (yahoo_profile(symbol).get("name") if WORKER_URL else None) or symbol
    out = {
        "status": "ready", "schema": SCHEMA, "symbol": symbol, "company": company,
        "report": {"source": cand["source"], "form": cand.get("form"), "url": cand["url"], "filed": cand.get("filed"),
                   "period_end": period_iso, "fy_end_year": fy_end, "period_label": period_label(period_iso),
                   "source_id": cand.get("source_id"), "page_kind": page_kind if use_pages else "none"},
        "quality": {"chunks": len(chunks), "pages": n_pages, "has_cashflow": "cashflow" in tags or cash_text,
                    "has_mdna": "mdna" in tags, "warnings": warnings},
        "prepared_at": now_iso(), "checked_at": now_iso(), "chunks": chunks,
    }
    write_json(path, out)
    log(f"OK: {len(chunks)} chunks, {n_pages} pages, {path.stat().st_size // 1024} KB, warnings={warnings}")
    return True


def refresh():
    today = dt.datetime.now(dt.timezone.utc)
    due = []
    for p in sorted(OUT_DIR.glob("*.json")):
        j = read_existing(p)
        if not j or "symbol" not in j:
            continue
        stamp = j.get("checked_at") or j.get("prepared_at")
        try:
            age = (today - dt.datetime.fromisoformat(stamp.replace("Z", "+00:00"))).days
        except Exception:
            age = 999
        limit = REFRESH_OK_DAYS if j.get("status") == "ready" else REFRESH_FAILED_DAYS
        if age >= limit:
            due.append((age, j["symbol"]))
    due.sort(reverse=True)
    log(f"{len(due)} report(s) due for a check")
    for _, sym in due[:REFRESH_MAX_PER_RUN]:
        try:
            prepare(sym)
        except SystemExit as e:
            log("skip", sym, e)
        except Exception as e:  # never let one company stop the others
            log("error for", sym, e)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--symbol")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--refresh", action="store_true")
    a = ap.parse_args()
    if a.refresh:
        refresh()
    elif a.symbol:
        prepare(a.symbol, a.force)
    else:
        ap.error("give --symbol SYMBOL or --refresh")


if __name__ == "__main__":
    main()
