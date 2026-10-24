# Plutus voice bot — setup guide

A floating **Ask Plutus** button appears on every stock page. Visitors ask by voice or by typing
("Why did cash flow fall in FY26?") and Plutus answers **only from the company's latest annual report**,
shows where each answer comes from, and reads it aloud.

Everything runs on free tiers. After the one-time setup below there is nothing to do by hand:
the first time anyone opens the bot for a company, the report is fetched, read and indexed automatically;
a nightly job picks up newly published reports.

## How it works

```
 browser (js/voice.js)                    Cloudflare Worker (worker/worker.js)         GitHub Actions
 ─────────────────────                    ────────────────────────────────────         ──────────────
 stock page → "Ask Plutus"
   │ is data/reports/<SYMBOL>.json there?
   │ no ──────────────────────────────►  POST /prepare ─────────────────────────────►  scripts/prepare_report.py
   │                                                                                    1 find latest annual report
   │ ◄──── polls every 15 s ◄───────────────────────── commits data/reports/<SYMBOL>.json 2 read text + tables
   │ yes                                                                                3 split into labelled chunks
   │ finds the best passages (BM25)
   │ ── question + passages ──────────────► POST /ask → Groq → Gemini → Workers AI
   │ ◄── spoken answer, details, sources ── number check: every figure must appear in the passages
   speaks it (browser voice)
```

* **US companies:** SEC EDGAR (10-K / 20-F) — official API, no key.
* **Indian companies (.NS / .BO):** NSE annual-reports API → BSE API → the company's own website (found via Yahoo).
* **Anything else:** `data/report_sources.json` lets you pin a direct PDF/HTML link for a symbol,
  e.g. `{ "TCS.NS": "https://…/annual-report.pdf" }`. Optional.

## One-time setup (about 20 minutes)

### 1. Get a free AI key (one is enough, two is better)
* **Groq** — console.groq.com → API Keys. Fast; free plan is rate-limited per model.
* **Google Gemini** — aistudio.google.com → Get API key. Free tier; Google may use free-tier prompts to improve its products.

### 2. Put the files in your GitHub repo
Upload this folder's contents to the repo that hosts the site (same level as `index.html`):

| File | What it is |
|---|---|
| `js/voice.js`, `css/voice.css` | the button, panel, search, speech |
| `js/app.js`, `css/style.css` | updated: the sticky section bar (tabs above the company name) |
| `js/config.js`, `index.html`, `sw.js` | updated (two new settings, two new tags, cache version 23) |
| `scripts/prepare_report.py`, `scripts/requirements.txt` | the report job |
| `.github/workflows/prepare-report.yml` | runs the job |
| `data/reports/`, `data/report_sources.json` | where results are saved |
| `worker/worker.js` | Worker v7 (paste into Cloudflare, step 4) |

If the web uploader skips the `.github` folder: **Add file → Create new file**, type
`.github/workflows/prepare-report.yml` as the name, and paste the file's contents.

### 3. GitHub settings
1. **Settings → Secrets and variables → Actions → Variables → New repository variable**
   * `SEC_USER_AGENT` = `Plutus YourName your-email@example.com` (the SEC requires a real contact in the User-Agent)
   * `WORKER_URL` = your Worker's URL (used to look up company websites for the fallback)
2. **Settings → Actions → General → Workflow permissions →** *Read and write permissions* (only needed if the job's push is refused).
3. Create a token for the Worker: **Profile → Settings → Developer settings → Fine-grained tokens → Generate**
   * Repository access: *Only select repositories* → your Plutus repo
   * Permissions → Repository → **Actions: Read and write**
   * Copy the token.

### 4. Cloudflare Worker (v7)
1. Workers → your worker → **Edit code** → paste `worker/worker.js` → **Deploy**. (Keep a copy of your old code first.)
2. **Settings → Variables and Secrets** — add:

| Name | Type | Value |
|---|---|---|
| `GROQ_API_KEY` | Secret | your Groq key |
| `GEMINI_API_KEY` | Secret | your Gemini key |
| `GITHUB_TOKEN` | Secret | the token from step 3 |
| `GITHUB_REPO` | Text | `your-username/your-repo` |
| `GITHUB_REF` | Text | `main` (only if your branch has another name) |

3. *(Optional third fallback)* Settings → Bindings → Add → **Workers AI**, variable name `AI`.
4. *(Recommended)* In `worker.js`, set `ALLOWED_ORIGINS = ['https://<user>.github.io']` and redeploy. With a real allow-list, `/ask` and `/prepare` refuse other websites.

### 5. Go live
Commit everything, wait for GitHub Pages to publish, then hard-refresh the site once
(the new service-worker version cleans out the old cache). Open a company, tap **Ask Plutus**.
For a company with no processed report you will see "Plutus is reading the annual report…" for a few minutes;
then the bot says hello and offers starter questions.

## Behaviour worth knowing
* **Honest by design.** The AI may only use the passages it is given, must cite them, and must say
  "the annual report excerpts I searched don't explain this" when they don't. Every number in an answer is
  checked against the passages; unmatched numbers get a visible ⚠ warning.
* **Period check.** If someone asks about FY26 and the newest report held is FY25, the bot says so
  instead of answering from the wrong year (a report shows the previous year too, so FY25 vs FY24 works).
* **Sources.** "Details & sources" shows the exact excerpt, section and page. HTML filings show an approximate page (≈); PDFs show the PDF page number.
* **Voice.** Speech recognition works in Chrome, Edge and Safari (it is off by default in Firefox, and usually sends audio to the browser vendor's service). Typing always works. Tapping the mic while Plutus is talking interrupts it. The speaker icon mutes spoken answers.
* **Cost / limits.** Free tiers have daily caps (for example Groq's free plan allows around 1,000 requests and 200,000 tokens a day for its main models; check your own console). The Worker tries the next provider automatically when one is out of quota, and limits each visitor to 8 questions a minute. Each question sends about 6 short passages, not the whole report.
* **Nightly refresh** (03:00 IST) re-checks reports older than 7 days and retries failed ones after 3 days. It never touches more than 10 companies per night.
* **Hide it** any time with `VOICE_BOT: false` in `js/config.js`.

## Troubleshooting

| You see | Likely cause |
|---|---|
| "…isn't switched on for this site yet (the Worker needs its GitHub settings)" | `GITHUB_TOKEN` / `GITHUB_REPO` missing in the Worker |
| Stays on "reading the annual report" for 15 min | Open the repo's **Actions** tab: the *Prepare annual report* run shows why (red = failed step). Check the token has *Actions: Read and write* |
| "I couldn't find the company's latest annual report automatically" | Pin a link in `data/report_sources.json`, then tap **Try again** |
| "…almost no selectable text (it may be a scanned document)" | The PDF is an image; there is no OCR in the free job |
| "Heads-up: Cash-flow statement not detected" | The report loaded but its layout confused the parser; answers about cash flow may be thin |
| "…free AI services are busy or out of quota" | Daily/minute caps reached; add the second provider's key or wait for the reset |
| Button missing | `VOICE_BOT` is false, `WORKER_URL` is empty, or you are on the home page (it only shows on stock pages) |

## Status of this build
Tested here: the report job on a generated 10-K-style HTML filing and a generated PDF (page numbers, a cash-flow table, fiscal-year detection, failure paths, refresh logic); the Worker with simulated AI providers (fallback, number check, rate limits, origin lock, `/prepare`); the panel in a real browser engine (desktop, phone, light, dark) with simulated speech.
**Not tested here:** the live SEC, NSE and BSE endpoints (no internet in the build environment) and real AI model output. The Indian sources are the least certain part — NSE and BSE can change or block automated requests — so run one US and one Indian company first and read the Actions log. The Yahoo-based company-website fallback and `report_sources.json` are your safety nets.

The report text and your visitors' questions pass through GitHub, Cloudflare and the AI provider you enable. This is educational information, not investment advice.
