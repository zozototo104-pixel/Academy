import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Admin-only hard deletion requires an explicit reason, a confirmation dialog,
// and preserves the academic attendance guard on both client and server.
const root = join(import.meta.dir, '..', '..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')
const view = () => read('src/components/aact/AdminLectures.tsx')
const route = () => read('src/app/api/admin/lectures/sessions/[id]/route.ts')
const count = (hay: string, needle: string) => hay.split(needle).length - 1

describe('administrator lecture deletion confirmation and reason', () => {
  test('only admin surface renders the delete action and server rejects non-admins', () => {
    const ui = view()
    expect(ui).toContain("surface === 'admin' && (")
    expect(ui).toContain("if (surface !== 'admin') return")
    expect(route()).toContain('if (!isAdmin(actor))')
    expect(route()).toContain("status: 403")
    expect(ui).toContain('onClick={() => askDeleteSession(s)}')
  })

  test('requires a reason with a visible irreversible-action confirmation', () => {
    const ui = view()
    expect(ui).toContain("title: 'حذف اللقاء'")
    expect(ui).toContain('سيُزال موعده وسجلات حضوره المرتبطة')
    expect(ui).toContain('سبب حذف اللقاء (إجباري')
    expect(ui).toContain('deleteReason.trim().length < 10')
    expect(ui).toContain('disabled={busy || deleteReason.trim().length < 10}')
    expect(ui).toContain('maxLength={500}')
    expect(ui).toContain('تأكيد الحذف')
    expect(ui).toContain('const reason = deleteReason.trim()')
    expect(ui).toContain('void run(reason)')
    expect(ui).toContain("body: JSON.stringify({ reason })")
    expect(ui).toContain('تراجع')
    expect(ui).not.toContain("window.confirm(`حذف لقاء")
    expect(count(ui, 'window.confirm(')).toBe(0)
    expect(ui).toContain('const accepted = await confirmAction(')
    expect(ui).toContain('{actionDialog}')
  })

  test('server validates the admin reason and records it with the audit actor', () => {
    const code = route()
    expect(code).toContain('deleteSessionSchema.safeParse(await req.json().catch(() => null))')
    expect(code).toContain("z.string().trim().min(10).max(500)")
    expect(code).toContain('reason: parsed.data.reason')
    expect(code).toContain("LECTURE_SESSION_DELETED")
    expect(code).toContain('tx.auditLog.create({')
    expect(code).toContain('actorId: actor.id')
    expect(code).toContain('actorName: actor.name')
    expect(code).toContain('details: safeAuditDetails({')
    expect(code).toContain("status: 400")
  })

  test('delete and audit commit in one transaction; audit failure rolls back the deletion', () => {
    const code = route()
    const transactionAt = code.indexOf('const deleted = await db.$transaction(async (tx) => {')
    const deleteAt = code.indexOf('await tx.lectureSession.deleteMany(', transactionAt)
    const auditAt = code.indexOf('await tx.auditLog.create(', transactionAt)
    const commitAt = code.indexOf('return { attendanceCount: attendanceSnapshot.length }', auditAt)
    const endAt = code.indexOf('}, { isolationLevel:', commitAt)
    expect(transactionAt).toBeGreaterThan(-1)
    expect(deleteAt).toBeGreaterThan(transactionAt)
    expect(auditAt).toBeGreaterThan(deleteAt)
    expect(commitAt).toBeGreaterThan(auditAt)
    expect(endAt).toBeGreaterThan(commitAt)
    // The best-effort auditLecture helper catches errors, so it must not
    // be used for a destructive operation requiring an audit guarantee.
    expect(code.slice(transactionAt, endAt)).not.toContain('auditLecture(')
    expect(code).toContain("if (removedAttendances.count !== attendanceSnapshot.length)")
    expect(code).toContain("throw new Error('LECTURE_DELETE_CONFLICT')")
    expect(code).toContain('if (result.count !== 1)')
    expect(code).toContain('attendances: { none: {} }')
    expect(code).toContain('details: safeAuditDetails({')
    expect(code).toContain("error?.code === 'P2034'")
    expect(code).toContain('status: 409')
  })

  test('admin can delete attended meetings with reason, visible warning, and archived attendance', () => {
    const ui = view()
    const code = route()
    expect(ui).toContain('attendanceCount: s._count.attendances')
    expect(ui).toContain('confirm.attendanceCount > 0')
    expect(ui).toContain('سيتم حذف {confirm.attendanceCount} سجل حضور')
    expect(ui).toContain('نسخة موثقة من تفاصيل الحضور وسبب الحذف')
    expect(ui).toContain('disabled={busy || deleteReason.trim().length < 10}')
    expect(ui).not.toContain('disabled={busy || confirm.attendanceCount > 0')
    expect(ui).not.toContain('disabled={busy || s._count.attendances > 0}')
    expect(code).not.toContain('if (session._count.attendances > 0)')
    expect(code).toContain('tx.lectureAttendance.findMany({')
    expect(code).toContain('tx.lectureAttendance.deleteMany({')
    expect(code).toContain('deletedAttendanceCount: attendanceSnapshot.length')
    expect(code).toContain('deletedAttendance: attendanceSnapshot')
    expect(code).toContain('attendances: { none: {} }')
    expect(code).toContain('deletedAttendances: deleted.attendanceCount')
    expect(code).toContain('Prisma.TransactionIsolationLevel.Serializable')
  })

  test('deletion retains the existing video detach, notification and confirmation flow', () => {
    const ui = view()
    const code = route()
    expect(ui).toContain('setConfirm({')
    expect(ui).toContain('setConfirm(null)')
    expect(ui).toContain('const run = confirm.run')
    expect(ui).toContain('حُذف اللقاء، لكن تعذر إرسال إشعار لبعض الطلاب')
    expect(code).toContain('lectureSession.deleteMany')
    expect(code).toContain('notificationWarning')
    expect(code).toContain('detachedVideos')
  })
})

// Extra integration coverage is opt-in and runs only in CI's disposable
// PostgreSQL 16 service. It calls the actual DELETE handler and uses real
// Prisma Serializable transactions. No production/QA database is touched.
if (process.env.LECTURE_DELETE_PG_CONTRACT === '1') {
  const { beforeAll, afterAll, mock } = await import('bun:test')
  const { PrismaClient } = await import('@prisma/client')
  const { NextRequest } = await import('next/server')
  const { randomUUID } = await import('node:crypto')
  const prisma = new PrismaClient()
  const prefix = 'lecture-delete-ci-' + randomUUID()
  const ids = {
    admin: prefix + '-admin', student: prefix + '-student',
    program: prefix + '-program', series: prefix + '-series',
    success: prefix + '-success', rollback: prefix + '-rollback',
    video: prefix + '-video',
  }
  let role = 'ADMIN'
  let injectAuditFailure = false

  // Only auth/notifications and deliberate audit fault are mocked.
  // All rows and the real transaction are provided by disposable Postgres.
  const routeDb = {
    lectureSession: prisma.lectureSession,
    $transaction: (fn: (tx: any) => Promise<any>, opts: any) =>
      prisma.$transaction((tx) => fn({
        lectureAttendance: tx.lectureAttendance,
        lectureSession: tx.lectureSession,
        auditLog: injectAuditFailure
          ? { create: async () => { throw new Error('CI_INJECTED_AUDIT_FAILURE') } }
          : tx.auditLog,
      }), opts),
  }
  mock.module('@/lib/db', () => ({ db: routeDb }))
  mock.module('@/lib/lectures/manage', () => ({
    requireLectureManager: async () => ({ id: ids.admin, name: 'CI Admin', role }),
    isAdmin: (actor: { role: string }) => actor.role === 'ADMIN',
    canManageSession: () => true,
    auditLecture: async () => {},
    notifyProgramStudents: async () => { throw new Error('CI_UNEXPECTED_NOTIFICATION') },
  }))
  mock.module('@/lib/lectures/config', () => ({ isLecturesEnabled: () => true }))
  const { DELETE } = await import('../../src/app/api/admin/lectures/sessions/[id]/route')
  const req = (id: string, reason: string) => new NextRequest(
    'https://academy.example/api/admin/lectures/sessions/' + id,
    { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason }) },
  )
  const params = (id: string) => ({ params: Promise.resolve({ id }) })

  describe('CI PostgreSQL: attended-session deletion, permissions and atomic audit', () => {
    beforeAll(async () => {
      await prisma.user.createMany({ data: [
        { id: ids.admin, email: ids.admin + '@example.test', name: 'CI Admin', password: 'test-only', role: 'ADMIN' },
        { id: ids.student, email: ids.student + '@example.test', name: 'CI Student', password: 'test-only', role: 'STUDENT' },
      ] })
      await prisma.program.create({
        data: { id: ids.program, slug: ids.program, titleAr: 'CI program', description: 'Test only', category: 'DIPLOMA' },
      })
      await prisma.lectureSeries.create({
        data: { id: ids.series, programId: ids.program, supervisorId: ids.admin, createdById: ids.admin, title: 'CI series', durationMin: 60 },
      })
      for (const id of [ids.success, ids.rollback]) {
        await prisma.lectureSession.create({
          data: { id, seriesId: ids.series, title: 'CI session',
            startsAt: new Date('2020-01-01T10:00:00.000Z'), endsAt: new Date('2020-01-01T11:00:00.000Z') },
        })
        await prisma.lectureAttendance.create({
          data: { sessionId: id, userId: ids.student, status: 'PRESENT', joinedAt: new Date('2020-01-01T10:01:00.000Z') },
        })
      }
      await prisma.lectureVideoResource.create({
        data: { id: ids.video, programId: ids.program, sessionId: ids.success, title: 'CI video', source: 'EXTERNAL' },
      })
    })

    afterAll(async () => {
      injectAuditFailure = false
      await prisma.auditLog.deleteMany({ where: { entity: 'LectureSession', entityId: { in: [ids.success, ids.rollback] } } })
      await prisma.lectureVideoResource.deleteMany({ where: { programId: ids.program } })
      await prisma.lectureAttendance.deleteMany({ where: { sessionId: { in: [ids.success, ids.rollback] } } })
      await prisma.lectureSession.deleteMany({ where: { seriesId: ids.series } })
      await prisma.lectureSeries.deleteMany({ where: { id: ids.series } })
      await prisma.program.deleteMany({ where: { id: ids.program } })
      await prisma.user.deleteMany({ where: { id: { in: [ids.admin, ids.student] } } })
      await prisma.$disconnect()
    })

    test('non-admin cannot remove attendance or its session', async () => {
      role = 'STUDENT'
      try {
        const response = await DELETE(req(ids.rollback, 'سبب حذف تجريبي مكتمل'), params(ids.rollback))
        expect(response.status).toBe(403)
        expect(await prisma.lectureAttendance.count({ where: { sessionId: ids.rollback } })).toBe(1)
      } finally { role = 'ADMIN' }
    })

    test('missing reason does not touch the database', async () => {
      const response = await DELETE(req(ids.rollback, 'قصير'), params(ids.rollback))
      expect(response.status).toBe(400)
      expect(await prisma.lectureSession.count({ where: { id: ids.rollback } })).toBe(1)
    })

    test('success archives attendance, deletes meeting, and preserves detached video', async () => {
      const reason = 'حذف اختبار تكاملي مع توثيق الحضور'
      const response = await DELETE(req(ids.success, reason), params(ids.success))
      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.deleted).toBe(true)
      expect(body.deletedAttendances).toBe(1)
      expect(body.detachedVideos).toBe(1)
      expect(await prisma.lectureSession.count({ where: { id: ids.success } })).toBe(0)
      expect(await prisma.lectureAttendance.count({ where: { sessionId: ids.success } })).toBe(0)
      const audit = await prisma.auditLog.findFirst({ where: { action: 'LECTURE_SESSION_DELETED', entityId: ids.success } })
      expect(audit?.actorId).toBe(ids.admin)
      const details = JSON.parse(audit?.details || '{}')
      expect(details.reason).toBe(reason)
      expect(details.deletedAttendanceCount).toBe(1)
      expect(details.deletedAttendance).toHaveLength(1)
      expect(details.deletedAttendance[0].userId).toBe(ids.student)
      const video = await prisma.lectureVideoResource.findUnique({ where: { id: ids.video } })
      expect(video).not.toBeNull()
      expect(video?.sessionId).toBeNull()
    })

    test('failed audit rolls back both session and attendance deletions', async () => {
      injectAuditFailure = true
      try {
        const response = await DELETE(req(ids.rollback, 'سبب تجريبي لفشل سجل التدقيق'), params(ids.rollback))
        expect(response.status).toBe(500)
        expect(await prisma.lectureSession.count({ where: { id: ids.rollback } })).toBe(1)
        expect(await prisma.lectureAttendance.count({ where: { sessionId: ids.rollback } })).toBe(1)
        expect(await prisma.auditLog.count({ where: { action: 'LECTURE_SESSION_DELETED', entityId: ids.rollback } })).toBe(0)
      } finally { injectAuditFailure = false }
    })
  })
}

