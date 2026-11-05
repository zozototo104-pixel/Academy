import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Guard: the AI supervisor must answer lecture/meeting questions and
// progress questions from system facts only (owner complaints 2026-11-05):
//  - a RESCHEDULED lecture session must be reported as rescheduled, never
//    as "the program has no live lectures";
//  - meeting URLs/passwords must never enter the context block;
//  - the follow-up line must print the per-EPISODE counter (the same one
//    the «يحتاج تدخل» flag uses), not the all-time log count;
//  - a zero-activity student gets an explicit "has not started" fact.

process.env.LECTURES_ENABLED = 'true'

const DAY = 24 * 60 * 60 * 1000
const SCHED_NOW = new Date('2026-11-05T12:00:00.000Z')
const schedAt = (days: number, minutes = 0) => new Date(SCHED_NOW.getTime() + days * DAY + minutes * 60 * 1000)
const daysAgo = (n: number) => new Date(Date.now() - n * DAY)

let fx: any
let lastSessionArgs: any = null
let lastInviteArgs: any = null

function defaultFx() {
  return {
    enrollments: [
      { id: 'enr-1', userId: 'user-A', programId: 'p1', status: 'ACTIVE', createdAt: daysAgo(30), followUpCount: 1 },
    ],
    user: { id: 'user-A', email: 'student@example.com', lastActivityAt: daysAgo(5) },
    sessions: [] as any[],
    invites: [] as any[],
    exams: [{ id: 'e1', title: 'اختبار الوحدة الأولى' }, { id: 'e2', title: 'اختبار الوحدة الثانية' }],
    passedAttempts: [{ examId: 'e1' }],
    assignments: [{ id: 'a1', title: 'واجب أول' }],
    submissions: [{ assignmentId: 'a1' }],
    videosTotal: 3,
    progressRows: [{ watchedPercent: 100, completedAt: daysAgo(2) }],
    followUpLogCount: 3, // ALL-TIME inactivity messages — must NOT drive the line
  }
}

mock.module('@/lib/db', () => ({
  db: {
    enrollment: {
      findMany: async (args: any) => {
        const sel = args?.select
        if (sel && Object.keys(sel).length === 1 && sel.programId) {
          // getActiveLectureProgramIds shape
          return fx.enrollments.filter((e: any) => e.status === 'ACTIVE').map((e: any) => ({ programId: e.programId }))
        }
        return fx.enrollments
      },
    },
    user: { findUnique: async () => fx.user },
    lectureSession: {
      findMany: async (args: any) => {
        lastSessionArgs = args
        return fx.sessions
      },
    },
    adminMeetingInvite: {
      findMany: async (args: any) => {
        lastInviteArgs = args
        return fx.invites
      },
    },
    lectureVideoResource: { count: async () => fx.videosTotal },
    lectureWatchProgress: { findMany: async () => fx.progressRows },
    exam: { findMany: async () => fx.exams },
    examAttempt: { findMany: async () => fx.passedAttempts },
    programAssignment: { findMany: async () => fx.assignments },
    assignmentSubmission: { findMany: async () => fx.submissions },
    studentFollowUpLog: { count: async () => fx.followUpLogCount },
    supervisorChannelMessage: { count: async () => 0, findFirst: async () => null },
  },
}))

mock.module('@/lib/text-ai', () => ({ textAiCompleteJson: async () => ({}) }))
mock.module('@/lib/ai-context-builder', () => ({ buildScopedProgramCatalogSnapshot: async () => '' }))

const { buildScheduleContextBlock, buildFollowUpContextBlock } = await import('@/lib/supervisor-ai')

beforeEach(() => {
  fx = defaultFx()
  lastSessionArgs = null
  lastInviteArgs = null
})

describe('buildScheduleContextBlock (AI supervisor)', () => {
  test('reports a rescheduled session as rescheduled, a live one as live, a cancelled meeting as cancelled — and never leaks join credentials', async () => {
    fx.sessions = [
      {
        id: 's1', title: 'محاضرة الإسعاف الأولي', status: 'RESCHEDULED',
        startsAt: schedAt(2), endsAt: schedAt(2, 60),
        meetingUrl: 'https://zoom.us/j/SECRET-URL-123', meetingPasscode: 'SECRET-PASS-456',
        series: { title: 'سلسلة الإسعاف', timezone: 'Asia/Gaza', program: { titleAr: 'دبلوم الإسعاف النفسي الأولي' } },
      },
      {
        id: 's2', title: 'محاضرة الصدمات', status: 'SCHEDULED',
        startsAt: schedAt(0, -30), endsAt: schedAt(0, 30),
        series: { title: 'سلسلة الإسعاف', timezone: 'Asia/Gaza', program: { titleAr: 'دبلوم الإسعاف النفسي الأولي' } },
      },
    ]
    fx.invites = [
      { id: 'i1', meeting: { title: 'اجتماع المتابعة الإداري', status: 'CANCELLED', startsAt: schedAt(1), endsAt: schedAt(1, 60), timezone: 'Asia/Gaza' } },
      { id: 'i2', meeting: { title: 'اجتماع الترحيب', status: 'SCHEDULED', startsAt: schedAt(3), endsAt: schedAt(3, 60), timezone: 'Asia/Gaza' } },
    ]
    const block = await buildScheduleContextBlock('user-A', SCHED_NOW)
    expect(block).toContain('محاضرة الإسعاف الأولي')
    expect(block).toContain('أُعيدت جدولتها (مؤجلة)')
    expect(block).toContain('محاضرة الصدمات')
    expect(block).toContain('جارية الآن')
    expect(block).toContain('اجتماع المتابعة الإداري')
    expect(block).toContain('ملغي')
    expect(block).toContain('اجتماع الترحيب')
    expect(block).toContain('مجدول')
    // Privacy: credentials on the fixture rows must never reach the block.
    expect(block).not.toContain('SECRET-URL-123')
    expect(block).not.toContain('SECRET-PASS-456')
    expect(block).not.toContain('zoom.us')
    expect(block).not.toContain('meetingUrl')
    expect(block).not.toContain('meetingPasscode')
    // The sessions query is window-bounded (-7d..+14d) and capped.
    expect(lastSessionArgs.take).toBe(12)
    expect(new Date(lastSessionArgs.where.startsAt.gte).getTime()).toBe(SCHED_NOW.getTime() - 7 * DAY)
    expect(new Date(lastSessionArgs.where.startsAt.lte).getTime()).toBe(SCHED_NOW.getTime() + 14 * DAY)
  })

  test('both lists empty → the explicit "none scheduled" fact line, not silence', async () => {
    fx.sessions = []
    fx.invites = []
    const block = await buildScheduleContextBlock('user-A', SCHED_NOW)
    expect(block).toContain('- لا لقاءات ولا محاضرات مجدولة لهذا الطالب في النافذة الحالية')
    expect(block).toContain('لا تخترع محاضرة')
  })

  test('no active enrollments at all → empty block (like the follow-up builder)', async () => {
    fx.enrollments = []
    const block = await buildScheduleContextBlock('user-A', SCHED_NOW)
    expect(block).toBe('')
  })
})

describe('buildFollowUpContextBlock — episode counter + computed progress', () => {
  test('prints the EPISODE follow-up count (1), not the all-time log count (3), and no intervention claim', async () => {
    const block = await buildFollowUpContextBlock('user-A')
    expect(block).toContain('المرسلة إليه: 1 من 3')
    expect(block).not.toContain('المرسلة إليه: 3 من 3')
    expect(block).not.toContain('يحتاج تدخل')
    expect(block).toContain('التقدم الفعلي المحسوب: اجتاز 1 من 2 اختبارات وحدات، سلّم 1 من 1 واجبات، أكمل 1 من 3 محاضرات مسجلة.')
    expect(block).not.toContain('لم يبدأ الطالب أي نشاط')
  })

  test('zero activity → the explicit "has not started" fact line', async () => {
    fx.passedAttempts = []
    fx.submissions = []
    fx.progressRows = []
    const block = await buildFollowUpContextBlock('user-A')
    expect(block).toContain('اجتاز 0 من 2 اختبارات وحدات، سلّم 0 من 1 واجبات، أكمل 0 من 3 محاضرات مسجلة.')
    expect(block).toContain('- لم يبدأ الطالب أي نشاط دراسي فعلي بعد — لا إنجاز مسجل له في أي مكوّن.')
  })
})

describe('follow-up badge pins (episode counter on both boards)', () => {
  const root = join(import.meta.dir, '../..')
  test('AdminFollowUpTab badge renders row.followUpCount, not followUpsSent', () => {
    const src = readFileSync(join(root, 'src/components/aact/AdminFollowUpTab.tsx'), 'utf8')
    expect(src).toContain('رسائل متابعة: {row.followUpCount}/3')
    expect(src).not.toContain('رسائل متابعة: {row.followUpsSent}/3')
  })
  test('SupervisorFollowUpBoard badge renders row.followUpCount, not followUpsSent', () => {
    const src = readFileSync(join(root, 'src/components/aact/SupervisorFollowUpBoard.tsx'), 'utf8')
    expect(src).toContain('رسائل متابعة: {row.followUpCount}/3')
    expect(src).not.toContain('رسائل متابعة: {row.followUpsSent}/3')
  })
})
