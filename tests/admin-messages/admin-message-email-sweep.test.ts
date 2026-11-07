/// <reference types="bun-types" />
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { NextRequest } from 'next/server'

process.env.CRON_SECRET = 'test-cron-secret'

// ===== حالة الاختبار القابلة للتبديل =====
const oldDate = new Date(Date.now() - 2 * 60 * 60 * 1000)
const freshDate = new Date(Date.now() - 10 * 60 * 1000)
let messages: any[]
let digestBehavior: 'success' | 'fail' | 'hold' = 'success'
let releaseHeldSend: (() => void) | null = null
const emailCalls: any[] = []
const updateManyCalls: any[] = []
const unreadLinks = new Set<string>()

function resetMessages() {
  messages = [
    { id: 'm-old-unread', admissionId: 'adm-1', studentId: 'student-1', scope: 'ADMIN', senderRole: 'ADMIN', emailSentAt: null, emailClaimId: null, emailClaimLeaseUntil: null, content: 'رسالة إدارة قديمة غير مقروءة', createdAt: oldDate },
    { id: 'm-fresh', admissionId: 'adm-1', studentId: 'student-1', scope: 'ADMIN', senderRole: 'ADMIN', emailSentAt: null, emailClaimId: null, emailClaimLeaseUntil: null, content: 'رسالة حديثة', createdAt: freshDate },
    { id: 'm-old-read', admissionId: 'adm-2', studentId: 'student-2', scope: 'ADMIN', senderRole: 'ADMIN', emailSentAt: null, emailClaimId: null, emailClaimLeaseUntil: null, content: 'رسالة قديمة لكن مقروءة', createdAt: oldDate },
    { id: 'm-old-emailed', admissionId: 'adm-1', studentId: 'student-1', scope: 'ADMIN', senderRole: 'ADMIN', emailSentAt: new Date(), emailClaimId: null, emailClaimLeaseUntil: null, content: 'رسالة أُرسلت من قبل', createdAt: oldDate },
  ]
  unreadLinks.clear()
  unreadLinks.add('admin-messages:adm-1')
}

// مطابقة where عامة مصغّرة (مساواة/null/تاريخ/in/lt/gt/OR/AND) —
// E02: شروط القابلية للمطالبة مركّبة (ترميز قديم + حقول جديدة).
function matchesWhere(row: any, where: any): boolean {
  for (const [key, cond] of Object.entries(where || {})) {
    if (key === 'OR') { if (!(cond as any[]).some((w) => matchesWhere(row, w))) return false; continue }
    if (key === 'AND') { if (!(cond as any[]).every((w) => matchesWhere(row, w))) return false; continue }
    const actual = row[key]
    if (cond instanceof Date) { if (!(actual instanceof Date) || actual.getTime() !== cond.getTime()) return false; continue }
    if (cond === null) { if (actual !== null && actual !== undefined) return false; continue }
    if (cond && typeof cond === 'object') {
      // كل العوامل الحاضرة تُقيَّم اقترانيًا (نافذة gt+lt معًا شرط واحد).
      if ('in' in (cond as any) && !(cond as any).in.includes(actual)) return false
      if ('lt' in (cond as any) && !(actual < (cond as any).lt)) return false
      if ('gt' in (cond as any) && !(actual > (cond as any).gt)) return false
      continue
    }
    if (actual !== cond) return false
  }
  return true
}

const db: any = {
  supervisorChannelMessage: {
    findMany: async (args: any) => {
      const w = args?.where || {}
      return messages.filter((m) => matchesWhere(m, w))
    },
    updateMany: async (args: any) => {
      updateManyCalls.push(args)
      const w = args?.where || {}
      let count = 0
      for (const m of messages) {
        if (!matchesWhere(m, w)) continue
        Object.assign(m, args.data)
        count++
      }
      return { count }
    },
  },
  notification: {
    findFirst: async (args: any) => (unreadLinks.has(args?.where?.link) && args?.where?.read === false ? { id: 'n-1' } : null),
  },
  user: {
    findUnique: async (args: any) => ({ id: args?.where?.id, email: `${args?.where?.id}@example.com`, name: 'طالب' }),
  },
}

mock.module('@/lib/db', () => ({ db }))
mock.module('@/lib/notify', () => ({
  notify: async () => {},
  notifyAdmins: async () => {},
  audit: async () => {},
}))
mock.module('@/lib/mailer', () => ({
  emailAdminMessagesDigest: async (...args: any[]) => {
    emailCalls.push(args)
    if (digestBehavior === 'fail') return false
    if (digestBehavior === 'hold') {
      await new Promise<void>((resolve) => { releaseHeldSend = resolve })
    }
    return true
  },
}))

function cronRequest() {
  return new NextRequest('http://localhost/api/cron/admin-message-digest', {
    method: 'GET',
    headers: { authorization: 'Bearer test-cron-secret' },
  })
}

beforeEach(() => {
  resetMessages()
  digestBehavior = 'success'
  releaseHeldSend = null
  emailCalls.length = 0
  updateManyCalls.length = 0
})

describe('admin message digest sweep', () => {
  test('rejects requests without the cron secret', async () => {
    const route = await import('@/app/api/cron/admin-message-digest/route')
    const res = await route.GET(new NextRequest('http://localhost/api/cron/admin-message-digest', { method: 'GET' }))
    expect(res.status).toBe(401)
  })

  test('old unread admin message is emailed exactly once; second run does not resend', async () => {
    const route = await import('@/app/api/cron/admin-message-digest/route')
    const res = await route.GET(cronRequest())
    expect(res.status).toBe(200)
    expect(emailCalls.length).toBe(1)
    expect(emailCalls[0][0]).toBe('student-1@example.com')
    expect(emailCalls[0][2].map((m: any) => m.id)).toEqual(['m-old-unread'])
    expect(updateManyCalls[0].where.id.in).toEqual(['m-old-unread'])
    const res2 = await route.GET(cronRequest())
    expect(res2.status).toBe(200)
    expect(emailCalls.length).toBe(1)
  })

  test('fresh messages and read messages are not emailed', async () => {
    const route = await import('@/app/api/cron/admin-message-digest/route')
    await route.GET(cronRequest())
    const emailedIds = emailCalls.flatMap((c: any) => c[2].map((m: any) => m.id))
    expect(emailedIds).not.toContain('m-fresh')
    expect(emailedIds).not.toContain('m-old-read')
    expect(emailedIds).not.toContain('m-old-emailed')
  })

  test('a crashed worker digest claim older than ten minutes is retried and finalized with real send time', async () => {
    const route = await import('@/app/api/cron/admin-message-digest/route')
    const claimOffset = 100 * 365 * 24 * 60 * 60 * 1000
    messages[0].emailSentAt = new Date(Date.now() + claimOffset - 11 * 60 * 1000)
    await route.GET(cronRequest())
    expect(emailCalls).toHaveLength(1)
    expect(messages[0].emailSentAt.getTime()).toBeLessThan(Date.now() + 60_000)
    expect(messages[0].emailSentAt.getTime()).toBeGreaterThan(Date.now() - 60_000)
  })

  test('a fresh unfinished digest claim is not stolen by overlapping cron', async () => {
    const route = await import('@/app/api/cron/admin-message-digest/route')
    const claimOffset = 100 * 365 * 24 * 60 * 60 * 1000
    messages[0].emailSentAt = new Date(Date.now() + claimOffset - 3 * 60 * 1000)
    await route.GET(cronRequest())
    expect(emailCalls).toHaveLength(0)
  })

  test('a failed send releases the claim — the next run retries and succeeds', async () => {
    const route = await import('@/app/api/cron/admin-message-digest/route')
    digestBehavior = 'fail'
    const res1 = await route.GET(cronRequest())
    expect(res1.status).toBe(200)
    expect(emailCalls.length).toBe(1)
    const old = messages.find((m) => m.id === 'm-old-unread')
    expect(old.emailSentAt).toBeNull()
    // E02: التحرير يمسح حقول المطالبة لا يحرّك emailSentAt أبدًا.
    expect(old.emailClaimId).toBeNull()
    expect(old.emailClaimLeaseUntil).toBeNull()
    digestBehavior = 'success'
    const res2 = await route.GET(cronRequest())
    expect(res2.status).toBe(200)
    expect(emailCalls.length).toBe(2)
    expect(old.emailSentAt).toBeInstanceOf(Date)
    expect(old.emailClaimId).toBeNull()
  })

  test('E02 claim fields: a live lease blocks the sweep; an expired lease is reclaimed and finalized', async () => {
    const route = await import('@/app/api/cron/admin-message-digest/route')
    const target = messages.find((m) => m.id === 'm-old-unread')
    target.emailClaimId = 'digest_other_worker'
    target.emailClaimLeaseUntil = new Date(Date.now() + 5 * 60 * 1000)
    await route.GET(cronRequest())
    expect(emailCalls).toHaveLength(0)
    target.emailClaimLeaseUntil = new Date(Date.now() - 60 * 1000)
    await route.GET(cronRequest())
    expect(emailCalls).toHaveLength(1)
    expect(target.emailSentAt).toBeInstanceOf(Date)
    expect(target.emailClaimId).toBeNull()
    expect(target.emailClaimLeaseUntil).toBeNull()
  })

  test('an overlapping run during an in-flight send does not double-send', async () => {
    const route = await import('@/app/api/cron/admin-message-digest/route')
    digestBehavior = 'hold'
    const first = route.GET(cronRequest())
    // انتظر حتى تُسجَّل المطالبة ويبدأ الإرسال المُعلَّق
    for (let i = 0; i < 50 && !(updateManyCalls.length >= 1 && emailCalls.length >= 1); i++) {
      await new Promise((r) => setTimeout(r, 0))
    }
    expect(updateManyCalls.length).toBeGreaterThanOrEqual(1)
    expect(emailCalls.length).toBe(1)
    const second = await route.GET(cronRequest())
    expect(second.status).toBe(200)
    expect(emailCalls.length).toBe(1)
    releaseHeldSend?.()
    const firstRes = await first
    expect(firstRes.status).toBe(200)
    expect(emailCalls.length).toBe(1)
    const body = await firstRes.json()
    expect(body.emailedMessages).toBe(1)
  })
})
