/// <reference types="bun-types" />
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { NextRequest } from 'next/server'

process.env.CRON_SECRET = 'test-cron-secret'

// ===== حالة الاختبار القابلة للتبديل =====
const oldDate = new Date(Date.now() - 2 * 60 * 60 * 1000)
const freshDate = new Date(Date.now() - 10 * 60 * 1000)
let messages: any[]
const emailCalls: any[] = []
const updateManyCalls: any[] = []
const unreadLinks = new Set<string>()

function resetMessages() {
  messages = [
    { id: 'm-old-unread', admissionId: 'adm-1', studentId: 'student-1', scope: 'ADMIN', senderRole: 'ADMIN', emailSentAt: null, content: 'رسالة إدارة قديمة غير مقروءة', createdAt: oldDate },
    { id: 'm-fresh', admissionId: 'adm-1', studentId: 'student-1', scope: 'ADMIN', senderRole: 'ADMIN', emailSentAt: null, content: 'رسالة حديثة', createdAt: freshDate },
    { id: 'm-old-read', admissionId: 'adm-2', studentId: 'student-2', scope: 'ADMIN', senderRole: 'ADMIN', emailSentAt: null, content: 'رسالة قديمة لكن مقروءة', createdAt: oldDate },
    { id: 'm-old-emailed', admissionId: 'adm-1', studentId: 'student-1', scope: 'ADMIN', senderRole: 'ADMIN', emailSentAt: new Date(), content: 'رسالة أُرسلت من قبل', createdAt: oldDate },
  ]
  unreadLinks.clear()
  unreadLinks.add('admin-messages:adm-1')
}

const db: any = {
  supervisorChannelMessage: {
    findMany: async (args: any) => {
      const w = args?.where || {}
      return messages.filter((m) =>
        (!w.scope || m.scope === w.scope) &&
        (!w.senderRole || m.senderRole === w.senderRole) &&
        (w.emailSentAt !== null || m.emailSentAt === null) &&
        (!w.createdAt?.lt || m.createdAt < w.createdAt.lt)
      )
    },
    updateMany: async (args: any) => {
      updateManyCalls.push(args)
      for (const m of messages) {
        if (args?.where?.id?.in?.includes(m.id)) m.emailSentAt = args.data.emailSentAt
      }
      return { count: args?.where?.id?.in?.length || 0 }
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
})
