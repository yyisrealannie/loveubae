const CACHE_NAME = 'loveubae-v3';
const LOCAL_ASSETS = [
  './', './index.html', './manifest.webmanifest', './css/styles.css',
  './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png',
  './js/config.js', './js/utils.js', './js/backup-engine.js', './js/state.js',
  './js/core.js', './js/features/mood.js', './js/features/envelope.js',
  './js/features/reply-library.js', './js/features/theme-editor.js',
  './js/features/group-chat.js', './js/features/call.js', './js/games.js',
  './js/features.js', './js/data.js', './js/cloud-sync.js', './js/onboarding.js',
  './js/listeners.js', './js/app.js'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(LOCAL_ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).then(response => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put('./index.html', copy));
        return response;
      }).catch(() => caches.match('./index.html'))
    );
    return;
  }
  if (url.origin === self.location.origin) {
    event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request)));
  }
});
