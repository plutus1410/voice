/* ============================================================
   PLUTUS — configuration
   ------------------------------------------------------------
   Yahoo Finance blocks direct browser calls (CORS), so requests
   go through your Cloudflare Worker (see /worker/worker.js).
   If WORKER_URL is empty, the app falls back to public CORS
   proxies — unreliable, demo only.
   ============================================================ */
window.APP_CONFIG = {
  WORKER_URL: "https://broad-tree-45a0.plutus1410.workers.dev/",
  LOGODEV_KEY: "pk_bhlc52p0TIy8HasyFvNnVA",
  PUBLIC_PROXIES: [
    "https://api.allorigins.win/raw?url=",
    "https://corsproxy.io/?url="
  ],
  CACHE_MINUTES: 15,      // browser-side cache per Yahoo response
  REQUEST_TIMEOUT_MS: 15000,

  // Plutus voice bot ("Ask Plutus"). It needs the Worker (WORKER_URL above) to be v7 — see VOICE_SETUP.md.
  VOICE_BOT: true,                 // false hides the button completely
  REPORTS_PATH: "data/reports/",   // where the GitHub Actions job saves the processed annual reports

  // Company logos. Yahoo Finance has no logo API, so logos are looked up by the
  // company's website domain. Sources are tried in order; if all fail, a
  // coloured initials badge is shown. Use {domain} as the placeholder.
  // To use a dedicated logo service, put it first, e.g.
  //   "https://img.logo.dev/{domain}?token=YOUR_PUBLISHABLE_TOKEN&size=128"
  LOGO_SOURCES: [
    "https://t3.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&url=https://{domain}&size=128",
    "https://icons.duckduckgo.com/ip3/{domain}.ico"
  ]
};
