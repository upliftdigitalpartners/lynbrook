// Service worker: offline app shell + push notifications.
const VERSION = 'v3.0.0';
const CACHE = 'evergreen-' + VERSION;
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './config.js',
  './vendor/supabase.js',
  './vendor/591.supabase.js',
  './vendor/jspdf.umd.min.js',
  './fonts/inter.woff2',
  './fonts/fraunces.woff2',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png'
];

self.addEventListener('install', (e) => {
  // cache: 'reload' skips the browser's HTTP cache so a new version never stores old files
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('evergreen-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never cache Supabase API calls
  if (url.pathname.includes('/doorstep/')) return; // Doorstep is a separate app with its own service worker

  // Pages: network first so updates arrive, fall back to the cached shell offline.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req, { cache: 'no-cache' }).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put('./index.html', copy));
        return res;
      }).catch(() => caches.match('./index.html'))
    );
    return;
  }

  // App code (JS, CSS, manifest): newest from the network first, cached copy when offline.
  if (/\.(js|css|webmanifest)$/.test(url.pathname) && !url.pathname.includes('/vendor/')) {
    e.respondWith(
      fetch(req, { cache: 'no-cache' }).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // Fonts, icons, vendor libraries: cached copy right away, refresh in the background.
  e.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});

self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (_) { data = { body: e.data && e.data.text() }; }
  const title = data.title || 'Evergreen House';
  if (typeof data.badge === 'number' && self.navigator && 'setAppBadge' in self.navigator) self.navigator.setAppBadge(data.badge).catch(() => {});
  e.waitUntil(self.registration.showNotification(title, {
    body: data.body || 'You have bills to check.',
    tag: data.tag || 'bills',
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    data: { url: data.url || './' }
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) { if (c.url.startsWith(self.registration.scope)) { c.focus(); return; } }
      return self.clients.openWindow(target);
    })
  );
});
