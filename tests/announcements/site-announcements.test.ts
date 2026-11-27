import { describe, expect, test } from 'bun:test'
import { NextRequest } from 'next/server'
import { validateAnnouncementMediaSignature } from '../../src/lib/file-signature'
import {
  announcementVideoDescriptor,
  canManageSiteAnnouncements,
  filterActiveSiteAnnouncements,
  firstUnseenAnnouncementCard,
  parseSiteAnnouncementsValue,
  validateAnnouncementInput,
  type SiteAnnouncement,
} from '../../src/lib/site-announcements-core'

function announcement(patch: Partial<SiteAnnouncement> = {}): SiteAnnouncement {
  return {
    id: patch.id || crypto.randomUUID(),
    title: patch.title || 'عنوان إعلان',
    summary: patch.summary || 'ملخص الإعلان',
    body: patch.body || 'تفاصيل الإعلان',
    display: patch.display || 'TICKER',
    active: patch.active ?? true,
    startsAt: patch.startsAt ?? null,
    endsAt: patch.endsAt ?? null,
    createdAt: patch.createdAt || '2026-10-21T10:00:00.000Z',
    updatedAt: patch.updatedAt || '2026-10-21T10:00:00.000Z',
  }
}

describe('site announcements', () => {
  test('validation rejects invalid lengths, display values, and HTML-like text', () => {
    expect(() => validateAnnouncementInput({ title: 'x'.repeat(121), summary: 'ملخص', body: '', display: 'TICKER' })).toThrow()
    expect(() => validateAnnouncementInput({ title: 'عنوان', summary: 'x'.repeat(201), body: '', display: 'TICKER' })).toThrow()
    expect(() => validateAnnouncementInput({ title: 'عنوان', summary: 'ملخص', body: 'x'.repeat(5001), display: 'TICKER' })).toThrow()
    expect(() => validateAnnouncementInput({ title: 'عنوان', summary: 'ملخص', body: '', display: 'BANNER' })).toThrow()
    expect(() => validateAnnouncementInput({ title: '<b>عنوان</b>', summary: 'ملخص', body: '', display: 'TICKER' })).toThrow()
  })

  test('validation accepts the three supported display types', () => {
    expect(validateAnnouncementInput({ title: 'عنوان', summary: 'ملخص', body: '', display: 'TICKER' }).display).toBe('TICKER')
    expect(validateAnnouncementInput({ title: 'عنوان', summary: 'ملخص', body: '', display: 'PULSE' }).display).toBe('PULSE')
    expect(validateAnnouncementInput({ title: 'عنوان', summary: 'ملخص', body: '', display: 'CARD' }).display).toBe('CARD')
  })

  test('media validation accepts direct files and known providers, rejects bad URLs', () => {
    const base = { title: 'عنوان', summary: 'ملخص', body: '' }
    expect(validateAnnouncementInput({ ...base, videoUrl: 'https://example.com/video.mp4' }).videoUrl).toBe('https://example.com/video.mp4')
    expect(validateAnnouncementInput({ ...base, videoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }).videoUrl).toContain('youtube.com')
    expect(validateAnnouncementInput({ ...base, imageUrls: ['https://example.com/a.jpg', 'https://example.com/b.webp'] }).imageUrls).toEqual([
      'https://example.com/a.jpg',
      'https://example.com/b.webp',
    ])
    expect(() => validateAnnouncementInput({ ...base, videoUrl: 'http://example.com/video.mp4' })).toThrow()
    expect(() => validateAnnouncementInput({ ...base, videoUrl: 'https://example.com/page' })).toThrow()
    expect(() => validateAnnouncementInput({ ...base, videoUrl: 'https://example.com/video.avi' })).toThrow()
    expect(() => validateAnnouncementInput({ ...base, imageUrls: ['http://example.com/a.jpg'] })).toThrow()
    expect(() => validateAnnouncementInput({ ...base, imageUrls: ['https://example.com/a.gif'] })).toThrow()
    expect(() => validateAnnouncementInput({ ...base, imageUrls: ['https://example.com/1.jpg', 'https://example.com/2.jpg', 'https://example.com/3.jpg', 'https://example.com/4.jpg', 'https://example.com/5.jpg', 'https://example.com/6.jpg'] })).toThrow()
    expect(() => validateAnnouncementInput({ ...base, imageUrls: 'https://example.com/a.jpg' })).toThrow()
  })

  test('media magic bytes must match the exact extension and declared MIME', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])
    expect(validateAnnouncementMediaSignature({ buffer: png, fileName: 'photo.png', mimeType: 'image/png' }).ok).toBe(true)
    expect(validateAnnouncementMediaSignature({ buffer: png, fileName: 'photo.jpg', mimeType: 'image/jpeg' }).ok).toBe(false)
    expect(validateAnnouncementMediaSignature({ buffer: png, fileName: 'photo.png', mimeType: 'image/jpeg' }).ok).toBe(false)
    const mp4 = Buffer.alloc(64)
    mp4.write('ftypisom', 4, 'ascii')
    expect(validateAnnouncementMediaSignature({ buffer: mp4, fileName: 'movie.mp4', mimeType: 'video/mp4' }).ok).toBe(true)
    expect(validateAnnouncementMediaSignature({ buffer: mp4, fileName: 'movie.webm', mimeType: 'video/webm' }).ok).toBe(false)
    const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00])
    expect(validateAnnouncementMediaSignature({ buffer: webm, fileName: 'movie.webm', mimeType: 'video/webm' }).ok).toBe(true)
    expect(validateAnnouncementMediaSignature({ buffer: webm, fileName: 'movie.mp4', mimeType: 'video/mp4' }).ok).toBe(false)
  })

  test('stored rows without media fields still normalise (back-compat)', () => {
    const items = parseSiteAnnouncementsValue(
      JSON.stringify([{ id: 'old-1', title: 'عنوان قديم', summary: 'ملخص', body: '', display: 'TICKER', active: true }]),
    )
    expect(items).toHaveLength(1)
    expect(items[0].videoUrl).toBeNull()
    expect(items[0].imageUrls).toEqual([])
  })

  test('video descriptor maps direct files, providers, and nothing', () => {
    expect(announcementVideoDescriptor('https://example.com/video.mp4')).toEqual({ kind: 'file', url: 'https://example.com/video.mp4' })
    const uploadedVideoUrl = 'https://academy.example/api/files/announcements/media/2026-11-27/11111111-1111-4111-8111-111111111111-lecture.mp4'
    expect(announcementVideoDescriptor(uploadedVideoUrl)).toEqual({ kind: 'file', url: uploadedVideoUrl })
    const yt = announcementVideoDescriptor('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
    expect(yt?.kind).toBe('embed')
    expect(yt?.source).toBe('YOUTUBE')
    expect(yt?.embedId).toBe('dQw4w9WgXcQ')
    expect(announcementVideoDescriptor(null)).toBeNull()
    expect(announcementVideoDescriptor('')).toBeNull()
  })

  test('first unseen card picks the newest unread card, one at a time', () => {
    const items = [
      announcement({ id: 'new-card', display: 'CARD', active: true }),
      announcement({ id: 'old-card', display: 'CARD', active: true }),
      announcement({ id: 'ticker', display: 'TICKER', active: true }),
      announcement({ id: 'inactive-card', display: 'CARD', active: false }),
    ]
    expect(firstUnseenAnnouncementCard(items, [])?.id).toBe('new-card')
    expect(firstUnseenAnnouncementCard(items, ['new-card'])?.id).toBe('old-card')
    expect(firstUnseenAnnouncementCard(items, ['new-card', 'old-card'])).toBeNull()
    expect(firstUnseenAnnouncementCard([], [])).toBeNull()
  })

  test('active filtering honors active flag and date window', () => {
    const now = '2026-10-21T12:00:00.000Z'
    const items = [
      announcement({ id: 'active-now', active: true, startsAt: '2026-10-21T11:00:00.000Z', endsAt: '2026-10-21T13:00:00.000Z' }),
      announcement({ id: 'inactive', active: false }),
      announcement({ id: 'future', active: true, startsAt: '2026-10-21T13:00:01.000Z' }),
      announcement({ id: 'expired', active: true, endsAt: '2026-10-21T11:59:59.000Z' }),
      announcement({ id: 'no-window', active: true }),
      announcement({ id: 'card-now', display: 'CARD', active: true, startsAt: '2026-10-21T11:00:00.000Z', endsAt: '2026-10-21T13:00:00.000Z' }),
      announcement({ id: 'card-future', display: 'CARD', active: true, startsAt: '2026-10-21T13:00:01.000Z' }),
    ]

    expect(filterActiveSiteAnnouncements(items, now).map((item) => item.id)).toEqual(['active-now', 'no-window', 'card-now'])
  })

  test('public announcement media gets a signed redirect while private documents still require login', async () => {
    const { __handleFileGetForTests } = await import('../../src/app/api/files/[...key]/route')
    const mediaKey = 'announcements/media/2026-11-27/11111111-1111-4111-8111-111111111111-photo.png'
    const mediaUrl = `https://academy.example/api/files/${mediaKey}`
    let signedTtlSeconds: number | null = null
    const deps = {
      requireUser: async () => { throw new Error('no session') },
      createSignedStorageUrlForKey: (_key: string, ttlSeconds = 0) => {
        signedTtlSeconds = ttlSeconds
        return 'https://r2.example/private-object?X-Amz-Signature=test'
      },
    }
    const allowed = await __handleFileGetForTests(new NextRequest(mediaUrl), { params: { key: mediaKey.split('/') } }, deps)
    expect(allowed.status).toBe(302)
    expect(allowed.headers.get('location')).toContain('X-Amz-Signature=test')
    expect(allowed.headers.get('cache-control')).toBe('no-store')
    expect(signedTtlSeconds).toBe(3600)
    const privateKey = 'agent-documents/identity.png'
    const refused = await __handleFileGetForTests(
      new NextRequest(`https://academy.example/api/files/${privateKey}`),
      { params: { key: privateKey.split('/') } },
      deps,
    )
    expect(refused.status).toBe(401)
  })

  test('only admins can manage announcements', () => {
    expect(canManageSiteAnnouncements(null)).toBe(false)
    expect(canManageSiteAnnouncements({ role: 'STUDENT' })).toBe(false)
    expect(canManageSiteAnnouncements({ role: 'SUPERVISOR' })).toBe(false)
    expect(canManageSiteAnnouncements({ role: 'ADMIN' })).toBe(true)
  })
})
