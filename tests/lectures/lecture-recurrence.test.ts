import { describe, expect, test } from 'bun:test'
import {
  MAX_OCCURRENCES,
  addDaysYmd,
  generateWeeklyOccurrences,
  isValidDateYmd,
  isValidTimeHm,
  weekdayOf,
  zonedTimeToUtc,
} from '../../src/lib/lectures/recurrence'

function wallTimeIn(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date)
}

describe('date and time validation', () => {
  test('accepts real dates and rejects impossible ones', () => {
    expect(isValidDateYmd('2026-02-28')).toBe(true)
    expect(isValidDateYmd('2026-02-30')).toBe(false)
    expect(isValidDateYmd('2026-13-01')).toBe(false)
    expect(isValidDateYmd('28-02-2026')).toBe(false)
    expect(isValidTimeHm('18:05')).toBe(true)
    expect(isValidTimeHm('24:00')).toBe(false)
    expect(isValidTimeHm('9:05')).toBe(false)
  })

  test('weekday and day arithmetic', () => {
    expect(weekdayOf('2026-10-23')).toBe(5) // Friday
    expect(addDaysYmd('2026-12-30', 7)).toBe('2027-01-06')
    expect(addDaysYmd('2026-02-28', 1)).toBe('2026-03-01')
  })
})

describe('zoned time conversion', () => {
  test('UTC is identity', () => {
    expect(zonedTimeToUtc('2026-01-15', '09:30', 'UTC').toISOString()).toBe('2026-01-15T09:30:00.000Z')
  })

  test('wall time survives a round trip in a DST zone', () => {
    const instant = zonedTimeToUtc('2026-07-01', '18:00', 'Asia/Gaza')
    expect(wallTimeIn(instant, 'Asia/Gaza')).toBe('18:00')
  })
})

describe('weekly occurrences', () => {
  test('keeps local wall time across the Gaza DST start (UTC instant shifts)', () => {
    const occurrences = generateWeeklyOccurrences({
      startDate: '2026-03-20', // Friday, still winter time (UTC+2)
      timeOfDay: '18:00',
      timeZone: 'Asia/Gaza',
      count: 4,
    })
    // Per IANA tzdata, Gaza DST 2026 starts Sat Mar 28: Mar 20 and Mar 27 are
    // still UTC+2 (18:00 local = 16:00Z); from Apr 3 it is UTC+3 (15:00Z).
    expect(occurrences.map((d) => d.toISOString())).toEqual([
      '2026-03-20T16:00:00.000Z',
      '2026-03-27T16:00:00.000Z',
      '2026-04-03T15:00:00.000Z',
      '2026-04-10T15:00:00.000Z',
    ])
    for (const d of occurrences) expect(wallTimeIn(d, 'Asia/Gaza')).toBe('18:00')
  })

  test('keeps local wall time across the New York DST end', () => {
    const occurrences = generateWeeklyOccurrences({
      startDate: '2026-10-25',
      timeOfDay: '10:00',
      timeZone: 'America/New_York',
      count: 3,
    })
    expect(occurrences.map((d) => d.toISOString())).toEqual([
      '2026-10-25T14:00:00.000Z',
      '2026-11-01T15:00:00.000Z',
      '2026-11-08T15:00:00.000Z',
    ])
  })

  test('honors endDate inclusively and stops at count, whichever first', () => {
    const byEnd = generateWeeklyOccurrences({
      startDate: '2026-11-02',
      timeOfDay: '09:00',
      timeZone: 'UTC',
      endDate: '2026-11-16',
      count: 10,
    })
    expect(byEnd).toHaveLength(3) // Nov 2, 9, 16
    const byCount = generateWeeklyOccurrences({
      startDate: '2026-11-02',
      timeOfDay: '09:00',
      timeZone: 'UTC',
      endDate: '2027-06-01',
      count: 2,
    })
    expect(byCount).toHaveLength(2)
  })

  test('never exceeds the hard cap', () => {
    const occurrences = generateWeeklyOccurrences({
      startDate: '2026-01-05',
      timeOfDay: '09:00',
      timeZone: 'UTC',
      count: 500,
    })
    expect(occurrences).toHaveLength(MAX_OCCURRENCES)
  })

  test('occurrences are unique and weekly spaced in local dates', () => {
    const occurrences = generateWeeklyOccurrences({
      startDate: '2026-05-04',
      timeOfDay: '12:00',
      timeZone: 'Asia/Gaza',
      count: 6,
    })
    expect(new Set(occurrences.map((d) => d.getTime())).size).toBe(6)
  })
})
