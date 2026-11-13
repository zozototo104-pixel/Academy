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
    expect(count(ui, 'window.confirm(')).toBe(2)
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
    expect(code).toContain('if (result.count === 0) return false')
    expect(code).toContain('if (!deleted)')
    expect(code).toContain('attendances: { none: {} }')
    expect(code).toContain('details: safeAuditDetails({')
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
