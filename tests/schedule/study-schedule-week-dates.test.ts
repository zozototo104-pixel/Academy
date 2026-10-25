import { describe, expect, test, mock } from 'bun:test'
import { NextRequest } from 'next/server'

// Regression test for the published-schedule date bug Haris reported from
// production (2026-10-25): week 2 items showed week 1's dates again
// (19/10 repeated for every week). Stored dayOffset is per-week (the
// generator writes 0..6 inside each week), but the route used dayOffset
// verbatim and ignored the week number whenever dayOffset existed.
// The fix normalizes: a per-week offset gains its week base, an already
// absolute offset is left untouched, and semester bases use the
// normalized offsets.

const ENROLLMENT_AT = new Date('2026-10-19T12:00:00.000Z')
const item = (id: string, semester: number, week: number, dayOffset: number | null) => ({
  id,
  programId: 'p1',
  semester,
  week,
  dayOffset,
  title: `item-${id}`,
  description: '',
  type: 'UNIT',
  unitId: null,
  studyGuideId: null,
  assignmentId: null,
  examId: null,
  durationMin: 60,
  order: 1,
  createdAt: ENROLLMENT_AT,
  status: 'PUBLISHED',
})
const ITEMS = [
  item('w1a', 1, 1, 0),
  item('w1b', 1, 1, 1),
  item('w1c', 1, 1, 3),
  item('w2a', 1, 2, 0),
  item('w2b', 1, 2, 1),
  item('w2null', 1, 2, null),
  item('w3abs', 1, 3, 14),
  item('s2w1', 2, 1, 0),
]

mock.module('@/lib/db', () => ({
  db: {
    enrollment: { findUnique: async () => ({ id: 'e1', createdAt: ENROLLMENT_AT, status: 'ACTIVE' }) },
    studyScheduleItem: { findMany: async () => ITEMS },
  },
}))
mock.module('@/lib/auth', () => ({ requireUser: async () => ({ id: 'u1' }) }))

// Same calendar arithmetic as the route (local setDate), so the test
// asserts the offset logic, not timezone-dependent calendar math.
function addDays(d: Date, n: number) {
  const x = new Date(d)
  x.setDate(x.getDate() + n)
  return x.toISOString()
}

describe('study schedule week dates', () => {
  test('per-week dayOffsets advance with the week instead of repeating week 1', async () => {
    const { GET } = await import('@/app/api/study-schedule/route')
    const res = await GET(new NextRequest('http://localhost/api/study-schedule?programId=p1'))
    expect(res.status).toBe(200)
    const body = await res.json()
    const byId = new Map<string, string>(body.items.map((i: any) => [i.id, i.targetDate]))
    expect(byId.get('w1a')).toBe(addDays(ENROLLMENT_AT, 0))
    expect(byId.get('w1b')).toBe(addDays(ENROLLMENT_AT, 1))
    expect(byId.get('w1c')).toBe(addDays(ENROLLMENT_AT, 3))
    // The reported bug: these were 0/1 before the fix (19/10, 20/10 again).
    expect(byId.get('w2a')).toBe(addDays(ENROLLMENT_AT, 7))
    expect(byId.get('w2b')).toBe(addDays(ENROLLMENT_AT, 8))
    expect(byId.get('w2null')).toBe(addDays(ENROLLMENT_AT, 7))
    // Already-absolute offsets must NOT gain a second week base.
    expect(byId.get('w3abs')).toBe(addDays(ENROLLMENT_AT, 14))
    // Semester 2 starts after semester 1's full span (max effective 14 + 7).
    expect(byId.get('s2w1')).toBe(addDays(ENROLLMENT_AT, 21))
  })
})
