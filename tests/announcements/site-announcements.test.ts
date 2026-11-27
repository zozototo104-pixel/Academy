import { describe, expect, test } from 'bun:test'
import {
  announcementVideoDescriptor,
  canManageSiteAnnouncements,
  filterActiveSiteAnnouncements,
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
    const yt = announcementVideoDescriptor('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
    expect(yt?.kind).toBe('embed')
    expect(yt?.source).toBe('YOUTUBE')
    expect(yt?.embedId).toBe('dQw4w9WgXcQ')
    expect(announcementVideoDescriptor(null)).toBeNull()
    expect(announcementVideoDescriptor('')).toBeNull()
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

  test('only admins can manage announcements', () => {
    expect(canManageSiteAnnouncements(null)).toBe(false)
    expect(canManageSiteAnnouncements({ role: 'STUDENT' })).toBe(false)
    expect(canManageSiteAnnouncements({ role: 'SUPERVISOR' })).toBe(false)
    expect(canManageSiteAnnouncements({ role: 'ADMIN' })).toBe(true)
  })
})
