/// <reference types="bun-types" />
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { NextRequest } from 'next/server'

// ===== حالة الاختبار القابلة للتبديل =====
let currentUser: any = { id: 'admin-1', role: 'ADMIN', name: 'الإدارة' }
let appUserId: string | null = 'student-1'
let aiBehavior: 'ok' | 'fail' = 'ok'
let aiCalls = 0
const createdMessages: any[] = []
const notifyCalls: any[] = []
const notifyAdminCalls: any[] = []
const findManyWhere: any[] = []
const updateManyCalls: any[] = []

const seedMessages: any[] = [
  { id: 'seed-sup-1', admissionId: 'adm-1', scope: 'SUPERVISION', audience: 'ALL', senderRole: 'STUDENT', content: 'سؤال إشراف' },
  { id: 'seed-sup-2', admissionId: 'adm-1', scope: 'SUPERVISION', audience: 'HUMAN', senderRole: 'SUPERVISOR', content: 'رد المشرف البشري' },
  { id: 'seed-admin-1', admissionId: 'adm-1', scope: 'ADMIN', audience: 'ALL', senderRole: 'ADMIN', content: 'رسالة إدارة' },
]

const db: any = {
  admissionApplication: {
    findUnique: async () => ({ id: 'adm-1', userId: appUserId, supervisorId: 'sup-1', fullName: 'طالب تجريبي', email: 'student@example.com' }),
  },
  supervisorChannelMessage: {
    findMany: async (args: any) => {
      findManyWhere.push(args?.where)
      return seedMessages.filter((m) => (!args?.where?.admissionId || m.admissionId === args.where.admissionId) && (!args?.where?.scope || m.scope === args.where.scope))
    },
    findFirst: async (args: any) => {
      const list = seedMessages.filter((m) => (!args?.where?.admissionId || m.admissionId === args.where.admissionId) && (!args?.where?.scope || m.scope === args.where.scope))
      return list[list.length - 1] || null
    },
    create: async (args: any) => {
      const row = { id: `m-${createdMessages.length + 1}`, createdAt: new Date(), ...args.data }
      createdMessages.push(row)
      return row
    },
  },
  notification: {
    updateMany: async (args: any) => {
      updateManyCalls.push(args)
      return { count: 1 }
    },
  },
}

mock.module('@/lib/db', () => ({ db }))
mock.module('@/lib/auth', () => ({
  requireUser: async () => currentUser,
  requireAdmin: async () => {
    if (currentUser?.role !== 'ADMIN') throw new Error('UNAUTHORIZED')
    return currentUser
  },
}))
mock.module('@/lib/notify', () => ({
  notify: async (...args: any[]) => {
    notifyCalls.push(args)
  },
  notifyAdmins: async (...args: any[]) => {
    notifyAdminCalls.push(args)
  },
  audit: async () => {},
}))
mock.module('@/lib/supervisor-thread-ai', () => ({
  generateSupervisorThreadReply: async () => {
    aiCalls += 1
    if (aiBehavior === 'fail') throw new Error('AI down')
    return 'رد فوري من المشرف الذكي داخل المحادثة.'
  },
}))

function postRequest(body: any) {
  return new NextRequest('http://localhost/api/supervisor/messages', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

function getRequest(scope?: string) {
  const url = scope ? `http://localhost/api/supervisor/messages?admissionId=adm-1&scope=${scope}` : 'http://localhost/api/supervisor/messages?admissionId=adm-1'
  return new NextRequest(url, { method: 'GET' })
}

const flush = () => new Promise((r) => setTimeout(r, 30))

beforeEach(() => {
  currentUser = { id: 'admin-1', role: 'ADMIN', name: 'الإدارة' }
  appUserId = 'student-1'
  aiBehavior = 'ok'
  aiCalls = 0
  createdMessages.length = 0
  notifyCalls.length = 0
  notifyAdminCalls.length = 0
  findManyWhere.length = 0
  updateManyCalls.length = 0
})

describe('admin messaging — scope, roles, audience, in-thread AI reply', () => {
  test('admin send creates scope ADMIN + ADMIN_MESSAGE notification, absent from supervision query', async () => {
    const route = await import('@/app/api/supervisor/messages/route')
    const res = await route.POST(postRequest({ admissionId: 'adm-1', content: 'راجع مستنداتك', scope: 'ADMIN' }))
    expect(res.status).toBe(200)
    const created = createdMessages[0]
    expect(created.scope).toBe('ADMIN')
    expect(created.audience).toBe('ALL')
    expect(notifyCalls[0][1]).toBe('ADMIN_MESSAGE')
    expect(notifyCalls[0][4]).toBe('admin-messages:adm-1')
    currentUser = { id: 'student-1', role: 'STUDENT', email: 'student@example.com' }
    const get = await route.GET(getRequest())
    const body = await get.json()
    expect(body.messages.map((m: any) => m.id)).not.toContain(created.id)
    expect(body.messages.every((m: any) => m.scope === 'SUPERVISION')).toBe(true)
  })

  test('supervision GET defaults to scope SUPERVISION', async () => {
    const route = await import('@/app/api/supervisor/messages/route')
    currentUser = { id: 'student-1', role: 'STUDENT', email: 'student@example.com' }
    const res = await route.GET(getRequest())
    expect(res.status).toBe(200)
    expect(findManyWhere[0].scope).toBe('SUPERVISION')
  })

  test('admin reading a supervision thread is forbidden', async () => {
    const route = await import('@/app/api/supervisor/messages/route')
    const res = await route.GET(getRequest('SUPERVISION'))
    expect(res.status).toBe(403)
  })

  test('ADMIN sending scope SUPERVISION → 403 and nothing created', async () => {
    const route = await import('@/app/api/supervisor/messages/route')
    const res = await route.POST(postRequest({ admissionId: 'adm-1', content: 'محاولة دخول إشراف', scope: 'SUPERVISION' }))
    expect(res.status).toBe(403)
    expect(createdMessages.length).toBe(0)
  })

  test('SUPERVISOR sending scope ADMIN → 403 and nothing created', async () => {
    const route = await import('@/app/api/supervisor/messages/route')
    currentUser = { id: 'sup-1', role: 'SUPERVISOR' }
    const res = await route.POST(postRequest({ admissionId: 'adm-1', content: 'محاولة دخول إدارة', scope: 'ADMIN' }))
    expect(res.status).toBe(403)
    expect(createdMessages.length).toBe(0)
  })

  test('ADMIN cannot message a userId-null legacy application', async () => {
    const route = await import('@/app/api/supervisor/messages/route')
    appUserId = null
    const res = await route.POST(postRequest({ admissionId: 'adm-1', content: 'بلا حساب', scope: 'ADMIN' }))
    expect(res.status).toBe(403)
    expect(createdMessages.length).toBe(0)
  })

  test('student reply in admin scope stays in the admin thread and notifies admins', async () => {
    const route = await import('@/app/api/supervisor/messages/route')
    currentUser = { id: 'student-1', role: 'STUDENT', email: 'student@example.com' }
    const res = await route.POST(postRequest({ admissionId: 'adm-1', content: 'تم، شكراً', scope: 'ADMIN' }))
    expect(res.status).toBe(200)
    expect(createdMessages[0].scope).toBe('ADMIN')
    expect(notifyAdminCalls[0][0]).toBe('ADMIN_MESSAGE')
    const get = await route.GET(getRequest())
    const body = await get.json()
    expect(body.messages.map((m: any) => m.id)).not.toContain(createdMessages[0].id)
  })

  test('student supervision send without audience defaults to ALL', async () => {
    const route = await import('@/app/api/supervisor/messages/route')
    currentUser = { id: 'student-1', role: 'STUDENT', email: 'student@example.com' }
    await route.POST(postRequest({ admissionId: 'adm-1', content: 'سؤال عام' }))
    expect(createdMessages[0].audience).toBe('ALL')
    expect(createdMessages[0].scope).toBe('SUPERVISION')
  })

  test('audience AI → no human notification, AI reply created in the same thread', async () => {
    const route = await import('@/app/api/supervisor/messages/route')
    currentUser = { id: 'student-1', role: 'STUDENT', email: 'student@example.com' }
    const res = await route.POST(postRequest({ admissionId: 'adm-1', content: 'سؤال للذكي', audience: 'AI' }))
    expect(res.status).toBe(200)
    expect(notifyCalls.length).toBe(0)
    await flush()
    expect(aiCalls).toBe(1)
    const aiReply = createdMessages.find((m) => m.senderRole === 'AI')
    expect(aiReply).toBeTruthy()
    expect(aiReply.scope).toBe('SUPERVISION')
    expect(aiReply.audience).toBe('ALL')
    expect(aiReply.admissionId).toBe('adm-1')
  })

  test('audience ALL → human notified AND AI reply created', async () => {
    const route = await import('@/app/api/supervisor/messages/route')
    currentUser = { id: 'student-1', role: 'STUDENT', email: 'student@example.com' }
    await route.POST(postRequest({ admissionId: 'adm-1', content: 'سؤال للاثنين', audience: 'ALL' }))
    expect(notifyCalls.length).toBe(1)
    await flush()
    expect(aiCalls).toBe(1)
    expect(createdMessages.some((m) => m.senderRole === 'AI')).toBe(true)
  })

  test('audience HUMAN → human notified, NO AI reply', async () => {
    const route = await import('@/app/api/supervisor/messages/route')
    currentUser = { id: 'student-1', role: 'STUDENT', email: 'student@example.com' }
    await route.POST(postRequest({ admissionId: 'adm-1', content: 'سؤال للبشري', audience: 'HUMAN' }))
    expect(notifyCalls.length).toBe(1)
    await flush()
    expect(aiCalls).toBe(0)
    expect(createdMessages.some((m) => m.senderRole === 'AI')).toBe(false)
  })

  test('AI generation failure → student message still saved and POST succeeds, no AI message', async () => {
    const route = await import('@/app/api/supervisor/messages/route')
    currentUser = { id: 'student-1', role: 'STUDENT', email: 'student@example.com' }
    aiBehavior = 'fail'
    const res = await route.POST(postRequest({ admissionId: 'adm-1', content: 'سؤال للذكي', audience: 'AI' }))
    expect(res.status).toBe(200)
    expect(createdMessages.some((m) => m.senderRole === 'STUDENT' && m.content === 'سؤال للذكي')).toBe(true)
    await flush()
    expect(createdMessages.some((m) => m.senderRole === 'AI')).toBe(false)
  })

  test('supervision thread query returns all audiences (no audience filtering)', async () => {
    const route = await import('@/app/api/supervisor/messages/route')
    currentUser = { id: 'student-1', role: 'STUDENT', email: 'student@example.com' }
    const res = await route.GET(getRequest('SUPERVISION'))
    const body = await res.json()
    expect(body.messages.map((m: any) => m.audience).sort()).toEqual(['ALL', 'HUMAN'])
  })
})

describe('notifications PATCH — id marks only that notification', () => {
  test('PATCH with id scopes updateMany to that id + user', async () => {
    const route = await import('@/app/api/notifications/route')
    const res = await route.PATCH(new NextRequest('http://localhost/api/notifications', {
      method: 'PATCH',
      body: JSON.stringify({ id: 'n-1' }),
      headers: { 'content-type': 'application/json' },
    }))
    expect(res.status).toBe(200)
    expect(updateManyCalls[0].where).toEqual({ id: 'n-1', userId: 'admin-1' })
  })

  test('PATCH with link scopes updateMany to that thread', async () => {
    const route = await import('@/app/api/notifications/route')
    const res = await route.PATCH(new NextRequest('http://localhost/api/notifications', {
      method: 'PATCH',
      body: JSON.stringify({ link: 'admin-messages:adm-1' }),
      headers: { 'content-type': 'application/json' },
    }))
    expect(res.status).toBe(200)
    expect(updateManyCalls[0].where).toEqual({ userId: 'admin-1', link: 'admin-messages:adm-1', read: false })
  })
})
