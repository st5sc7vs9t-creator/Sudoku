const CACHE_NAME = 'sudoku-cache-v5';
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

async function shellIsComplete() {
  const cache = await caches.open(CACHE_NAME);
  for (const url of CRITICAL) {
    if (!(await cache.match(url))) return false;
  }
  return true;
}

// The cache can disappear under a worker that is still registered and running:
// the browser clears the origin's storage, but the registration survives. From
// then on the app looks installed and is in fact unbootable offline. So instead
// of trusting the install, re-check on every launch and restock while there is
// still a network to restock from. One run at a time — a launch fires several
// requests and they must not each start their own download.
let restocking = null;
function restockIfIncomplete() {
  if (restocking) return restocking;
  restocking = (async () => {
    if (await shellIsComplete()) return;
    await precache().catch(() => {});
  })().catch(() => {}).then(() => { restocking = null; });
  return restocking;
}

self.addEventListener('install', event => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => restockIfIncomplete())
  );
});

// The page asks for this when it finds files missing, and when the tablet comes
// back online after a launch that had nothing to work with.
self.addEventListener('message', event => {
  if (event.data === 'ensure-cache') event.waitUntil(restockIfIncomplete());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return; // don't touch cross-origin

  // Opening the game from the home screen is a navigation, and offline it must
  // never wait on the network: serve the cached shell whatever form the start
  // URL takes — trailing slash, index.html, or a stray query string.
  if (req.mode === 'navigate') {
    // Registered synchronously, before the response body awaits anything, so the
    // event is still dispatching and waitUntil() is allowed to extend it.
    event.waitUntil(restockIfIncomplete());
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const hit = await cache.match(req, { ignoreSearch: true }) || await cache.match(SHELL);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        // Nothing was cached, so this launch is also the one chance to store the
        // shell back — restockIfIncomplete() above is doing that in parallel.
        if (res && res.ok) cache.put(SHELL, res.clone()).catch(() => {});
        return res;
      } catch (e) {
        return Response.error();
      }
    })());
    return;
  }

  event.respondWith((async () => {
    // Matched inside the current cache only: a global caches.match() can answer
    // from a superseded version that activate() has not deleted yet.
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req, { ignoreSearch: true });
    if (cached) return cached;
    try {
      const res = await fetch(req);
      if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
      return res;
    } catch (e) {
      return Response.error();
    }
  })());
});
