import { beforeEach, describe, expect, mock, test } from 'bun:test'

// Guard: follow-up board derivation + supervisor scoping + AI context block
// (student follow-up service, phases 2-3).
// Privacy invariant under test: admin-scope message CONTENT must never
// appear in the AI supervisor context block — existence + count + latest
// date only (owner decision, continuing the #146 ADMIN-scope isolation).

const NOW = new Date()
const DAY = 24 * 60 * 60 * 1000
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY)
const ADMIN_SECRET = 'ADMIN-SECRET-CONTENT-ممنوع-يظهر'

let boardEnrollments: any[] = []

mock.module('@/lib/db', () => ({
  db: {
    enrollment: {
      findMany: async (args: any) => {
        if (args?.select) return [{ id: 'enr-1', programId: 'p1', createdAt: daysAgo(30), followUpCount: 3 }]
        return boardEnrollments
      },
      update: async () => ({}),
    },
    user: {
      findMany: async () => [
        { id: 'user-A', lastActivityAt: daysAgo(5) },
        { id: 'user-B', lastActivityAt: daysAgo(0) },
      ],
      findUnique: async () => ({ lastActivityAt: daysAgo(5) }),
    },
    programAssignment: {
      groupBy: async () => [{ programId: 'p1', _count: { _all: 4 } }],
      findMany: async () => [
        { id: 'a1', title: 'واجب منجز' },
        { id: 'a2', title: 'واجب معلق' },
      ],
    },
    unit: { findMany: async () => [{ id: 'u1', programId: 'p1', exam: { id: 'e1' } }, { id: 'u2', programId: 'p1', exam: { id: 'e2' } }] },
    lectureVideoResource: {
      groupBy: async () => [{ programId: 'p1', _count: { _all: 10 } }],
      count: async () => 10,
    },
    lectureWatchProgress: {
      findMany: async () => [
        { userId: 'user-A', watchedPercent: 100, completedAt: daysAgo(6), video: { programId: 'p1' } },
        { userId: 'user-A', watchedPercent: 40, completedAt: null, video: { programId: 'p1' } },
      ],
    },
    admissionApplication: {
      findMany: async (args: any) => {
        if (args?.select?.specialization) return [{ id: 'adm-1', userId: 'user-A', specialization: 'إدارة الأزمات' }]
        return [{ userId: 'user-A' }]
      },
    },
    assignmentSubmission: {
      findMany: async () => [{ userId: 'user-A', assignmentId: 'a1', assignment: { programId: 'p1' } }],
    },
    examAttempt: {
      findMany: async (args: any) => {
        if (args?.where?.passed) return [{ examId: 'e1' }]
        return [
          { userId: 'user-A', examId: 'e1', passed: true },
          { userId: 'user-A', examId: 'e2', passed: false },
        ]
      },
    },
    exam: { findMany: async () => [{ id: 'e1', title: 'اختبار منجز' }, { id: 'e2', title: 'اختبار الوحدة الثانية' }] },
    notification: {
      groupBy: async (args: any) => (args?.where?.read === false ? [{ userId: 'user-A', _count: { _all: 2 } }] : [{ userId: 'user-A', _count: { _all: 7 } }]),
      findMany: async () => [{ id: 'n1', type: 'GENERAL', title: 'تنبيه', read: false, createdAt: daysAgo(1) }],
    },
    studentFollowUpLog: {
      groupBy: async () => [{ userId: 'user-A', _count: { _all: 2 } }],
      findMany: async () => [{ id: 'log-1', kind: 'INACTIVITY_MESSAGE', messageIndex: 1, daysAbsent: 3, platformSent: true, emailSent: true, whatsappStatus: 'TEMPLATE', title: 'متابعة', createdAt: daysAgo(2) }],
      count: async () => 3,
      create: async () => ({}),
    },
    supervisorChannelMessage: {
      groupBy: async () => [{ studentId: 'user-A', _count: { _all: 3 } }],
      findMany: async (args: any) => {
        if (args?.distinct) return [{ studentId: 'user-A', createdAt: daysAgo(1) }]
        // ADMIN-scope rows carry the secret content — it must never leak.
        return [{ id: 'm1', scope: 'ADMIN', content: ADMIN_SECRET, createdAt: daysAgo(2) }]
      },
      findFirst: async () => ({ createdAt: daysAgo(2), content: ADMIN_SECRET }),
      count: async () => 2,
    },
    whatsAppConversation: { findUnique: async () => null },
  },
}))

mock.module('@/lib/notify', () => ({ notify: async () => {} }))
mock.module('@/lib/mailer', () => ({ sendEmail: async () => ({ ok: true }), emailTemplate: () => '<html></html>' }))
mock.module('@/lib/whatsapp-cloud', () => ({
  officialWhatsAppConfigured: () => false,
  sendOfficialWhatsAppText: async () => ({}),
  sendOfficialWhatsAppHumanFollowup: async () => ({}),
}))
mock.module('@/lib/whatsapp-conversations', () => ({ hashWhatsAppId: (d: string) => `hash:${d}`, recordWhatsAppOutboundMessage: async () => ({}) }))
mock.module('@/lib/text-ai', () => ({ textAiCompleteJson: async () => ({}) }))
mock.module('@/lib/ai-context-builder', () => ({ buildScopedProgramCatalogSnapshot: async () => '' }))
mock.module('@/lib/auth', () => ({
  requireUser: async () => ({ id: 'sup-1', role: 'SUPERVISOR', name: 'مشرف' }),
  requireAdmin: async () => ({ id: 'admin-1', role: 'ADMIN', name: 'أدمن' }),
}))

const { listFollowUpBoard } = await import('@/lib/student-follow-up')
const { buildFollowUpContextBlock } = await import('@/lib/supervisor-ai')
const { GET: supervisorFollowUpGET } = await import('@/app/api/supervisor/student-follow-up/route')
const { NextRequest } = await import('next/server')

function enrollmentRow(userId: string, overrides: Record<string, any> = {}) {
  return {
    id: `enr-${userId}`,
    userId,
    programId: 'p1',
    status: 'ACTIVE',
    createdAt: daysAgo(30),
    followUpCount: 3,
    lastFollowUpAt: daysAgo(1),
    program: { id: 'p1', titleAr: 'برنامج إدارة الأزمات' },
    user: { id: userId, name: 'طالب أ', email: 'a@example.com', phone: '970599000000' },
    ...overrides,
  }
}

beforeEach(() => {
  boardEnrollments = [enrollmentRow('user-A'), enrollmentRow('user-B', { followUpCount: 0 })]
})

describe('listFollowUpBoard', () => {
  test('derives duties, absence and needs-intervention per enrollment', async () => {
    const rows = await listFollowUpBoard()
    const a = rows.find((r) => r.userId === 'user-A')!
    expect(a.daysAbsent).toBe(5)
    expect(a.needsIntervention).toBe(true)
    expect(a.admissionId).toBe('adm-1')
    expect(a.specialization).toBe('إدارة الأزمات')
    expect(a.assignments).toEqual({ total: 4, submitted: 1 })
    expect(a.unitExams).toEqual({ total: 2, passed: 1 })
    expect(a.lectures).toEqual({ total: 10, watched: 2, completed: 1 })
    expect(a.platformMessages).toBe(7)
    expect(a.unreadPlatformMessages).toBe(2)
    expect(a.followUpsSent).toBe(2)
    expect(a.supervisorInteraction.count).toBe(3)
    const b = rows.find((r) => r.userId === 'user-B')!
    expect(b.daysAbsent).toBe(0)
    expect(b.needsIntervention).toBe(false)
  })

  test('restricts to the given user ids when scoped (supervisor use)', async () => {
    boardEnrollments = [enrollmentRow('user-A')]
    const rows = await listFollowUpBoard({ userIds: ['user-A'] })
    expect(rows).toHaveLength(1)
    expect(rows[0].userId).toBe('user-A')
  })
})

describe('supervisor follow-up API scoping', () => {
  test('a supervisor gets 403 for a student who is not his', async () => {
    const res = await supervisorFollowUpGET(new NextRequest('http://localhost/api/supervisor/student-follow-up?userId=user-B'))
    expect(res.status).toBe(403)
  })

  test('a supervisor can read the record of his own student', async () => {
    const res = await supervisorFollowUpGET(new NextRequest('http://localhost/api/supervisor/student-follow-up?userId=user-A'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.record.logs).toHaveLength(1)
    expect(body.record.adminMessages.count).toBe(2)
  })
})

describe('buildFollowUpContextBlock (AI supervisor)', () => {
  test('reports absence, follow-ups, lectures, pending exams/assignments', async () => {
    const block = await buildFollowUpContextBlock('user-A')
    expect(block).toContain('أيام الغياب الحالية: 5')
    expect(block).toContain('يحتاج تدخل')
    expect(block).toContain('أكمل 1 من 10')
    expect(block).toContain('اختبار الوحدة الثانية')
    expect(block).toContain('واجب معلق')
    expect(block).toContain('رسائل الإدارة')
  })

  test('PRIVACY: admin message content never enters the AI context block', async () => {
    const block = await buildFollowUpContextBlock('user-A')
    expect(block).not.toContain(ADMIN_SECRET)
    expect(block).not.toContain('ممنوع-يظهر')
  })
})
