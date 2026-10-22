import { describe, expect, test } from 'bun:test'
import {
  JOIN_WINDOW_MINUTES,
  deriveEffectiveStatus,
  isJoinWindowOpen,
  joinOpensAt,
  toPublicSession,
} from '../../src/lib/lectures/student'
import { buildLectureIcs } from '../../src/lib/lectures/ics'

const startsAt = new Date('2026-10-23T10:00:00.000Z')
const endsAt = new Date('2026-10-23T11:30:00.000Z')
const base = { status: 'SCHEDULED', startsAt, endsAt }
const at = (iso: string) => new Date(iso)

describe('effective lecture status is derived from time', () => {
  test('upcoming before start, live during, ended after', () => {
    expect(deriveEffectiveStatus(base, at('2026-10-23T09:00:00Z'))).toBe('SCHEDULED')
    expect(deriveEffectiveStatus(base, at('2026-10-23T10:00:00Z'))).toBe('LIVE')
    expect(deriveEffectiveStatus(base, at('2026-10-23T11:30:00Z'))).toBe('LIVE')
    expect(deriveEffectiveStatus(base, at('2026-10-23T11:30:01Z'))).toBe('ENDED')
  })

  test('stored LIVE row still ends by the clock', () => {
    expect(deriveEffectiveStatus({ ...base, status: 'LIVE' }, at('2026-10-23T12:00:00Z'))).toBe('ENDED')
  })

  test('explicit overrides always win', () => {
    expect(deriveEffectiveStatus({ ...base, status: 'CANCELLED' }, at('2026-10-23T10:30:00Z'))).toBe('CANCELLED')
    expect(deriveEffectiveStatus({ ...base, status: 'RESCHEDULED' }, at('2026-10-23T09:00:00Z'))).toBe('RESCHEDULED')
  })
})

describe('join window', () => {
  test('opens exactly 15 minutes before start and closes at the end', () => {
    expect(JOIN_WINDOW_MINUTES).toBe(15)
    expect(joinOpensAt(base).toISOString()).toBe('2026-10-23T09:45:00.000Z')
    expect(isJoinWindowOpen(base, at('2026-10-23T09:44:59Z'))).toBe(false)
    expect(isJoinWindowOpen(base, at('2026-10-23T09:45:00Z'))).toBe(true)
    expect(isJoinWindowOpen(base, at('2026-10-23T11:30:00Z'))).toBe(true)
    expect(isJoinWindowOpen(base, at('2026-10-23T11:30:01Z'))).toBe(false)
  })

  test('cancelled sessions never open', () => {
    expect(isJoinWindowOpen({ ...base, status: 'CANCELLED' }, at('2026-10-23T10:15:00Z'))).toBe(false)
  })
})

describe('public session projection', () => {
  const session = {
    ...base,
    id: 'session-1',
    seriesId: 'series-1',
    title: 'محاضرة',
    description: 'وصف',
    deliveryMode: 'EXTERNAL_LINK',
    provider: 'ZOOM',
    meetingUrl: 'https://zoom.us/j/secret',
    meetingPasscode: '123456',
    series: {
      programId: 'program-1',
      unitId: null,
      timezone: 'Asia/Gaza',
      supervisor: { name: 'المشرف' },
      program: { titleAr: 'البرنامج' },
    },
  }

  test('never leaks meeting credentials', () => {
    const pub = toPublicSession(session as never, at('2026-10-23T10:05:00Z'))
    const serialized = JSON.stringify(pub)
    expect(serialized).not.toContain('zoom.us')
    expect(serialized).not.toContain('123456')
    expect('meetingUrl' in pub).toBe(false)
    expect('meetingPasscode' in pub).toBe(false)
    expect(pub.status).toBe('LIVE')
    expect(pub.canJoin).toBe(true)
    expect(pub.supervisorName).toBe('المشرف')
  })

  test('canJoin is false before the window even while scheduled', () => {
    const pub = toPublicSession(session as never, at('2026-10-23T09:00:00Z'))
    expect(pub.canJoin).toBe(false)
    expect(pub.joinOpensAt).toBe('2026-10-23T09:45:00.000Z')
  })
})

describe('lecture ICS', () => {
  const ics = buildLectureIcs({
    sessionId: 'session-1',
    title: 'محاضرة, أسبوعية; مهمة',
    description: 'سطر أول\nسطر ثانٍ',
    startsAt,
    endsAt,
    now: at('2026-10-22T00:00:00Z'),
  })

  test('is a valid single-event calendar in UTC', () => {
    expect(ics).toContain('BEGIN:VCALENDAR')
    expect(ics).toContain('BEGIN:VEVENT')
    expect(ics).toContain('DTSTART:20261023T100000Z')
    expect(ics).toContain('DTEND:20261023T113000Z')
    expect(ics).toContain('UID:lecture-session-1@aact.academy')
    expect(ics.endsWith('\r\n')).toBe(true)
  })

  test('escapes text and never embeds a meeting link', () => {
    expect(ics).toContain('SUMMARY:محاضرة\\, أسبوعية\\; مهمة')
    expect(ics).toContain('سطر أول\\nسطر ثانٍ')
    expect(ics).not.toContain('zoom.us')
    expect(ics).not.toContain('http')
  })
})
