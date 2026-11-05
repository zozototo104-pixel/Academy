import { describe, expect, mock, test } from 'bun:test'

// المراجعة الأكاديمية الاستثنائية (المرحلة 4): قناة قرار موثّق بعد
// إغلاق فصل — مستقلة لكل فصل، ولا تغيّر درجة ولا تعيد فتحًا بذاتها.
function makeWorld() {
  const state: any = { reviews: [] as any[], outbox: [] as any[], closedSemesters: new Set<number>([1]), role: 'ADMIN', seq: 0 }
  const match = (row: any, where: any) =>
    Object.entries(where || {}).every(([k, v]) => (v === undefined ? true : row[k] === v))
  const db: any = {
    user: { findUnique: async () => ({ role: state.role }) },
    enrollment: { findUnique: async () => ({ id: 'enr1' }) },
    enrollmentSemesterState: {
      findUnique: async ({ where }: any) =>
        state.closedSemesters.has(where.enrollmentId_semester.semester) ? { status: 'CLOSED' } : { status: 'OPEN' },
    },
    exceptionalReview: {
      create: async ({ data }: any) => { const row = { id: `rev-${++state.seq}`, ...data }; state.reviews.push(row); return row },
      findFirst: async ({ where }: any) => state.reviews.find((r: any) => match(r, where)) ?? null,
      findUnique: async ({ where }: any) => state.reviews.find((r: any) => r.id === where.id) ?? null,
      updateMany: async ({ where, data }: any) => {
        let count = 0
        for (const row of state.reviews) if (match(row, where)) { Object.assign(row, data); count++ }
        return { count }
      },
    },
    notificationOutbox: {
      create: async ({ data }: any) => { const row = { id: `ob-${state.outbox.length}`, ...data }; state.outbox.push(row); return row },
      findUnique: async () => null,
    },
  }
  return { state, db }
}

const world = makeWorld()
mock.module('@/lib/db', () => ({ db: world.db }))
const { openExceptionalReview, decideExceptionalReview } = await import('../../src/lib/exceptional-review')

describe('المراجعة الأكاديمية الاستثنائية', () => {
  test('تُفتح لفصل أول مغلق دون اشتراط إغلاق الثاني، وتمنع التكرار المفتوح', async () => {
    const r = await openExceptionalReview(world.db, { userId: 'u1', programId: 'p1', semester: 1, reason: 'خطأ مثبت في تصحيح سؤال' })
    expect(r.ok).toBe(true)
    const dup = await openExceptionalReview(world.db, { userId: 'u1', programId: 'p1', semester: 1, reason: 'مرة أخرى' })
    expect(dup).toEqual({ ok: false, code: 'REVIEW_ALREADY_OPEN' })
    const openSemester = await openExceptionalReview(world.db, { userId: 'u1', programId: 'p1', semester: 2, reason: 'فصل قائم' })
    expect(openSemester).toEqual({ ok: false, code: 'SEMESTER_NOT_CLOSED' })
    expect(world.state.outbox.map((o: any) => o.kind)).toContain('EXCEPTIONAL_REVIEW_OPENED')
  })

  test('البتّ إداري موثّق ومشروط بالحالة، ولا يغيّر أي درجة بذاته', async () => {
    const id = world.state.reviews[0].id
    world.state.role = 'SUPERVISOR'
    const forbidden = await decideExceptionalReview(world.db, { reviewId: id, actor: { id: 'x' }, note: 'قرار' })
    expect(forbidden).toEqual({ ok: false, code: 'FORBIDDEN' })
    world.state.role = 'ADMIN'
    const noNote = await decideExceptionalReview(world.db, { reviewId: id, actor: { id: 'admin' }, note: ' ' })
    expect(noNote).toEqual({ ok: false, code: 'INVALID_INPUT' })
    const decided = await decideExceptionalReview(world.db, { reviewId: id, actor: { id: 'admin' }, note: 'ثبت الخطأ؛ صُحّحت الدرجة بمسار التصحيح وأُعيدت مصادقة الفصل.' })
    expect(decided.ok).toBe(true)
    if (decided.ok) expect(decided.review.status).toBe('DECIDED')
    const again = await decideExceptionalReview(world.db, { reviewId: id, actor: { id: 'admin' }, note: 'ثانية' })
    expect(again).toEqual({ ok: false, code: 'REVIEW_ALREADY_DECIDED' })
  })
})
