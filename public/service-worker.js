'use strict';

const CACHE_NAME = 'routine-tracker-shell-v6';
const APP_SHELL = [
  '/',
  '/index.html',
  '/styles.css?v=20261120-speed-v1',
  '/app.js?v=20261124-instant-cache-v1',
  '/favicon.svg',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith('routine-tracker-') && key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) return;

  if (request.mode === 'navigate') {
    const update = fetch(request).then(async (response) => {
      if (response.ok) {
        const cache = await caches.open(CACHE_NAME);
        await cache.put('/', response.clone());
        await cache.put('/index.html', response.clone());
      }
      return response;
    });
    event.waitUntil(update.then(() => undefined).catch(() => undefined));
    event.respondWith((async () => {
      const cached = await caches.match('/') || await caches.match('/index.html');
      if (cached) return cached;
      try { return await update; }
      catch { return Response.error(); }
    })());
    return;
  }

  if (APP_SHELL.some((entry) => new URL(entry, self.location.origin).pathname === url.pathname)) {
    event.respondWith(caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then(async (response) => {
        if (response.ok) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(request, response.clone());
        }
        return response;
      });
    }));
  }
});
