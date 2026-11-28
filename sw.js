// Service worker: keeps a copy of the app's own files (the "app shell") on the device,
// so the app opens instantly and works offline.
//
// How updates reach the phone:
//   1. The browser re-checks this file (sw.js) on every app launch, bypassing caches.
//   2. If it changed at all (e.g. VERSION was bumped), the new worker downloads a
//      fresh full set of files into a new cache, then takes over.
//   3. Old caches are deleted. The next launch runs the new version.
// All files come from one cache version, so old and new files are never mixed.
//
// RELEASE RULE: bump VERSION whenever any file in SHELL changes, or phones keep the old app.
//
// SECURITY: only same-origin GET requests for app files are handled. Requests to
// api.github.com (the encrypted board, the token) are never intercepted or cached.

const VERSION = 'v2';
const CACHE = `kanban-shell-${VERSION}`;
const CACHE_PREFIX = 'kanban-shell-';

const SHELL = [
  'index.html',
  'manifest.webmanifest',
  'css/styles.css',
  'js/app.js',
  'js/board.js',
  'js/crypto.js',
  'js/merge.js',
  'js/storage.js',
  'js/sync.js',
  'js/ui.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  'icons/favicon-32.png',
];

const INDEX_URL = new URL('index.html', self.registration.scope).href;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // cache: 'reload' skips the browser's HTTP cache, so we never store a stale file.
    await cache.addAll(SHELL.map((path) => new Request(path, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  // Anything not ours (api.github.com included) or not a GET: let the browser handle it normally.
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith(fromShell(request));
});

async function fromShell(request) {
  const cache = await caches.open(CACHE);
  // Opening the app (any URL in scope, with or without ?query) always serves index.html.
  const cached = request.mode === 'navigate'
    ? await cache.match(INDEX_URL)
    : await cache.match(request, { ignoreSearch: true });
  return cached || fetch(request);
}
