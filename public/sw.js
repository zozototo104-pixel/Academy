// AACT Platform Service Worker — PWA support for Android installation
// يخزن الملفات الثابتة فقط. لا يخزن صفحات HTML أو لوحات أو API حتى لا يرى المستخدم نسخة قديمة بعد النشر.
const CACHE_NAME = 'aact-static-v76'
const CORE_ASSETS = ['/manifest.json', '/icon-192.png', '/icon-512.png']
const STATIC_EXTENSIONS = new Set([
  '.css', '.js', '.mjs', '.map',
  '.png', '.jpg', '.jpeg', '.webp', '.avif', '.svg', '.ico',
  '.woff', '.woff2', '.ttf', '.otf',
])

function isStaticAsset(url, request) {
  if (url.origin !== self.location.origin) return false
  if (url.pathname.startsWith('/api/')) return false
  if (url.pathname.startsWith('/admin')) return false
  if (url.pathname.startsWith('/dashboard')) return false
  if (url.pathname.startsWith('/supervisor')) return false
  if (url.pathname.startsWith('/student')) return false
  if (url.pathname.startsWith('/_next/static/')) return true
  if (request.mode === 'navigate') return false
  const accept = request.headers.get('accept') || ''
  if (accept.includes('text/html')) return false
  const dot = url.pathname.lastIndexOf('.')
  if (dot < 0) return false
  return STATIC_EXTENSIONS.has(url.pathname.slice(dot).toLowerCase())
}

self.addEventListener('install', (event) => {
  self.skipWaiting()
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS).catch(() => {}))
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

// Network-first للملفات الثابتة فقط. صفحات HTML وواجهات الإدارة وواجهات الطالب وAPI تبقى مباشرة من السيرفر.
self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (!isStaticAsset(url, request)) return

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const clone = response.clone()
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone).catch(() => {}))
        }
        return response
      })
      .catch(() => caches.match(request))
  )
})
