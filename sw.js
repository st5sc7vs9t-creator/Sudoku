const CACHE_NAME = 'sudoku-cache-v4';
const SHELL = './index.html';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];
// Without these the app cannot boot from the cache at all.
const CRITICAL = ['./index.html', './style.css', './app.js'];

// Fetch each asset on its own. cache.addAll() is all-or-nothing, so one dropped
// request on a flaky connection used to abandon the entire precache and leave no
// offline copy behind — invisibly, because the network was still covering for it.
async function precache() {
  const cache = await caches.open(CACHE_NAME);
  await Promise.all(ASSETS.map(async url => {
    try {
      // bypass the HTTP cache: a default-mode fetch here can precache stale bytes,
      // which silently defeats bumping CACHE_NAME after an asset changes
      const res = await fetch(new Request(url, { cache: 'reload' }));
      if (res && res.ok) await cache.put(url, res);
    } catch (e) { /* checked below */ }
  }));
  // Fail the install if the shell did not make it. The browser then retries on
  // the next visit, instead of activating a worker that cannot serve offline.
  for (const url of CRITICAL) {
    if (!(await cache.match(url))) throw new Error('precache incomplete: ' + url);
  }
}

self.addEventListener('install', event => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Storage pressure can evict the cache while the registration itself survives,
// which would leave the app registered but unable to start without wifi.
self.addEventListener('message', event => {
  if (event.data === 'ensure-cache') event.waitUntil(precache().catch(() => {}));
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return; // don't touch cross-origin

  // Opening the game from the home screen is a navigation, and offline it must
  // never wait on the network: serve the cached shell whatever form the start
  // URL takes — trailing slash, index.html, or a stray query string.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const hit = await caches.match(req, { ignoreSearch: true });
      if (hit) return hit;
      try {
        return await fetch(req);
      } catch (e) {
        return (await caches.match(SHELL)) || Response.error();
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(req, { ignoreSearch: true });
    if (cached) return cached;
    try {
      const res = await fetch(req);
      if (res && res.ok) {
        const clone = res.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(req, clone));
      }
      return res;
    } catch (e) {
      return Response.error();
    }
  })());
});
