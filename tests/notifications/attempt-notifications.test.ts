import { describe, test, expect, mock } from 'bun:test'

// Independence of the three notification parties (Haris's merge criterion):
// a failing send to one party must never block the others. The senders are
// mocked to throw on demand — the property under test is the caller's
// isolation, whatever the senders' own internal safety nets are.

const sent: string[] = []
let failStudentNotify = false

mock.module('@/lib/notify', () => ({
  notify: async (userId: string) => {
    if (failStudentNotify && userId === 'student-1') throw new Error('STUDENT_NOTIFY_DOWN')
    sent.push(`notify:${userId}`)
  },
  notifyAdmins: async () => { sent.push('admins') },
}))
mock.module('@/lib/supervisor-scope', () => ({
  studentHasHumanSupervisor: async () => true,
  assignedSupervisorForStudent: async () => ({ supervisorId: 'sup-1' }),
}))

const { notifyAttemptNeedsReview, notifyAttemptGraded } = await import('../../src/lib/exam-attempt-notifications')

describe('attempt notification independence', () => {
  test('a failing student notification does not block admins or the supervisor', async () => {
    sent.length = 0
    failStudentNotify = true
    await notifyAttemptNeedsReview({
      studentId: 'student-1',
      studentName: 'طالب تجريبي',
      examTitle: 'اختبار الوحدة',
      preliminary: { gradedPoints: 5, gradedMaxPoints: 10, pendingCount: 1 },
    })
    expect(sent).not.toContain('notify:student-1')
    expect(sent).toContain('admins')
    expect(sent).toContain('notify:sup-1')
  })

  test('all three parties are notified when nothing fails', async () => {
    sent.length = 0
    failStudentNotify = false
    await notifyAttemptNeedsReview({ studentId: 'student-1', examTitle: 'اختبار الوحدة' })
    expect(sent).toContain('notify:student-1')
    expect(sent).toContain('admins')
    expect(sent).toContain('notify:sup-1')
  })

  test('the graded notification reaches admins and the supervisor independently', async () => {
    sent.length = 0
    failStudentNotify = false
    await notifyAttemptGraded({ studentId: 'student-1', examTitle: 'اختبار الوحدة', score: 88 })
    expect(sent).toContain('admins')
    expect(sent).toContain('notify:sup-1')
  })
})
