// المرحلة 6 — ضمانات الإشعارات والمسح والدورة المتصلة:
// - سجل الأحداث الصادرة: عدم تكرار المنصة مضمون بالمفتاح الفريد
//   (انقطاع بعد الحفظ وقبل الإرسال لا يضيّع الإشعار ولا يكرّره)؛
// - البريد بمحاولات موثّقة: فشل ثم نجاح بالمحاولة التالية؛
// - تحذير الموعد النهائي يُسجَّل مرة واحدة مهما تكرر المسح؛
// - خيط متصل: اعتماد رسوب ← انتقال مغلق ← إعادة اعتماد بنجاح
//   (بعد تقييم نشاط الاسترحام، كما يثبته اختبار مسار الاسترحام)
//   ← انتقال مفتوح.
// التشغيل: bun test tests/academic/lifecycle-journey.test.ts (منفردًا)
import { describe, expect, mock, test } from 'bun:test'

let emailBehavior: 'SENT' | 'FAILED' = 'SENT'
let emailSendCount = 0
const emailRecipientsSent: string[] = []
const failTheseEmailRecipients = new Set<string>()
mock.module('@/lib/db', () => ({ db: {} }))
mock.module('@/lib/mailer', () => ({
  sendEmailDetailed: async ({ to }: { to: string }) => {
    emailSendCount++
    emailRecipientsSent.push(to)
    return failTheseEmailRecipients.has(to) ? 'FAILED' : emailBehavior
  },
  emailTemplate: (title: string, body: string) => `<p>${title}</p><p>${body}</p>`,
}))
mock.module('@/lib/prod-safety', () => ({ isAactTestEmail: () => false }))

const { enqueueOutbox, dispatchOutboxBatch } = await import('@/lib/outbox')
const { scanDeadlineWarnings } = await import('@/lib/lifecycle-scans')
const { progressionGate } = await import('@/lib/progression')

// مطابقة where مصغّرة بأسلوب Prisma (مساواة/in/lt/OR/null) حتى يفسّر
// العالم الوهمي شروط المطالبة الجديدة كما تفعل قاعدة البيانات.
function matchesWhere(row: any, where: any): boolean {
  for (const [key, cond] of Object.entries(where || {})) {
    if (key === 'OR') { if (!(cond as any[]).some((w) => matchesWhere(row, w))) return false; continue }
    if (key === 'AND') { if (!(cond as any[]).every((w) => matchesWhere(row, w))) return false; continue }
    const actual = row[key]
    if (cond instanceof Date) { if (!(actual instanceof Date) || actual.getTime() !== cond.getTime()) return false; continue }
    if (cond === null) { if (actual !== null && actual !== undefined) return false; continue }
    if (cond && typeof cond === 'object') {
      if ('in' in (cond as any)) { if (!(cond as any).in.includes(actual)) return false } else if ('lt' in (cond as any)) { if (!(actual < (cond as any).lt)) return false } else if ('gt' in (cond as any)) { if (!(actual > (cond as any).gt)) return false } else if ('not' in (cond as any)) { if (actual === (cond as any).not) return false }
      continue
    }
    if (actual !== cond) return false
  }
  return true
}

function applyData(row: any, data: any) {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && !(v instanceof Date) && 'increment' in (v as any)) row[k] = (row[k] || 0) + (v as any).increment
    else row[k] = v
  }
}

function fakeOutboxWorld() {
  const outboxRows: any[] = []
  const recipientRows: any[] = []
  const notifications: any[] = []
  let seq = 0
  const client: any = {
    // E02: سجل نتيجة البريد لكل مستلم — بنفس مطبق الشروط/البيانات.
    notificationOutboxRecipient: {
      createMany: async ({ data, skipDuplicates }: any) => {
        let count = 0
        for (const d of data) {
          if (skipDuplicates && recipientRows.some((r) => r.outboxId === d.outboxId && r.recipientUserId === d.recipientUserId)) continue
          recipientRows.push({ id: `rcp${recipientRows.length + 1}`, status: 'PENDING', attempts: 0, createdAt: new Date(), ...d })
          count++
        }
        return { count }
      },
      findMany: async ({ where }: any) => recipientRows.filter((r) => matchesWhere(r, where)).map((r) => ({ ...r })),
      update: async ({ where, data }: any) => {
        const row = recipientRows.find((r) => r.id === where.id)
        if (!row) return null
        applyData(row, data)
        return row
      },
      updateMany: async ({ where, data }: any) => {
        const rows = recipientRows.filter((r) => matchesWhere(r, where))
        for (const row of rows) applyData(row, data)
        return { count: rows.length }
      },
    },
    notificationOutbox: {
      create: async ({ data }: any) => {
        if (outboxRows.some((r) => r.idempotencyKey === data.idempotencyKey)) {
          const e: any = new Error('Unique constraint failed')
          e.code = 'P2002'
          throw e
        }
        const row = { id: `ob${++seq}`, status: 'PENDING', emailStatus: 'PENDING', emailAttempts: 0, createdAt: new Date(), ...data }
        outboxRows.push(row)
        return row
      },
      findUnique: async ({ where }: any) => outboxRows.find((r) => r.idempotencyKey === where.idempotencyKey) ?? null,
      findMany: async ({ where, take }: any) => {
        // لقطات منفصلة كما في قراءة قاعدة حقيقية — لا مراجع حية للصفوف،
        // وإلا رأى الموزّع الثاني مطالبة الأول بقيمتها الجديدة لا بلقطته.
        const rows = outboxRows.filter((r) => matchesWhere(r, where)).map((r) => ({ ...r }))
        return rows.slice(0, take ?? rows.length)
      },
      update: async ({ where, data }: any) => {
        const row = outboxRows.find((r) => r.id === where.id)
        if (!row) return null
        applyData(row, data)
        return row
      },
      updateMany: async ({ where, data }: any) => {
        const rows = outboxRows.filter((r) => matchesWhere(r, where))
        for (const row of rows) applyData(row, data)
        return { count: rows.length }
      },
    },
    user: {
      findUnique: async ({ where }: any) => ({ id: where.id, email: `${where.id}@example.com`, name: 'طالب' }),
      findMany: async () => [{ id: 'admin1', email: 'admin@example.com', name: 'إدارة' }],
    },
    notification: {
      createMany: async ({ data }: any) => {
        notifications.push(...data)
        return { count: data.length }
      },
    },
    $transaction: async (fn: any) => fn(client),
  }
  return { client, outboxRows, recipientRows, notifications }
}

describe('outbox guarantees', () => {
  test('concurrent dispatchers claim one platform delivery only', async () => {
    const { client, outboxRows, notifications } = fakeOutboxWorld()
    await enqueueOutbox(client, { key: 'race-platform', kind: 'SEMESTER_CLOSED', recipientUserId: 'u1', title: 't', body: 'b' })
    const [first, second] = await Promise.all([
      dispatchOutboxBatch(client),
      dispatchOutboxBatch(client),
    ])
    expect(first.platformSent + second.platformSent).toBe(1)
    expect(notifications).toHaveLength(1)
    expect(outboxRows[0].status).toBe('SENT')
  })

  test('a failed platform transaction stays pending and is not counted as sent', async () => {
    const { client, outboxRows, notifications } = fakeOutboxWorld()
    await enqueueOutbox(client, { key: 'rollback-platform', kind: 'SEMESTER_CLOSED', recipientUserId: 'u1', title: 't', body: 'b' })
    const transaction = client.$transaction
    client.$transaction = async () => { throw new Error('transient database error') }
    const failed = await dispatchOutboxBatch(client)
    expect(failed.platformSent).toBe(0)
    expect(notifications).toHaveLength(0)
    expect(outboxRows[0].status).toBe('PENDING')
    client.$transaction = transaction
    const retried = await dispatchOutboxBatch(client)
    expect(retried.platformSent).toBe(1)
    expect(notifications).toHaveLength(1)
  })

  test('recipient database outage leaves a student notification pending until retry', async () => {
    const { client, outboxRows, notifications } = fakeOutboxWorld()
    await enqueueOutbox(client, { key: 'student-lookup', kind: 'SEMESTER_CLOSED', recipientUserId: 'u1', title: 't', body: 'b' })
    const findUnique = client.user.findUnique
    client.user.findUnique = async () => { throw new Error('student lookup unavailable') }
    try {
      const failed = await dispatchOutboxBatch(client)
      expect(failed.platformSent).toBe(0)
      expect(outboxRows[0].status).toBe('PENDING')
      expect(outboxRows[0].emailStatus).toBe('PENDING')
      expect(notifications).toHaveLength(0)
    } finally {
      client.user.findUnique = findUnique
    }
    const recovered = await dispatchOutboxBatch(client)
    expect(recovered.platformSent).toBe(1)
    expect(notifications.filter((row) => row.userId === 'u1')).toHaveLength(1)
  })

  test('admin recipient lookup outage does not silently mark an event SENT', async () => {
    const { client, outboxRows, notifications } = fakeOutboxWorld()
    await enqueueOutbox(client, { key: 'admin-lookup', kind: 'SEMESTER_FAILED', recipientRole: 'ADMINS', title: 't', body: 'b' })
    const findMany = client.user.findMany
    client.user.findMany = async () => { throw new Error('admin lookup unavailable') }
    try {
      const failed = await dispatchOutboxBatch(client)
      expect(failed.platformSent).toBe(0)
      expect(outboxRows[0].status).toBe('PENDING')
      expect(notifications).toHaveLength(0)
    } finally {
      client.user.findMany = findMany
    }
    const recovered = await dispatchOutboxBatch(client)
    expect(recovered.platformSent).toBe(1)
    expect(notifications.filter((row) => row.userId === 'admin1')).toHaveLength(1)
  })

  test('email recipient lookup outage remains retryable, not SKIPPED', async () => {
    const { client, outboxRows } = fakeOutboxWorld()
    emailBehavior = 'SENT'
    await enqueueOutbox(client, { key: 'email-lookup', kind: 'SEMESTER_CLOSED', recipientUserId: 'u1', title: 't', body: 'b' })
    outboxRows[0].status = 'SENT'
    const findUnique = client.user.findUnique
    client.user.findUnique = async () => { throw new Error('email lookup unavailable') }
    try {
      const failed = await dispatchOutboxBatch(client)
      expect(failed.emailsSent).toBe(0)
      expect(outboxRows[0].emailStatus).toBe('PENDING')
      expect(outboxRows[0].emailAttempts).toBe(0)
    } finally {
      client.user.findUnique = findUnique
    }
    const recovered = await dispatchOutboxBatch(client)
    expect(recovered.emailsSent).toBe(1)
    expect(outboxRows[0].emailStatus).toBe('SENT')
    expect(outboxRows[0].emailAttempts).toBe(1)
  })

  test('same key enqueued twice → one row; dispatched twice → exactly one platform notification', async () => {
    const { client, outboxRows, notifications } = fakeOutboxWorld()
    const evt = { key: 'semester-closed:e1:1', kind: 'SEMESTER_CLOSED', recipientUserId: 'u1', title: 'أُغلق الفصل', body: 'نتيجتك معتمدة' }
    await enqueueOutbox(client, evt)
    await enqueueOutbox(client, evt) // محاكاة إعادة المحاولة بعد انقطاع
    expect(outboxRows.length).toBe(1)
    await dispatchOutboxBatch(client)
    await dispatchOutboxBatch(client)
    expect(notifications.filter((n) => n.userId === 'u1').length).toBe(1)
    expect(outboxRows[0].status).toBe('SENT')
  })

  test('email failure is recorded and retried; success lands on the next dispatch', async () => {
    const { client, outboxRows } = fakeOutboxWorld()
    await enqueueOutbox(client, { key: 'k-email', kind: 'SEMESTER_CLOSED', recipientUserId: 'u1', title: 't', body: 'b' })
    emailBehavior = 'FAILED'
    const first = await dispatchOutboxBatch(client)
    expect(first.emailsFailed).toBe(1)
    expect(outboxRows[0].emailStatus).toBe('FAILED')
    expect(outboxRows[0].emailAttempts).toBe(1)
    emailBehavior = 'SENT'
    const second = await dispatchOutboxBatch(client)
    expect(second.emailsSent).toBe(1)
    expect(outboxRows[0].emailStatus).toBe('SENT')
    expect(outboxRows[0].emailAttempts).toBe(2)
  })

  test('failed second admin recipient retries only that recipient, not the first successful one', async () => {
    const { client, outboxRows, recipientRows } = fakeOutboxWorld()
    client.user.findMany = async () => [
      { id: 'admin1', email: 'admin1@example.com', name: 'الأول' },
      { id: 'admin2', email: 'admin2@example.com', name: 'الثاني' },
    ]
    await enqueueOutbox(client, { key: 'partial-admin-email', kind: 'SEMESTER_FAILED', recipientRole: 'ADMINS', title: 't', body: 'b' })
    emailBehavior = 'SENT'
    emailRecipientsSent.length = 0
    failTheseEmailRecipients.add('admin2@example.com')
    try {
      const first = await dispatchOutboxBatch(client)
      expect(first.emailsFailed).toBe(1)
      expect(outboxRows[0].emailStatus).toBe('FAILED')
      // E02: نقطة الحفظ صارت سجل المستلمين نفسه لا ختمًا داخل lastError.
      expect(recipientRows.find((r) => r.recipientUserId === 'admin1')?.status).toBe('SENT')
      expect(recipientRows.find((r) => r.recipientUserId === 'admin2')?.status).toBe('FAILED')
      expect(outboxRows[0].lastError).not.toContain('EMAIL_SENT_IDS')
      failTheseEmailRecipients.clear()
      const second = await dispatchOutboxBatch(client)
      expect(second.emailsSent).toBe(1)
      expect(outboxRows[0].emailStatus).toBe('SENT')
      expect(emailRecipientsSent.filter((to) => to === 'admin1@example.com')).toHaveLength(1)
      expect(emailRecipientsSent.filter((to) => to === 'admin2@example.com')).toHaveLength(2)
    } finally {
      failTheseEmailRecipients.clear()
      emailRecipientsSent.length = 0
    }
  })

  test('concurrent dispatchers claim the email once — exactly one send', async () => {
    const { client, outboxRows } = fakeOutboxWorld()
    await enqueueOutbox(client, { key: 'k-email-race', kind: 'SEMESTER_CLOSED', recipientUserId: 'u1', title: 't', body: 'b' })
    emailBehavior = 'SENT'
    emailSendCount = 0
    const [first, second] = await Promise.all([
      dispatchOutboxBatch(client),
      dispatchOutboxBatch(client),
    ])
    expect(emailSendCount).toBe(1)
    expect(first.emailsSent + second.emailsSent).toBe(1)
    expect(outboxRows[0].emailStatus).toBe('SENT')
    expect(outboxRows[0].emailAttempts).toBe(1)
  })

  test('a stale email claim (dead dispatcher) is recovered and sent', async () => {
    const { client, outboxRows } = fakeOutboxWorld()
    await enqueueOutbox(client, { key: 'k-email-stale', kind: 'SEMESTER_CLOSED', recipientUserId: 'u1', title: 't', body: 'b' })
    outboxRows[0].status = 'SENT'
    outboxRows[0].emailStatus = 'SENDING'
    outboxRows[0].emailAttempts = 1
    outboxRows[0].lastError = `EMAIL_CLAIM:${new Date(Date.now() - 11 * 60 * 1000).toISOString()}`
    emailBehavior = 'SENT'
    emailSendCount = 0
    const recovered = await dispatchOutboxBatch(client)
    expect(emailSendCount).toBe(1)
    expect(recovered.emailsSent).toBe(1)
    expect(outboxRows[0].emailStatus).toBe('SENT')
    expect(outboxRows[0].emailAttempts).toBe(2)
    expect(outboxRows[0].lastError).toBeNull()
  })

  test('a fresh email claim is not stolen by another dispatcher', async () => {
    const { client, outboxRows } = fakeOutboxWorld()
    await enqueueOutbox(client, { key: 'k-email-fresh-claim', kind: 'SEMESTER_CLOSED', recipientUserId: 'u1', title: 't', body: 'b' })
    outboxRows[0].status = 'SENT'
    outboxRows[0].emailStatus = 'SENDING'
    outboxRows[0].emailAttempts = 1
    outboxRows[0].lastError = `EMAIL_CLAIM:${new Date().toISOString()}`
    emailBehavior = 'SENT'
    emailSendCount = 0
    const result = await dispatchOutboxBatch(client)
    expect(emailSendCount).toBe(0)
    expect(result.emailsSent).toBe(0)
    expect(outboxRows[0].emailStatus).toBe('SENDING')
    expect(outboxRows[0].emailAttempts).toBe(1)
  })

  test('an email at the attempts cap is never claimed again', async () => {
    const { client, outboxRows } = fakeOutboxWorld()
    await enqueueOutbox(client, { key: 'k-email-cap', kind: 'SEMESTER_CLOSED', recipientUserId: 'u1', title: 't', body: 'b' })
    outboxRows[0].status = 'SENT'
    outboxRows[0].emailStatus = 'FAILED'
    outboxRows[0].emailAttempts = 5
    emailBehavior = 'SENT'
    emailSendCount = 0
    await dispatchOutboxBatch(client)
    expect(emailSendCount).toBe(0)
    expect(outboxRows[0].emailStatus).toBe('FAILED')
    expect(outboxRows[0].emailAttempts).toBe(5)
  })

  test('admins-role event fans out to admins exactly once', async () => {
    const { client, notifications } = fakeOutboxWorld()
    await enqueueOutbox(client, { key: 'k-admins', kind: 'SEMESTER_FAILED', recipientRole: 'ADMINS', title: 't', body: 'b' })
    await dispatchOutboxBatch(client)
    await dispatchOutboxBatch(client)
    expect(notifications.filter((n) => n.userId === 'admin1').length).toBe(1)
  })
})

describe('deadline warnings scan', () => {
  function fakeScanWorld(semesterEndInDays: number) {
    const world = fakeOutboxWorld()
    const createdAt = new Date()
    const client: any = {
      ...world.client,
      enrollmentSemesterState: {
        findMany: async () => [{ enrollmentId: 'e1', semester: 1, submissionDeadline: new Date(Date.now() + semesterEndInDays * 86400000) }],
      },
      enrollment: {
        findUnique: async () => ({ id: 'e1', userId: 'u1', programId: 'p1', createdAt, extensionDays: 0 }),
      },
      program: { findUnique: async () => ({ category: 'DIPLOMA', maxStudyDays: 90, semestersCount: 2 }) },
      unit: { findMany: async () => [] },
    }
    return { client, world }
  }

  test('deadline in 36h → one warning, deduped on rescan', async () => {
    const { client, world } = fakeScanWorld(1.5)
    const first = await scanDeadlineWarnings(client)
    expect(first.warned).toBe(1)
    await scanDeadlineWarnings(client)
    expect(world.outboxRows.filter((r) => r.kind === 'DEADLINE_WARNING').length).toBe(1)
  })

  test('deadline in 5 days → no warning yet', async () => {
    const { client, world } = fakeScanWorld(5)
    const res = await scanDeadlineWarnings(client)
    expect(res.warned).toBe(0)
    expect(world.outboxRows.length).toBe(0)
  })
})

describe('stitched journey: approval drives progression', () => {
  test('failed approved S1 opens S2; later mercy reapproval improves the recorded result', async () => {
    // عالم مبسّط: امتحان وحدة واحد لكل فصل درجته هي المعدل.
    const approvals: Record<number, number> = { 1: 40 }
    const scores: Record<number, number> = { 1: 40 }
    const snapshotRow = {
      id: 's', enrollmentId: 'e1', weightsJson: JSON.stringify({ quizzes: 20, assignments: 20, final_exam: 60 }),
      weightSource: 'category_default', weightWarning: null, passThreshold: 50, thresholdStrict: true,
      requirementsJson: JSON.stringify({ semestersCount: 2, requiredComponents: ['final_exam'] }),
      basis: 'ENROLLMENT', capturedAt: new Date(),
    }
    const client: any = {
      program: { findUnique: async () => ({ category: 'DIPLOMA', admissionRules: null, semestersCount: 2 }) },
      enrollment: { findUnique: async () => ({ id: 'e1', userId: 'u1', programId: 'p1', createdAt: new Date(), status: 'ACTIVE', finalScore: null }) },
      enrollmentRulesSnapshot: { findUnique: async () => snapshotRow, create: async () => snapshotRow },
      enrollmentSemesterState: {
        count: async () => 1,
        findUnique: async () => ({ enrollmentId: 'e1', semester: 1, status: 'CLOSED' }),
      },
      semesterResultApproval: {
        count: async () => Object.keys(approvals).length,
        findUnique: async ({ where }: any) => {
          const s = where.enrollmentId_semester.semester
          return s in approvals ? { enrollmentId: 'e1', semester: s, status: 'APPROVED', score: approvals[s] } : null
        },
      },
      exam: {
        findMany: async ({ where }: any) => {
          const semester = where?.unit?.semester
          return [1, 2].filter((s) => semester === undefined || s === semester)
            .map((s) => ({ id: `ue${s}`, title: 'و', passScore: 60, unit: { title: 'و' }, _count: { questions: 5 } }))
        },
      },
      examAttempt: {
        findMany: async ({ where }: any) => {
          const s = Number(String(where?.examId).replace('ue', ''))
          return scores[s] === undefined ? [] : [{ score: scores[s], passed: scores[s] >= 60, answers: [] }]
        },
      },
      programExam: {
        findMany: async ({ where }: any) => {
          const semester = where?.semester
          return [1, 2].filter((s) => semester === undefined || s === semester)
            .map((s) => ({ id: `pe${s}`, title: 'امتحان', semester: s, passScore: 50, status: 'READY', createdAt: new Date(), questions: [{ points: 10 }] }))
        },
      },
      programExamAttempt: {
        findMany: async ({ where }: any) => {
          const s = Number(String(where?.examId).replace('pe', ''))
          if (scores[s] === undefined) return []
          const passed = scores[s] >= 50
          if (where?.passed === true && !passed) return []
          return [{ id: `pa${s}`, score: scores[s], finalScore: null, passed, appealStatus: null, answers: [{ points: scores[s], maxPoints: 100 }] }]
        },
      },
      programAssignment: { findMany: async () => [] },
      assignmentSubmission: { findUnique: async () => null },
      thesisSubmission: { findFirst: async () => null },
    }
    const enrollment = { id: 'e1', userId: 'u1', programId: 'p1' }
    const locked = await progressionGate(client, enrollment, 2, 'DIPLOMA')
    expect(locked.open).toBe(false)
    // نشاط الاسترحام قُيّم 80 بوزن 50% (يثبته اختبار مسار الاسترحام):
    // المعدل الجديد 56.67 يُعاد حسابه من المحرك فيصبح هو المعتمد.
    scores[1] = 56.67
    approvals[1] = 56.67
    const open = await progressionGate(client, enrollment, 2, 'DIPLOMA')
    expect(open.open).toBe(true)
  })
})
