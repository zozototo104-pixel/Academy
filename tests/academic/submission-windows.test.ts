import { describe, expect, test } from 'bun:test'
import { submissionWindowCheck } from '../../src/lib/semester-lifecycle'

// حارس نوافذ التقديم (المرحلة 4): محاولات الوحدات وتسليمات الفصل تجري
// داخل فتراتها فقط — الرفض من المنطق الخادمي نفسه الذي تستدعيه المسارات.
const PROGRAM = { category: 'DIPLOMA', maxStudyDays: 90, semestersCount: 2 }
const ENROLLMENT = { id: 'enr1', programId: 'p1', createdAt: new Date('2026-01-01T00:00:00Z'), extensionDays: 0 }
// المدة 90 يومًا على فصلين: الفصل 1 حتى 15 شباط، ووحدتاه: الأولى حتى
// 23 كانون الثاني، والثانية حتى 15 شباط.
const UNITS = [
  { id: 'u1a', semester: 1, order: 1 },
  { id: 'u1b', semester: 1, order: 2 },
  { id: 'u2', semester: 2, order: 1 },
]

function makeClient(opts: { closed?: boolean; grant?: boolean } = {}) {
  return {
    unit: { findMany: async () => UNITS },
    enrollmentSemesterState: {
      findUnique: async () => (opts.closed ? { status: 'CLOSED', submissionDeadline: new Date('2026-02-15T00:00:00Z') } : null),
    },
    reopenAppeal: {
      findFirst: async () => (opts.grant ? { id: 'grant-1' } : null),
    },
  } as any
}
const base = { enrollment: ENROLLMENT, program: PROGRAM }

describe('حارس نوافذ التقديم', () => {
  test('داخل نافذة الوحدة: مسموح', async () => {
    const v = await submissionWindowCheck(makeClient(), { ...base, semester: 1, unitId: 'u1a', now: new Date('2026-01-10T00:00:00Z') })
    expect(v.ok).toBe(true)
  })

  test('بعد انتهاء نافذة الوحدة وقبل انتهاء الفصل: رفض خاص بالوحدة', async () => {
    const v = await submissionWindowCheck(makeClient(), { ...base, semester: 1, unitId: 'u1a', now: new Date('2026-01-30T00:00:00Z') })
    expect(v).toMatchObject({ ok: false, code: 'UNIT_WINDOW_ENDED' })
  })

  test('منحة إعادة فتح معتمدة ترفع رفض الوحدة دون فتح الفصل المنتهي', async () => {
    const granted = await submissionWindowCheck(makeClient({ grant: true }), { ...base, semester: 1, unitId: 'u1a', now: new Date('2026-01-30T00:00:00Z') })
    expect(granted.ok).toBe(true)
    const afterSemester = await submissionWindowCheck(makeClient({ grant: true }), { ...base, semester: 1, unitId: 'u1a', now: new Date('2026-02-20T00:00:00Z') })
    expect(afterSemester).toMatchObject({ ok: false, code: 'SEMESTER_WINDOW_ENDED' })
  })

  test('تسليم على مستوى الفصل بعد انتهاء فترته: مرفوض', async () => {
    const v = await submissionWindowCheck(makeClient(), { ...base, semester: 1, now: new Date('2026-02-20T00:00:00Z') })
    expect(v).toMatchObject({ ok: false, code: 'SEMESTER_WINDOW_ENDED' })
  })

  test('فصل مغلق: رفض قاطع حتى داخل النوافذ الزمنية', async () => {
    const v = await submissionWindowCheck(makeClient({ closed: true }), { ...base, semester: 1, unitId: 'u1a', now: new Date('2026-01-10T00:00:00Z') })
    expect(v).toMatchObject({ ok: false, code: 'SEMESTER_CLOSED' })
  })

  test('برنامج بلا مدة مضبوطة: لا نظام نوافذ يُخترع', async () => {
    const v = await submissionWindowCheck(makeClient(), {
      enrollment: ENROLLMENT,
      program: { category: 'OTHER', maxStudyDays: null, semestersCount: 2 },
      semester: 1, unitId: 'u1a', now: new Date('2030-01-01T00:00:00Z'),
    })
    expect(v.ok).toBe(true)
  })
})
