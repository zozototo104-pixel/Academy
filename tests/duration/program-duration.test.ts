import { describe, expect, test } from 'bun:test'
import {
  getProgramMaxDays,
  getEnrollmentDeadline,
  getSemesterUnitWindows,
  daysLeftUntil,
} from '@/lib/program-duration'

const start = new Date('2026-01-01T10:00:00.000Z')

describe('program max days', () => {
  test('per-program value wins over the category default', () => {
    expect(getProgramMaxDays({ category: 'DIPLOMA', maxStudyDays: 120 })).toBe(120)
  })
  test('category defaults: diploma 90, masters/doctorate 180', () => {
    expect(getProgramMaxDays({ category: 'DIPLOMA', maxStudyDays: null })).toBe(90)
    expect(getProgramMaxDays({ category: 'MASTERS', maxStudyDays: null })).toBe(180)
    expect(getProgramMaxDays({ category: 'DOCTORATE', maxStudyDays: null })).toBe(180)
  })
  test('other categories have no automatic max', () => {
    expect(getProgramMaxDays({ category: 'ACCREDITATION', maxStudyDays: null })).toBeNull()
  })
  test('deadline = enrollment + max days + granted extensions', () => {
    const deadline = getEnrollmentDeadline(start, { category: 'DIPLOMA', maxStudyDays: null }, 30)
    expect(deadline?.toISOString().slice(0, 10)).toBe('2026-05-01')
    expect(daysLeftUntil(deadline!, new Date('2026-04-21T10:00:00.000Z'))).toBe(10)
  })
})

describe('semester unit windows', () => {
  test('equal per semester first, then equal per unit within the semester', () => {
    const units = [
      ...[1, 2, 3, 4, 5].map((i) => ({ id: `s1u${i}`, semester: 1, order: i })),
      ...[1, 2, 3].map((i) => ({ id: `s2u${i}`, semester: 2, order: i })),
    ]
    const windows = getSemesterUnitWindows(start, { category: 'DIPLOMA', maxStudyDays: null, semestersCount: 2 }, units)
    expect(windows).toHaveLength(8)
    const byId = new Map(windows.map((w) => [w.unitId, w]))
    // Semester 1: 45 days / 5 units = 9 days each.
    expect(byId.get('s1u1')!.startAt.toISOString().slice(0, 10)).toBe('2026-01-01')
    expect(byId.get('s1u1')!.endAt.toISOString().slice(0, 10)).toBe('2026-01-10')
    expect(byId.get('s1u5')!.endAt.toISOString().slice(0, 10)).toBe('2026-02-15')
    // Semester 2 starts after semester 1, 15 days per unit.
    expect(byId.get('s2u1')!.startAt.toISOString().slice(0, 10)).toBe('2026-02-15')
    expect(byId.get('s2u3')!.endAt.toISOString().slice(0, 10)).toBe('2026-04-01')
  })
  test('windows never run past the deadline', () => {
    const units = [1, 2, 3].map((i) => ({ id: `u${i}`, semester: 1, order: i }))
    const windows = getSemesterUnitWindows(start, { category: 'DIPLOMA', maxStudyDays: 91, semestersCount: 1 }, units)
    const last = windows[windows.length - 1]
    expect(last.endAt.toISOString().slice(0, 10)).toBe('2026-04-02')
  })
})
