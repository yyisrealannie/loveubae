const CACHE_NAME = 'loveubae-v1';
const ASSETS = [
  './',
  './index.html',
  './css/styles.css',
  './js/config.js',
  './js/utils.js',
  './js/backup-engine.js',
  './js/state.js',
  './js/core.js',
  './js/features.js',
  './js/listeners.js',
  './js/app.js',
  './js/supabase-sync.js',
  './js/data.js',
  './js/games.js',
  './js/onboarding.js',
  './js/features/call.js',
  './js/features/envelope.js',
  './js/features/mood.js',
  './js/features/reply-library.js',
  './js/features/theme-editor.js',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
