import { describe, expect, test } from 'bun:test'
import { parseVideoUrl } from '../../src/lib/lectures/video-embed'

describe('unsafe URLs are rejected', () => {
  test('non-https schemes, credentials, and garbage', () => {
    expect(parseVideoUrl('javascript:alert(1)')).toBeNull()
    expect(parseVideoUrl('data:video/mp4;base64,AAAA')).toBeNull()
    expect(parseVideoUrl('http://youtube.com/watch?v=dQw4w9WgXcQ')).toBeNull()
    expect(parseVideoUrl('https://user:pass@youtube.com/watch?v=dQw4w9WgXcQ')).toBeNull()
    expect(parseVideoUrl('//evil.com/x.mp4')).toBeNull()
    expect(parseVideoUrl('not a url')).toBeNull()
    expect(parseVideoUrl('')).toBeNull()
  })
})

describe('youtube', () => {
  test('watch, short, shorts, embed, live forms', () => {
    const watch = parseVideoUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLx')
    expect(watch?.source).toBe('YOUTUBE')
    expect(watch?.embedId).toBe('dQw4w9WgXcQ')
    expect(watch?.embedUrl).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ')
    expect(watch?.thumbnailUrl).toBe('https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg')
    expect(parseVideoUrl('https://youtu.be/dQw4w9WgXcQ')?.embedId).toBe('dQw4w9WgXcQ')
    expect(parseVideoUrl('https://www.youtube.com/shorts/dQw4w9WgXcQ')?.embedId).toBe('dQw4w9WgXcQ')
    expect(parseVideoUrl('https://www.youtube.com/embed/dQw4w9WgXcQ')?.embedId).toBe('dQw4w9WgXcQ')
    expect(parseVideoUrl('https://www.youtube.com/live/dQw4w9WgXcQ')?.embedId).toBe('dQw4w9WgXcQ')
  })

  test('start offsets: plain seconds and h/m/s forms', () => {
    expect(parseVideoUrl('https://youtu.be/dQw4w9WgXcQ?t=95')?.startSeconds).toBe(95)
    expect(parseVideoUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1h2m3s')?.embedUrl).toContain('start=3723')
    expect(parseVideoUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s')?.startSeconds).toBe(90)
  })

  test('a youtube URL without a valid id falls back to EXTERNAL, never garbage embed', () => {
    expect(parseVideoUrl('https://www.youtube.com/feed/subscriptions')?.source).toBe('EXTERNAL')
  })
})

describe('other providers', () => {
  test('vimeo public and private-hash forms', () => {
    const v = parseVideoUrl('https://vimeo.com/123456789')
    expect(v?.source).toBe('VIMEO')
    expect(v?.embedUrl).toBe('https://player.vimeo.com/video/123456789')
    const priv = parseVideoUrl('https://vimeo.com/123456789/abcdef0123')
    expect(priv?.embedUrl).toBe('https://player.vimeo.com/video/123456789?h=abcdef0123')
    const player = parseVideoUrl('https://player.vimeo.com/video/123456789?h=abcdef0123')
    expect(player?.embedUrl).toBe('https://player.vimeo.com/video/123456789?h=abcdef0123')
  })

  test('google drive preview', () => {
    const d = parseVideoUrl('https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUv/view?usp=sharing')
    expect(d?.source).toBe('DRIVE')
    expect(d?.embedUrl).toBe('https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUv/preview')
  })

  test('facebook, dailymotion, loom', () => {
    expect(parseVideoUrl('https://www.facebook.com/page/videos/1234567890123/')?.source).toBe('FACEBOOK')
    expect(parseVideoUrl('https://www.dailymotion.com/video/x8abcd1')?.embedUrl).toBe('https://www.dailymotion.com/embed/video/x8abcd1')
    expect(parseVideoUrl('https://dai.ly/x8abcd1')?.source).toBe('DAILYMOTION')
    expect(parseVideoUrl('https://www.loom.com/share/abc123def456')?.embedUrl).toBe('https://www.loom.com/embed/abc123def456')
  })

  test('bunny and cloudflare embeds', () => {
    const b = parseVideoUrl('https://iframe.mediadelivery.net/embed/12345/9f8e7d6c-aaaa-bbbb-cccc-ddddeeeeffff')
    expect(b?.source).toBe('BUNNY')
    expect(b?.embedUrl).toContain('mediadelivery.net/embed/')
    const c = parseVideoUrl('https://customer-abc123.cloudflarestream.com/0123456789abcdef0123456789abcdef/iframe')
    expect(c?.source).toBe('CLOUDFLARE')
    expect(c?.embedUrl).toBe('https://iframe.videodelivery.net/0123456789abcdef0123456789abcdef')
  })

  test('direct files and unknown sites', () => {
    expect(parseVideoUrl('https://cdn.example.com/lectures/intro.mp4')?.source).toBe('MP4')
    expect(parseVideoUrl('https://cdn.example.com/lectures/intro.webm?x=1')?.source).toBe('WEBM')
    expect(parseVideoUrl('https://cdn.example.com/live/stream.m3u8')?.source).toBe('HLS')
    const unknown = parseVideoUrl('https://videos.example.org/watch/123')
    expect(unknown?.source).toBe('EXTERNAL')
    expect(unknown?.embedUrl).toBeNull()
  })
})
