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
    expect(ui).toContain('سيُزال موعده ويُفصل عنه أي فيديو مرتبط')
    expect(ui).toContain('سبب حذف اللقاء (إجباري')
    expect(ui).toContain('deleteReason.trim().length < 10')
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

  test('administrator can inspect a blocked deletion but cannot erase an attendance ledger', () => {
    const ui = view()
    const code = route()
    expect(ui).toContain('attendanceCount: s._count.attendances')
    expect(ui).toContain('confirm.attendanceCount > 0')
    expect(ui).toContain('سجل حضور')
    expect(ui).toContain('disabled={busy || confirm.attendanceCount > 0 || deleteReason.trim().length < 10}')
    expect(ui).not.toContain('disabled={busy || s._count.attendances > 0}')
    expect(code).toContain('session._count.attendances > 0')
    expect(code).toContain('attendances: { none: {} }')
    expect(code).not.toContain('lectureAttendance.delete')
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
