import { describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ===== منحة إعادة الفتح أمام موعد الواجب + الواجهات (إصلاح الفجوتين) =====
// (1) موعد الواجب كان جدارًا مطلقًا لا ترفعه منحة معتمدة.
// (2) الالتماس كان مسارًا خادميًا بلا أي شاشة — لا للطالب ولا للإدارة.

mock.module('@/lib/db', () => ({ db: {}, prisma: {} }))
mock.module('@/lib/notify', () => ({ audit: async () => {}, notify: async () => {}, notifyAdmins: async () => {} }))
mock.module('@/lib/outbox', () => ({ enqueueOutbox: async () => ({}) }))

const { hasApprovedReopenGrant } = await import('../../src/lib/reopen-appeals')

function grantWorld(grants: any[]) {
  return {
    reopenAppeal: {
      findMany: async ({ where }: any) =>
        grants.filter((g) => g.enrollmentId === where.enrollmentId && g.status === where.status),
    },
  } as any
}

describe('hasApprovedReopenGrant', () => {
  const unitGrant = { enrollmentId: 'enr1', status: 'APPROVED', unitId: 'un1', semester: 1 }
  const semesterGrant = { enrollmentId: 'enr1', status: 'APPROVED', unitId: null, semester: 2 }

  test('منحة الوحدة نفسها ترفع جدار واجبها', async () => {
    expect(await hasApprovedReopenGrant(grantWorld([unitGrant]), { enrollmentId: 'enr1', unitId: 'un1', semester: 1 })).toBe(true)
  })
  test('منحة وحدة أخرى لا ترفع واجبًا لا يخصها', async () => {
    expect(await hasApprovedReopenGrant(grantWorld([unitGrant]), { enrollmentId: 'enr1', unitId: 'un9', semester: 1 })).toBe(false)
  })
  test('المنحة الفصلية (بلا وحدة) ترفع أي واجب في فصلها فقط', async () => {
    expect(await hasApprovedReopenGrant(grantWorld([semesterGrant]), { enrollmentId: 'enr1', unitId: 'un1', semester: 2 })).toBe(true)
    expect(await hasApprovedReopenGrant(grantWorld([semesterGrant]), { enrollmentId: 'enr1', unitId: null, semester: 2 })).toBe(true)
    expect(await hasApprovedReopenGrant(grantWorld([semesterGrant]), { enrollmentId: 'enr1', unitId: null, semester: 1 })).toBe(false)
  })
  test('واجب بلا وحدة لا ترفعه منحة وحدة', async () => {
    expect(await hasApprovedReopenGrant(grantWorld([unitGrant]), { enrollmentId: 'enr1', unitId: null, semester: 1 })).toBe(false)
  })
  test('بلا منح أو بلا مخزن: لا رفع', async () => {
    expect(await hasApprovedReopenGrant(grantWorld([]), { enrollmentId: 'enr1', unitId: 'un1', semester: 1 })).toBe(false)
    expect(await hasApprovedReopenGrant({} as any, { enrollmentId: 'enr1', unitId: 'un1', semester: 1 })).toBe(false)
  })
})

describe('الأسلاك (مصادر)', () => {
  const root = join(import.meta.dir, '..', '..')
  const read = (p: string) => readFileSync(join(root, p), 'utf8')

  test('فحص موعد الواجب صار يحترم المنحة قبل الرفض', () => {
    const route = read('src/app/api/assignments/route.ts')
    expect(route).toContain('hasApprovedReopenGrant')
    expect(route).toContain('if (!granted) return NextResponse.json({ error: \'انتهى موعد التسليم\' }')
    expect(route).toContain('unitId: a.unitId ?? null')
  })
  test('واجهة الطالب على بطاقة الواجب المنتهي موعده', () => {
    const comp = read('src/components/aact/ReopenAppeal.tsx')
    expect(comp).toContain('التماس إعادة فتح التسليم')
    expect(comp).toContain('لديك منحة إعادة فتح معتمدة')
    expect(comp).toContain('قيد البتّ لدى الإدارة')
    expect(comp).toContain("'/api/reopen-appeals'")
    const dash = read('src/components/aact/DashboardView.tsx')
    expect(dash).toContain('AssignmentReopenAppeal')
    expect(dash).toContain('unitId?: string | null')
  })
  test('قائمة بتّ الإدارة موجودة ومربوطة في تبويب مراجعة التصحيح', () => {
    const comp = read('src/components/aact/AdminReopenAppeals.tsx')
    expect(comp).toContain('التماسات إعادة فتح التسليم')
    expect(comp).toContain('قبول وفتح التسليم')
    expect(comp).toContain("'/api/admin/reopen-appeals?status=PENDING'")
    expect(read('src/components/aact/AdminView.tsx')).toContain('<AdminReopenAppeals />')
    expect(read('src/app/api/admin/reopen-appeals/route.ts')).toContain('studentName')
  })
})
