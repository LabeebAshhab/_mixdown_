// Service worker: lets browsers offer "Install", and opens the page shell
// when the network is down. It is deliberately small:
//   - network first, so a new version of the app is never hidden by a cache
//   - only the handful of public shell files below are ever stored
//   - /api/ is never intercepted and never cached: songs, artwork, tags and
//     session data always go straight to the server
const CACHE = 'mixdown-shell-v2';
const SHELL = ['/', '/style.css', '/theme.js', '/lang.js', '/backdrop.js', '/app.js', '/favicon.svg', '/manifest.webmanifest', '/icons/icon-192.png', '/privacy'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  // A load of the app's page (also one carrying a shared link in its address)
  // is the shell. Other pages, like /privacy, are stored under their own path.
  const key = request.mode === 'navigate' && (url.pathname === '/' || url.pathname === '/index.html') ? '/' : url.pathname;
  if (!SHELL.includes(key)) return;
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(key, copy));
        }
        return response;
      })
      .catch(() => caches.match(key).then((hit) => hit || Response.error())),
  );
});
