/// <reference types="bun-types" />
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { NextRequest } from 'next/server'
import { readFileSync } from 'node:fs'

// إصلاح إشعارات 2026-10-30 (شكوى Haris): الطالب كان يرى «أول كم إشعار» فقط
// (شريحة الملخص take:5 وقائمة الجرس take:30 بلا تصفح)، والفتح لا يعلّم مقروءاً.
// هذه الحراس تثبت سلوك الواجهة الجديد: تصفح كامل + تعليم ما شُوهد فقط بالمعرّفات.

let currentUser: any = { id: 'student-1', role: 'STUDENT', name: 'طالب' }

type Row = { id: string; userId: string; type: string; title: string; body: string; link: string | null; read: boolean; createdAt: Date }
let rows: Row[] = []

function seed() {
  rows = []
  for (let i = 1; i <= 45; i++) {
    rows.push({
      id: `n-${i}`,
      userId: 'student-1',
      type: 'GENERAL',
      title: `إشعار ${i}`,
      body: `نص الإشعار ${i}`,
      link: null,
      read: i > 40, // آخر ٥ مقروءة، والباقي غير مقروء
      createdAt: new Date(2026, 9, i),
    })
  }
  rows.push({ id: 'other-1', userId: 'student-2', type: 'GENERAL', title: 'لغيره', body: 'x', link: null, read: false, createdAt: new Date(2026, 9, 30) })
}

function matches(row: Row, where: any): boolean {
  if (!where) return true
  if (where.userId && row.userId !== where.userId) return false
  if (where.read !== undefined && row.read !== where.read) return false
  if (where.link !== undefined && row.link !== where.link) return false
  if (where.id !== undefined) {
    if (typeof where.id === 'string' && row.id !== where.id) return false
    if (where.id?.in && !where.id.in.includes(row.id)) return false
  }
  return true
}

const db: any = {
  notification: {
    findMany: async (args: any) => {
      const list = rows.filter((r) => matches(r, args?.where)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      const skip = args?.skip || 0
      const take = args?.take ?? list.length
      return list.slice(skip, skip + take)
    },
    count: async (args: any) => rows.filter((r) => matches(r, args?.where)).length,
    updateMany: async (args: any) => {
      let count = 0
      for (const row of rows) {
        if (matches(row, args?.where)) { Object.assign(row, args.data); count++ }
      }
      return { count }
    },
  },
}

mock.module('@/lib/db', () => ({ db }))
mock.module('@/lib/auth', () => ({
  requireUser: async () => {
    if (!currentUser) throw new Error('UNAUTHORIZED')
    return currentUser
  },
}))

const route = await import('../../src/app/api/notifications/route')

function getReq(query = '') {
  return new NextRequest(`http://localhost/api/notifications${query}`)
}
function patchReq(body: any) {
  return new NextRequest('http://localhost/api/notifications', { method: 'PATCH', body: JSON.stringify(body) })
}

beforeEach(() => { seed(); currentUser = { id: 'student-1', role: 'STUDENT', name: 'طالب' } })

describe('GET /api/notifications — التصفح الكامل', () => {
  test('الافتراضي يعيد 30 مع total الكلي وعدد غير المقروء', async () => {
    const res = await route.GET(getReq())
    const data = await res.json()
    expect(data.notifications.length).toBe(30)
    expect(data.total).toBe(45)
    expect(data.unread).toBe(40)
  })

  test('الصفحة الثانية تصل لما بعد «أول كم إشعار» دون تكرار', async () => {
    const p1 = await (await route.GET(getReq('?take=20&skip=0'))).json()
    const p2 = await (await route.GET(getReq('?take=20&skip=20'))).json()
    const p3 = await (await route.GET(getReq('?take=20&skip=40'))).json()
    expect(p1.notifications.length).toBe(20)
    expect(p2.notifications.length).toBe(20)
    expect(p3.notifications.length).toBe(5)
    const ids = [...p1.notifications, ...p2.notifications, ...p3.notifications].map((n: any) => n.id)
    expect(new Set(ids).size).toBe(45)
    expect(ids).toContain('n-1') // أقدم إشعار صار قابلاً للوصول
  })

  test('take يتقيد بسقف 100 وskip السالب يُصفَّر', async () => {
    const data = await (await route.GET(getReq('?take=500&skip=-3'))).json()
    expect(data.notifications.length).toBe(45)
  })
})

describe('PATCH /api/notifications — تعليم ما شُوهد فقط', () => {
  test('ids تعلّم المعرّفات المحددة فقط وتترك الباقي غير مقروء', async () => {
    await route.PATCH(patchReq({ ids: ['n-40', 'n-39'] }))
    expect(rows.find((r) => r.id === 'n-40')?.read).toBe(true)
    expect(rows.find((r) => r.id === 'n-39')?.read).toBe(true)
    expect(rows.find((r) => r.id === 'n-38')?.read).toBe(false)
  })

  test('ids لا تعلّم إشعارات مستخدم آخر حتى لو سُرّب معرّفها', async () => {
    await route.PATCH(patchReq({ ids: ['other-1'] }))
    expect(rows.find((r) => r.id === 'other-1')?.read).toBe(false)
  })

  test('ids فارغة = لا عملية، ولا تنزلق لتعليم الكل', async () => {
    await route.PATCH(patchReq({ ids: [] }))
    expect(rows.filter((r) => !r.read).length).toBe(41)
  })

  test('الوضع القديم {} ما زال يعلّم الكل (زر الجرس القائم)', async () => {
    await route.PATCH(patchReq({}))
    expect(rows.filter((r) => r.userId === 'student-1' && !r.read).length).toBe(0)
    expect(rows.find((r) => r.id === 'other-1')?.read).toBe(false)
  })
})

describe('وصلات الواجهة — التعليم عند المشاهدة وحضور الموبايل', () => {
  const shell = readFileSync(new URL('../../src/components/aact/Shell.tsx', import.meta.url), 'utf8')
  const dashboard = readFileSync(new URL('../../src/components/aact/DashboardView.tsx', import.meta.url), 'utf8')

  test('الجرس يجدول تعليم المعروض عند الفتح عبر PATCH ids', () => {
    expect(shell).toContain('scheduleMarkSeen')
    expect(shell).toContain("JSON.stringify({ ids })")
  })

  test('قائمة الموبايل فيها مدخل إشعارات بعدّاد وينقل الطالب لتبويب إشعاراته', () => {
    expect(shell).toContain('openMobileNotifications')
    expect(shell).toContain('mobileUnread')
    expect(shell).toContain("'aact:dashboard-tab'")
    expect(shell).toContain("tab: 'notifications'")
  })

  test('تبويب الطالب يجلب القائمة الكاملة متصفحّة ولا يعتمد شريحة الملخص الخمسة', () => {
    expect(dashboard).toContain('/api/notifications?take=20&skip=')
    expect(dashboard).toContain('عرض المزيد')
    expect(dashboard).not.toContain('studentSummary.notifications.map')
    expect(dashboard).toContain('markNotificationsSeen')
    expect(dashboard).toContain('openNotificationItem')
  })
})
