import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Lecture-session delete dialog (Haris 2026-11-13): the session-delete
// button used the browser's native window.confirm — a system screen —
// while the rest of the platform uses its own styled Dialog (see
// AdminMeetings.tsx: ConfirmState + askDeleteMeeting + the max-w-sm
// Dialog with تراجع/تأكيد). This change mirrors that pattern exactly:
// same title/message text, same DELETE call, same attendances guard.
// The session-CANCEL confirm and the video-delete confirm are different
// actions and are deliberately NOT touched.
const root = join(import.meta.dir, '..', '..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')
const view = () => read('src/components/aact/AdminLectures.tsx')
const meetings = () => read('src/components/aact/AdminMeetings.tsx')
const count = (hay: string, needle: string) => hay.split(needle).length - 1

const DELETE_MESSAGE =
  'حذف لقاء «${s.title}» نهائيًا؟ سيُزال موعده ويُفصل عنه أي فيديو مرتبط، ولن تتأثر الفيديوهات نفسها. لا يمكن استعادة اللقاء بعد الحذف.'

describe('lecture session delete dialog', () => {
  test('the session-delete path no longer uses window.confirm', () => {
    const v = view()
    // The delete button now opens the custom confirm state instead.
    expect(v).toContain('onClick={() => askDeleteSession(s)}')
    expect(v).not.toContain(`window.confirm(\`${DELETE_MESSAGE}\`)`)
    // Exactly two native confirms remain: session CANCEL and video DELETE.
    // Both are different actions, out of scope for this change.
    expect(count(v, 'window.confirm(')).toBe(2)
    expect(v).toContain('إلغاء محاضرة «${s.title}»؟ سيُشعر الطلاب فورًا.')
    expect(v).toContain('حذف فيديو «${v.title}» نهائيًا؟')
  })

  test('the delete button sets the custom confirm state with the same title and message', () => {
    const v = view()
    expect(v).toContain('const askDeleteSession = (s: SessionRow) => {')
    expect(v).toContain('setConfirm({')
    expect(v).toContain("title: 'حذف اللقاء'")
    expect(v).toContain(`message: \`${DELETE_MESSAGE}\``)
    // The confirm state type mirrors AdminMeetings (local, not exported).
    expect(v).toContain('type ConfirmState = { title: string; message: string; run: () => Promise<void> }')
    expect(v).toContain('const [confirm, setConfirm] = useState<ConfirmState | null>(null)')
    expect(meetings()).toContain('type ConfirmState = { title: string; message: string; run: () => Promise<void> }')
  })

  test('the confirm dialog renders تراجع/تأكيد, destructive تأكيد disabled while busy', () => {
    const v = view()
    expect(v).toContain('{confirm && (')
    expect(v).toContain('<Dialog open onOpenChange={(o) => !o && setConfirm(null)}>')
    expect(v).toContain('<DialogContent className="max-w-sm">')
    expect(v).toContain('<DialogTitle>{confirm.title}</DialogTitle>')
    expect(v).toContain('<p className="text-sm leading-6 text-slate-600">{confirm.message}</p>')
    expect(v).toContain('<Button variant="outline" onClick={() => setConfirm(null)}>')
    expect(v).toContain('تراجع')
    expect(v).toContain('variant="destructive"')
    expect(v).toContain('disabled={busy}')
    expect(v).toContain('تأكيد')
    // Close first, then run — the AdminMeetings order, so the dialog is
    // gone before the delete starts.
    const dialogAt = v.indexOf('{confirm && (')
    const runAt = v.indexOf('const run = confirm.run', dialogAt)
    const closeAt = v.indexOf('setConfirm(null)', runAt)
    const voidAt = v.indexOf('void run()', closeAt)
    expect(runAt).toBeGreaterThan(dialogAt)
    expect(closeAt).toBeGreaterThan(runAt)
    expect(voidAt).toBeGreaterThan(closeAt)
  })

  test('the attendances guard still disables the delete button', () => {
    const v = view()
    expect(v).toContain('disabled={busy || s._count.attendances > 0}')
    expect(v).toContain("title={s._count.attendances > 0 ? 'لا يمكن حذف لقاء فيه سجل حضور؛ استخدم الإلغاء للاحتفاظ بالسجل الأكاديمي' : 'حذف اللقاء من قاعدة البيانات'}")
  })

  test('the delete flow itself is unchanged', () => {
    const v = view()
    // Exactly one DELETE call for sessions, inside askDeleteSession.
    expect(count(v, "api<{ deleted: boolean; notificationWarning?: boolean }>(`/api/admin/lectures/sessions/${s.id}`, { method: 'DELETE' })")).toBe(1)
    expect(v).toContain("toast({ title: 'حُذف اللقاء، لكن تعذر إرسال إشعار لبعض الطلاب', variant: 'destructive' })")
    expect(v).toContain("}, 'حُذف اللقاء')")
  })
})
