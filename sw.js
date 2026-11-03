/* Solo se guarda la interfaz. Los datos de asistencia y pagos vienen del servidor. */
const CACHE = 'zoe-shell-v5';
const ASSETS = [
  './', './index.html', './style.css', './theme.js', './config.js', './app.js',
  './manifest.json', './vendor/sweetalert2.all.min.js',
  './images/zoe-logo.png', './images/icon-192.png', './images/icon-512.png',
  './images/icon-maskable-512.png', './images/apple-touch-icon.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('zoe-shell-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('message', event => {
  if (event.data === 'ACTIVATE_UPDATE') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  // Red primero: una nueva URL de despliegue o versión no queda atrapada en caché.
  event.respondWith(fetch(request).then(response => {
    if (response.ok && ASSETS.some(asset => new URL(asset, self.registration.scope).href === request.url)) {
      const copy = response.clone();
      event.waitUntil(caches.open(CACHE).then(cache => cache.put(request, copy)));
    }
    return response;
  }).catch(async () => {
    const saved = await caches.match(request);
    if (saved) return saved;
    if (request.mode === 'navigate') return await caches.match(new URL('./index.html', self.registration.scope).href);
    return new Response('', { status: 503, statusText: 'Offline' });
  }));
});
