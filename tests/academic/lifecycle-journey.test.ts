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
mock.module('@/lib/db', () => ({ db: {} }))
mock.module('@/lib/mailer', () => ({
  sendEmailDetailed: async () => emailBehavior,
  emailTemplate: (title: string, body: string) => `<p>${title}</p><p>${body}</p>`,
}))
mock.module('@/lib/prod-safety', () => ({ isAactTestEmail: () => false }))

const { enqueueOutbox, dispatchOutboxBatch } = await import('@/lib/outbox')
const { scanDeadlineWarnings } = await import('@/lib/lifecycle-scans')
const { progressionGate } = await import('@/lib/progression')

function fakeOutboxWorld() {
  const outboxRows: any[] = []
  const notifications: any[] = []
  let seq = 0
  const client: any = {
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
        let rows = [...outboxRows]
        if (where?.status) rows = rows.filter((r) => r.status === where.status)
        if (where?.emailStatus?.in) rows = rows.filter((r) => where.emailStatus.in.includes(r.emailStatus))
        if (where?.emailAttempts?.lt !== undefined) rows = rows.filter((r) => r.emailAttempts < where.emailAttempts.lt)
        return rows.slice(0, take ?? rows.length)
      },
      update: async ({ where, data }: any) => {
        const row = outboxRows.find((r) => r.id === where.id)
        if (!row) return null
        for (const [k, v] of Object.entries(data)) {
          if (v && typeof v === 'object' && 'increment' in (v as any)) row[k] += (v as any).increment
          else row[k] = v
        }
        return row
      },
      updateMany: async ({ where, data }: any) => {
        const row = outboxRows.find((r) => r.id === where.id && r.status === where.status)
        if (!row) return { count: 0 }
        Object.assign(row, data)
        return { count: 1 }
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
  return { client, outboxRows, notifications }
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
  test('failed approved S1 locks S2; re-approved pass opens it', async () => {
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
