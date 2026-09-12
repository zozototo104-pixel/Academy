// AACT Platform Service Worker — PWA support for Android installation
const CACHE_NAME = 'aact-v37'
const CORE_ASSETS = ['/', '/manifest.json', '/logo.png', '/icon-192.png', '/icon-512.png']

self.addEventListener('install', (event) => {
  self.skipWaiting()
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS).catch(() => {}))
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  )
})

// Network-first strategy with cache fallback (never cache API POSTs)
self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.pathname.startsWith('/api/')) return // AI + auth: always live

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok && url.origin === self.location.origin) {
          const clone = response.clone()
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone).catch(() => {}))
        }
        return response
      })
      .catch(() => caches.match(request).then((cached) => cached || caches.match('/')))
  )
})
