## PLUTUS — Your AI Stock Analysis Companion

A futuristic dashboard (light mode by default, dark mode one tap away) that turns Yahoo Finance data into plain-English, gamified insights. **Facts only — no buy/sell/hold calls.** Fully responsive for desktop, tablet and mobile.

### Dashboard sections (in order)
- **About the Company** — business summary (justified, with Read more), sector, industry, HQ, website
- **Health Scan** — 0–100 score ring, six power stats
- **Key Numbers** — 12 KPI cards in 3 clickable categories of 4, full width (Growth & Profit, Value & Returns, Safety & Cash) with tap/hover explanations
- **Trajectory** — price (1Y/5Y), P/E history and Yearly/Quarterly business charts
- **Shareholding Pattern** — a crowd of 100 people (1 person = 1% of shares; a circle on phones) coloured by holder type, the change since the previous filing, and the biggest institutional and mutual-fund holders (Yahoo Finance)
- **Peer Arena** — companies from the **same industry**, medals, head-to-head chart and comparison table
- **Strengths & Weaknesses** — plain-English facts, including "VS INDUSTRY" items

The home page's **Try** chips are 3 Indian (Reliance, TCS, HDFC Bank) and 3 US (Apple, Microsoft, NVIDIA) companies. Search favours Indian listings (NSE, then BSE), marked with an IN tag, and matches on the **company name** (not the ticker).

### What changed in v6
1. **Light mode** (the default; "ivory & navy": warm paper background, white cards with soft shadows, navy text, royal-blue and gold accents) and the original dark mode. The sun / moon button in the top bar switches between them; the choice is remembered in the browser (`plutus.theme.v1`). Charts redraw in the new colours. All colours are tokens at the top of `css/style.css` (`:root` = light, `:root[data-theme="dark"]` = dark).
2. **Collapsible news sidebar** on desktop / laptop screens (1280 px and wider). It starts collapsed to a slim "Latest In News" rail with a headline count, so the dashboard fills the screen; click the rail to open it and » to close it. On smaller screens the news stays below the content.
3. **Far fewer "Signal lost" errors:**
   - **Worker bug fixed:** answers served from Cloudflare's edge cache carried `Access-Control-Allow-Origin: *, *`, which browsers reject. Every cache hit (any stock someone opened in the previous 10 minutes) failed as "Failed to fetch" — it looked like a network problem, but it wasn't. **Re-deploy `worker/worker.js` (v6)** to fix it at the source; the site also works around it with the old Worker.
   - Requests go through a small queue (max 6 at once) where the stock you're opening goes ahead of the background peer lookups, and lookups for a stock you've already left are dropped.
   - Failed requests are retried up to 4 times with growing waits, switching between Yahoo's twin hosts; then the whole page tries once more ("DATA SERVICE BUSY · RETRYING") before showing an error. As a last resort an older copy from this tab's cache is used.
   - The error screen explains what happened in plain English and has a **Try again** button (it also reloads by itself when the device comes back online).
   - Worker v6 also shares one Yahoo cookie/crumb handshake between requests that arrive together, retries a refused request on the twin host, and keeps a 24-hour "last good copy" for when Yahoo refuses.

### What changed in v4
1. Top bar (logo + search) is now fixed to the top of the screen on the stock page.
2. Search ranks results by company name only; ticker is shown as secondary text.
3. Achievements removed from Health Scan.
4. Peers are real industry peers (verified against Yahoo's industry label), chosen closest in size.
5. Company logo beside the name in search suggestions, the stock header and the peer table.
6. Industry averages are available for every metric (strip, power stats, KPI cards, P/E and margin charts, peer table) — switched on with the **Compare with industry average** switch.

### Structure
index.html
manifest.webmanifest  ← PWA manifest (name, icons, colours)
sw.js                 ← service worker (installability + offline shell)
icons/                ← app icons (192, 512, maskable, Apple touch)
css/style.css
css/news.css
css/pwa.css       ← "Install app" modal
js/config.js      ← WORKER_URL, LOGO_SOURCES
js/analysis.js    ← metrics, scores, peer ranks, strengths/weaknesses
js/app.js         ← UI, search, logos, industry peers, shareholding, routing, charts
js/news.js        ← "Latest In News" sidebar (max 10: 5 company, then 5 industry)
js/pwa.js         ← service-worker registration + one-time install modal
worker/worker.js  ← Cloudflare Worker v6 (deploy on Cloudflare, not GitHub)

### Compare with industry average
- The switch is in the fixed **top bar**, labelled **Compare with industry** on wide screens and **Industry avg** on tablets and phones. It's off by default; the choice is remembered in the browser (`plutus.compare.v1`). Each change is confirmed with a short message, which also explains the chips (↑ higher / ↓ lower, green = better, red = worse).
- When on, numbers are labelled in words: **INDUSTRY AVG 25.2×** under each headline number and in each Key Number card, with a chip such as **↑ 4% higher** / **↓ 0.5 pts lower** (narrow boxes shorten this to "AVG" and the arrow). Green = better for the company, red = worse, grey = neither. Hover or tap a chip for the full sentence, e.g. "Industry average 25.2×. This company: 4% higher than the industry — worse (lower is better here)." Power Stats get the same chip plus a marker on the meter; the score ring and the P/E and margin charts get the average too.
- Switching it on or off never moves the layout. If peers can't be found the switch is greyed out and says why on hover.

### Install as an app (PWA)
- The site is a Progressive Web App. **Every time a visitor lands on the home page** (each fresh visit or reload, or the first time they reach the home page during a visit) a modal offers to install it, until it is installed: one-tap **Install app** on Chrome/Edge/Android; the matching "menu → Install / Add to Home Screen" steps on browsers without an install button (iPhone/iPad, Firefox, in-app browsers).
- "Not now" / "Got it" only closes it for that visit. It stops for good when the app is installed (the browser reports it), when it's opened as the installed app, or when the visitor taps **I've already added it** (needed on iPhone/iPad, where Safari can't tell a website that it's on the home screen). That choice is stored in `plutus.installed.v1`; clear it to see the modal again.
- Desktop browsers get the modal when they offer one-tap install (Chrome/Edge). **To force it while testing, open the site with `?install=1`.**
- One-tap install and offline support need **HTTPS** (GitHub Pages is fine) or `localhost`.
- After you change files, bump `CACHE_VERSION` in `sw.js` and the `?v=` number in `index.html`.
- Live data (Yahoo via the Worker, Bing news, logos) is never cached by the service worker.

### Deploy
- **Worker (re-deploy — it changed in v6):** Cloudflare → Workers → your worker → Edit code → paste worker/worker.js → Deploy. Copy your current code somewhere first as a backup. v6 fixes the cache-hit CORS bug behind most "Signal lost" errors and also covers Bing News RSS and the `?og=` thumbnail lookup used by the news sidebar. Without the update the site still works (it retries around the bug), just with more requests to Yahoo.
- Put the Worker URL in js/config.js (WORKER_URL).
- **GitHub Pages:** upload the folder contents (with index.html at the top level) → Settings → Pages → Deploy from branch main / root.
- _(Recommended)_ Set ALLOWED_ORIGINS = ['https://<user>.github.io'] in the Worker and redeploy.
Run locally: python -m http.server 8080.

### Notes
- Industry average = simple average of up to 6 listed peers in the same industry (closest in size), computed the same way as the company's own figures. EPS is per-share and isn't comparable across companies, so it shows n/a.
- Logos come from the company's website domain via public favicon services (see LOGO_SOURCES in config.js); a dedicated logo API can be added there. If none is found, an initials badge is shown.
- Yahoo's free data covers about 4–5 annual periods and up to 8 quarters. Many Indian companies publish cash flow and balance sheets only half-yearly or yearly, so those quarterly charts may say "No quarterly data published".
- Yahoo's endpoints are unofficial and can change without notice.
- Educational use only. Not investment advice.

### v7 — Section navigation + "Ask Plutus" voice bot
- **Sticky section bar** at the top of every stock page, above the company name and price: tabs for About the Company, Health Scan, Key Numbers, Trajectory, Shareholding, Peer Arena and Strengths & Weaknesses. Tapping a tab scrolls to that section; the tab of the section you're reading is highlighted. It stays pinned under the top bar while you scroll, and scrolls sideways on phones.
- **Ask Plutus** (voice + typed questions) answers from the company's latest annual report, with sources. Setup, how it works, limits and troubleshooting: see `VOICE_SETUP.md`.
- New files: `js/voice.js`, `css/voice.css`, `scripts/prepare_report.py`, `scripts/requirements.txt`, `.github/workflows/prepare-report.yml`, `data/report_sources.json`, `data/reports/` (filled automatically). `worker/worker.js` is now v7 (adds `POST /ask` and `POST /prepare`).
- Hide the voice bot with `VOICE_BOT: false` in `js/config.js`.
