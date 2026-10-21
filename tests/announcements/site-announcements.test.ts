import { describe, expect, test } from 'bun:test'
import {
  canManageSiteAnnouncements,
  filterActiveSiteAnnouncements,
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

  test('validation accepts the two supported display types', () => {
    expect(validateAnnouncementInput({ title: 'عنوان', summary: 'ملخص', body: '', display: 'TICKER' }).display).toBe('TICKER')
    expect(validateAnnouncementInput({ title: 'عنوان', summary: 'ملخص', body: '', display: 'PULSE' }).display).toBe('PULSE')
  })

  test('active filtering honors active flag and date window', () => {
    const now = '2026-10-21T12:00:00.000Z'
    const items = [
      announcement({ id: 'active-now', active: true, startsAt: '2026-10-21T11:00:00.000Z', endsAt: '2026-10-21T13:00:00.000Z' }),
      announcement({ id: 'inactive', active: false }),
      announcement({ id: 'future', active: true, startsAt: '2026-10-21T13:00:01.000Z' }),
      announcement({ id: 'expired', active: true, endsAt: '2026-10-21T11:59:59.000Z' }),
      announcement({ id: 'no-window', active: true }),
    ]

    expect(filterActiveSiteAnnouncements(items, now).map((item) => item.id)).toEqual(['active-now', 'no-window'])
  })

  test('only admins can manage announcements', () => {
    expect(canManageSiteAnnouncements(null)).toBe(false)
    expect(canManageSiteAnnouncements({ role: 'STUDENT' })).toBe(false)
    expect(canManageSiteAnnouncements({ role: 'SUPERVISOR' })).toBe(false)
    expect(canManageSiteAnnouncements({ role: 'ADMIN' })).toBe(true)
  })
})
