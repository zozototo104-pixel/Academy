// Pure parser that turns a pasted video URL into a provider detection for
// lecture videos: source kind, embed id, a safe embed URL (for iframe
// providers), a derivable thumbnail and an optional start offset.
//
// Safety contract: only clean https URLs are accepted. Anything with a
// non-https scheme, embedded credentials, or no host is rejected (null).
// Unknown but safe URLs fall back to EXTERNAL, which the player opens
// outside the platform instead of embedding. No network calls happen here
// (no oEmbed, no SSRF surface); thumbnails are derived only where the
// provider exposes a deterministic URL pattern (YouTube).

export type ParsedVideo = {
  source:
    | 'YOUTUBE'
    | 'VIMEO'
    | 'DRIVE'
    | 'FACEBOOK'
    | 'DAILYMOTION'
    | 'LOOM'
    | 'BUNNY'
    | 'CLOUDFLARE'
    | 'MP4'
    | 'WEBM'
    | 'HLS'
    | 'EXTERNAL'
  embedId: string | null
  embedUrl: string | null
  originalUrl: string
  thumbnailUrl: string | null
  startSeconds: number | null
}

function parseStartSeconds(value: string | null): number | null {
  if (!value) return null
  if (/^\d+$/.test(value)) return Number(value)
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value.trim())
  if (!m || (!m[1] && !m[2] && !m[3])) return null
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)
}

const YT_ID = /^[A-Za-z0-9_-]{11}$/

function parseYouTube(url: URL, host: string): ParsedVideo | null {
  let id: string | null = null
  if (host === 'youtu.be') {
    id = url.pathname.split('/').filter(Boolean)[0] ?? null
  } else if (url.pathname === '/watch') {
    id = url.searchParams.get('v')
  } else {
    const m = /^\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{11})/.exec(url.pathname)
    id = m?.[1] ?? null
  }
  if (!id || !YT_ID.test(id)) return null
  const startSeconds = parseStartSeconds(url.searchParams.get('t') ?? url.searchParams.get('start'))
  return {
    source: 'YOUTUBE',
    embedId: id,
    embedUrl: `https://www.youtube-nocookie.com/embed/${id}${startSeconds ? `?start=${startSeconds}` : ''}`,
    originalUrl: url.toString(),
    thumbnailUrl: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    startSeconds,
  }
}

export function parseVideoUrl(raw: string): ParsedVideo | null {
  const trimmed = (raw ?? '').trim()
  if (!trimmed || trimmed.length > 4096) return null
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null
  if (url.username || url.password) return null
  const host = url.hostname.toLowerCase()
  if (!host || host.includes(' ')) return null

  const base: ParsedVideo = {
    source: 'EXTERNAL',
    embedId: null,
    embedUrl: null,
    originalUrl: url.toString(),
    thumbnailUrl: null,
    startSeconds: null,
  }

  if (host === 'youtu.be' || host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
    return parseYouTube(url, host) ?? base
  }
  if (host === 'vimeo.com' || host === 'www.vimeo.com') {
    const m = /^\/(\d{6,})(?:\/([A-Za-z0-9]+))?/.exec(url.pathname)
    if (m) {
      const hash = m[2] ?? url.searchParams.get('h')
      return {
        ...base,
        source: 'VIMEO',
        embedId: m[1],
        embedUrl: `https://player.vimeo.com/video/${m[1]}${hash ? `?h=${hash}` : ''}`,
      }
    }
  }
  if (host === 'player.vimeo.com') {
    const m = /^\/video\/(\d{6,})/.exec(url.pathname)
    if (m) {
      const hash = url.searchParams.get('h')
      return {
        ...base,
        source: 'VIMEO',
        embedId: m[1],
        embedUrl: `https://player.vimeo.com/video/${m[1]}${hash ? `?h=${hash}` : ''}`,
      }
    }
  }
  if (host === 'drive.google.com') {
    const m = /^\/file\/d\/([A-Za-z0-9_-]{10,})/.exec(url.pathname)
    if (m) {
      return {
        ...base,
        source: 'DRIVE',
        embedId: m[1],
        embedUrl: `https://drive.google.com/file/d/${m[1]}/preview`,
      }
    }
  }
  if (host.endsWith('facebook.com')) {
    const videoId = /\/videos\/(\d{5,})/.exec(url.pathname)?.[1] ?? url.searchParams.get('v')
    if (videoId || url.pathname.includes('/watch')) {
      return {
        ...base,
        source: 'FACEBOOK',
        embedId: videoId ?? null,
        embedUrl: `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(url.toString())}&show_text=false`,
      }
    }
  }
  if (host === 'dailymotion.com' || host === 'www.dailymotion.com') {
    const m = /^\/video\/([A-Za-z0-9]+)/.exec(url.pathname)
    if (m) return { ...base, source: 'DAILYMOTION', embedId: m[1], embedUrl: `https://www.dailymotion.com/embed/video/${m[1]}` }
  }
  if (host === 'dai.ly') {
    const id = url.pathname.split('/').filter(Boolean)[0]
    if (id) return { ...base, source: 'DAILYMOTION', embedId: id, embedUrl: `https://www.dailymotion.com/embed/video/${id}` }
  }
  if (host === 'loom.com' || host === 'www.loom.com') {
    const m = /^\/(?:share|embed)\/([A-Za-z0-9]+)/.exec(url.pathname)
    if (m) return { ...base, source: 'LOOM', embedId: m[1], embedUrl: `https://www.loom.com/embed/${m[1]}` }
  }
  if (host.endsWith('mediadelivery.net')) {
    // Bunny Stream embed URLs are already iframes; keep the URL as-is.
    if (url.pathname.startsWith('/embed/') || url.pathname.startsWith('/play/')) {
      return { ...base, source: 'BUNNY', embedId: url.pathname.split('/').filter(Boolean).at(-1) ?? null, embedUrl: url.toString() }
    }
  }
  if (host.endsWith('cloudflarestream.com') || host === 'iframe.videodelivery.net') {
    const parts = url.pathname.split('/').filter(Boolean)
    const id = parts.find((p) => /^[A-Za-z0-9]{16,}$/.test(p))
    if (id) {
      return { ...base, source: 'CLOUDFLARE', embedId: id, embedUrl: `https://iframe.videodelivery.net/${id}` }
    }
  }

  // Direct media files by extension.
  const path = url.pathname.toLowerCase()
  if (path.endsWith('.m3u8')) return { ...base, source: 'HLS' }
  if (path.endsWith('.webm')) return { ...base, source: 'WEBM' }
  if (path.endsWith('.mp4') || path.endsWith('.mov') || path.endsWith('.m4v')) return { ...base, source: 'MP4' }

  return base
}
