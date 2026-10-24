/* ============================================================
   PLUTUS — service worker (makes the site installable as an app)
   • Same-origin files (the app itself): network first, so a new
     deploy shows up straight away; cached copy used when offline.
   • Chart.js / Fuse.js from the CDN: cached after first load.
   • Everything else (Yahoo data via your Worker, Bing news, logos)
     is NOT touched — live data is never served stale.
   Bump CACHE_VERSION whenever you want to force a fresh cache.
   ============================================================ */
const CACHE_VERSION = 'plutus-v23';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest',
  'css/style.css', 'css/news.css', 'css/pwa.css', 'css/voice.css',
  'js/config.js', 'js/analysis.js', 'js/app.js', 'js/news.js', 'js/pwa.js', 'js/voice.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'
];
const CDN_HOSTS = ['cdn.jsdelivr.net'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((c) => Promise.all(SHELL.map((u) => c.add(new Request(u, { cache: 'reload' })).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('plutus-') && k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // processed annual reports (voice bot): always fetched live, never stored by the service worker (they are large and change)
  if (url.origin === self.location.origin && url.pathname.indexOf('/data/reports/') !== -1) return;
  // CDN libraries: cache first
  if (CDN_HOSTS.includes(url.hostname)) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res && (res.ok || res.type === 'opaque')) { const copy = res.clone(); caches.open(CACHE_VERSION).then((c) => c.put(req, copy)); }
        return res;
      }))
    );
    return;
  }

  // the app's own files: network first, cache as the offline fallback
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(req).then((res) => {
        if (res && res.ok) { const copy = res.clone(); caches.open(CACHE_VERSION).then((c) => c.put(req, copy)); }
        return res;
      }).catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || (req.mode === 'navigate' ? caches.match('index.html') : Response.error())))
    );
  }
  // anything else: leave to the browser (no caching of live data)
});
