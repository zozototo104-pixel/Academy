/// <reference types="bun-types" />
// E02/E03 — سجل بريد الصادر لكل مستلم وحقول المطالبة المستقلة:
// - عاملان متزامنان: مطالبة واحدة وكل مستلم يُرسل مرة واحدة.
// - موت عامل بعد مستلمين مؤكدين: لا إعادة لهما أبدًا، والباقي يُرسل.
// - مستلم كان قيد الإرسال حين ماتت المطالبة: UNKNOWN ولا يُعاد تلقائيًا.
// - تبنّي صفوف الترميز القديم (ختم lastError + EMAIL_SENT_IDS) بزرع
//   سجلها من نقطة الحفظ القديمة ثم إدارة جديدة كليًا.
// التشغيل: bun test tests/notifications/outbox-email-ledger.test.ts (منفردًا)
import { describe, expect, mock, test } from 'bun:test'

const sentTo: string[] = []
const failFor = new Set<string>()
mock.module('@/lib/db', () => ({ db: {} }))
mock.module('@/lib/mailer', () => ({
  sendEmailDetailed: async ({ to }: { to: string }) => {
    sentTo.push(to)
    return failFor.has(to) ? 'FAILED' : 'SENT'
  },
  emailTemplate: (title: string, body: string) => `<p>${title}</p><p>${body}</p>`,
}))
mock.module('@/lib/prod-safety', () => ({ isAactTestEmail: () => false }))

const { enqueueOutbox, dispatchOutboxBatch } = await import('@/lib/outbox')

function matchesWhere(row: any, where: any): boolean {
  for (const [key, cond] of Object.entries(where || {})) {
    if (key === 'OR') { if (!(cond as any[]).some((w) => matchesWhere(row, w))) return false; continue }
    if (key === 'AND') { if (!(cond as any[]).every((w) => matchesWhere(row, w))) return false; continue }
    const actual = row[key]
    if (cond instanceof Date) { if (!(actual instanceof Date) || actual.getTime() !== cond.getTime()) return false; continue }
    if (cond === null) { if (actual !== null && actual !== undefined) return false; continue }
    if (cond && typeof cond === 'object') {
      if ('in' in (cond as any) && !(cond as any).in.includes(actual)) return false
      if ('lt' in (cond as any) && !(actual < (cond as any).lt)) return false
      if ('gt' in (cond as any) && !(actual > (cond as any).gt)) return false
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

const ADMINS = [
  { id: 'admin1', email: 'admin1@example.com', name: 'الأول' },
  { id: 'admin2', email: 'admin2@example.com', name: 'الثاني' },
  { id: 'admin3', email: 'admin3@example.com', name: 'الثالث' },
]

function fakeWorld() {
  const outboxRows: any[] = []
  const recipientRows: any[] = []
  let seq = 0
  const client: any = {
    notificationOutbox: {
      create: async ({ data }: any) => {
        if (outboxRows.some((r) => r.idempotencyKey === data.idempotencyKey)) {
          const e: any = new Error('Unique constraint failed')
          e.code = 'P2002'
          throw e
        }
        const row = { id: `ob${++seq}`, status: 'PENDING', emailStatus: 'PENDING', emailAttempts: 0, emailClaimId: null, emailClaimLeaseUntil: null, lastError: null, createdAt: new Date(), ...data }
        outboxRows.push(row)
        return row
      },
      findUnique: async ({ where }: any) => outboxRows.find((r) => r.idempotencyKey === where.idempotencyKey) ?? null,
      findMany: async ({ where, take }: any) => {
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
    notificationOutboxRecipient: {
      createMany: async ({ data, skipDuplicates }: any) => {
        let count = 0
        for (const d of data) {
          if (skipDuplicates && recipientRows.some((r) => r.outboxId === d.outboxId && r.recipientUserId === d.recipientUserId)) continue
          recipientRows.push({ id: `rcp${recipientRows.length + 1}`, status: 'PENDING', attempts: 0, lastError: null, sentAt: null, createdAt: new Date(), ...d })
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
    user: {
      findUnique: async ({ where }: any) => ({ id: where.id, email: `${where.id}@example.com`, name: 'طالب' }),
      findMany: async () => ADMINS,
    },
    notification: { createMany: async ({ data }: any) => ({ count: data.length }) },
    $transaction: async (fn: any) => fn(client),
  }
  return { client, outboxRows, recipientRows }
}

async function enqueueAdminsEvent(client: any, key: string) {
  await enqueueOutbox(client, { key, kind: 'SEMESTER_FAILED', recipientRole: 'ADMINS', title: 't', body: 'b' })
}

describe('E02/E03 outbox email ledger', () => {
  test('two concurrent dispatchers: one claim, every admin emailed exactly once, ledger complete', async () => {
    const { client, outboxRows, recipientRows } = fakeWorld()
    await enqueueAdminsEvent(client, 'e02-race')
    sentTo.length = 0
    const [a, b] = await Promise.all([dispatchOutboxBatch(client), dispatchOutboxBatch(client)])
    expect(a.emailsSent + b.emailsSent).toBe(1)
    expect(sentTo.sort()).toEqual(['admin1@example.com', 'admin2@example.com', 'admin3@example.com'])
    expect(outboxRows[0].emailStatus).toBe('SENT')
    expect(outboxRows[0].emailClaimId).toBeNull()
    expect(recipientRows).toHaveLength(3)
    expect(recipientRows.every((r) => r.status === 'SENT' && r.sentAt instanceof Date && r.attempts === 1)).toBe(true)
  })

  test('crash after two confirmed recipients: redispatch sends only the third', async () => {
    const { client, outboxRows, recipientRows } = fakeWorld()
    await enqueueAdminsEvent(client, 'e02-crash')
    // حالة ما بعد الموت مباشرة: المنصة سُلّمت، والبريد بمطالبة ميتة،
    // ومستلمان مؤكدان في السجل وثالث لم يبدأ.
    const row = outboxRows[0]
    row.status = 'SENT'
    row.emailStatus = 'SENDING'
    row.emailAttempts = 1
    row.emailClaimId = 'claim_dead_worker'
    row.emailClaimLeaseUntil = new Date(Date.now() - 60 * 1000)
    for (const [i, admin] of ADMINS.entries()) {
      recipientRows.push({
        id: `rcp-seed-${i}`, outboxId: row.id, recipientUserId: admin.id, email: admin.email,
        status: i < 2 ? 'SENT' : 'PENDING', attempts: i < 2 ? 1 : 0, lastError: null,
        sentAt: i < 2 ? new Date() : null, createdAt: new Date(),
      })
    }
    sentTo.length = 0
    const res = await dispatchOutboxBatch(client)
    expect(res.emailsSent).toBe(1)
    expect(sentTo).toEqual(['admin3@example.com'])
    expect(row.emailStatus).toBe('SENT')
    expect(recipientRows.every((r) => r.status === 'SENT')).toBe(true)
  })

  test('recipient PROCESSING when its claim died becomes UNKNOWN and is never resent', async () => {
    const { client, outboxRows, recipientRows } = fakeWorld()
    await enqueueAdminsEvent(client, 'e02-unknown')
    const row = outboxRows[0]
    row.status = 'SENT'
    row.emailStatus = 'SENDING'
    row.emailAttempts = 1
    row.emailClaimId = 'claim_dead_worker'
    row.emailClaimLeaseUntil = new Date(Date.now() - 60 * 1000)
    const states = ['SENT', 'PROCESSING', 'PENDING']
    for (const [i, admin] of ADMINS.entries()) {
      recipientRows.push({
        id: `rcp-seed-${i}`, outboxId: row.id, recipientUserId: admin.id, email: admin.email,
        status: states[i], attempts: 1, lastError: null, sentAt: i === 0 ? new Date() : null, createdAt: new Date(),
      })
    }
    sentTo.length = 0
    const res = await dispatchOutboxBatch(client)
    // الثالث (PENDING) أُرسل؛ الثاني (PROCESSING عند الموت) لم يُلمس.
    expect(sentTo).toEqual(['admin3@example.com'])
    expect(recipientRows.find((r) => r.recipientUserId === 'admin2')?.status).toBe('UNKNOWN')
    expect(res.emailsSent).toBe(1)
    expect(row.emailStatus).toBe('SENT')
    // وحتى توزيعة لاحقة لا تبعثه من جديد أبدًا.
    await dispatchOutboxBatch(client)
    expect(sentTo).toEqual(['admin3@example.com'])
    expect(recipientRows.find((r) => r.recipientUserId === 'admin2')?.status).toBe('UNKNOWN')
  })

  test('legacy marker row is adopted: seeded from EMAIL_SENT_IDS, only the unsent admin is emailed', async () => {
    const { client, outboxRows, recipientRows } = fakeWorld()
    await enqueueAdminsEvent(client, 'e02-legacy')
    const row = outboxRows[0]
    row.status = 'SENT'
    row.emailStatus = 'SENDING'
    row.emailAttempts = 1
    row.emailClaimId = null
    row.emailClaimLeaseUntil = null
    row.lastError = `EMAIL_CLAIM:${new Date(Date.now() - 11 * 60 * 1000).toISOString()}\nEMAIL_SENT_IDS:${JSON.stringify(['admin1', 'admin2'])}`
    sentTo.length = 0
    const res = await dispatchOutboxBatch(client)
    expect(res.emailsSent).toBe(1)
    expect(sentTo).toEqual(['admin3@example.com'])
    expect(recipientRows.find((r) => r.recipientUserId === 'admin1')?.status).toBe('SENT')
    expect(recipientRows.find((r) => r.recipientUserId === 'admin1')?.lastError).toBe('LEGACY_CHECKPOINT')
    expect(recipientRows.find((r) => r.recipientUserId === 'admin3')?.status).toBe('SENT')
    expect(row.emailStatus).toBe('SENT')
    expect(row.lastError).toBeNull()
  })

  test('a live claim in the new fields is never stolen; a FAILED recipient retries alone next claim', async () => {
    const { client, outboxRows, recipientRows } = fakeWorld()
    await enqueueAdminsEvent(client, 'e02-live-claim')
    const row = outboxRows[0]
    row.status = 'SENT'
    row.emailStatus = 'SENDING'
    row.emailClaimId = 'claim_live_worker'
    row.emailClaimLeaseUntil = new Date(Date.now() + 5 * 60 * 1000)
    sentTo.length = 0
    const blocked = await dispatchOutboxBatch(client)
    expect(blocked.emailsSent).toBe(0)
    expect(sentTo).toHaveLength(0)
    expect(row.emailAttempts).toBe(0)
    // المطالبة ماتت وصاحبها كان قد فشل عند الثاني: إعادة للمفشل وحده.
    row.emailClaimLeaseUntil = new Date(Date.now() - 1000)
    for (const [i, admin] of ADMINS.entries()) {
      recipientRows.push({
        id: `rcp-seed-${i}`, outboxId: row.id, recipientUserId: admin.id, email: admin.email,
        status: i === 1 ? 'FAILED' : 'SENT', attempts: 1, lastError: i === 1 ? 'smtp rejected' : null,
        sentAt: i === 1 ? null : new Date(), createdAt: new Date(),
      })
    }
    const res = await dispatchOutboxBatch(client)
    expect(res.emailsSent).toBe(1)
    expect(sentTo).toEqual(['admin2@example.com'])
    expect(recipientRows.find((r) => r.recipientUserId === 'admin2')?.status).toBe('SENT')
    expect(recipientRows.find((r) => r.recipientUserId === 'admin2')?.attempts).toBe(2)
    expect(row.emailStatus).toBe('SENT')
  })

  test('mailer failure marks only that recipient FAILED and the event FAILED with a plain error', async () => {
    const { client, outboxRows, recipientRows } = fakeWorld()
    await enqueueAdminsEvent(client, 'e02-fail-one')
    failFor.add('admin2@example.com')
    sentTo.length = 0
    try {
      const res = await dispatchOutboxBatch(client)
      expect(res.emailsFailed).toBe(1)
      expect(row0(recipientRows, 'admin1')).toBe('SENT')
      expect(row0(recipientRows, 'admin2')).toBe('FAILED')
      expect(row0(recipientRows, 'admin3')).toBe('SENT')
      expect(outboxRows[0].emailStatus).toBe('FAILED')
      expect(outboxRows[0].lastError).not.toContain('EMAIL_SENT_IDS')
      expect(outboxRows[0].emailClaimId).toBeNull()
    } finally {
      failFor.clear()
    }
    function row0(rows: any[], userId: string) {
      return rows.find((r) => r.recipientUserId === userId)?.status
    }
  })
})
