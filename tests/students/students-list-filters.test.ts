/// <reference types="bun-types" />
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { NextRequest } from 'next/server'

let userRows: any[] = []
let appRows: any[] = []
const userFindManyCalls: any[] = []
const appFindManyCalls: any[] = []

const db: any = {
  user: {
    findMany: async (args: any) => {
      userFindManyCalls.push(args)
      return userRows
    },
    count: async () => userRows.length,
  },
  admissionApplication: {
    findMany: async (args: any) => {
      appFindManyCalls.push(args)
      return appRows
    },
    count: async () => appRows.length,
  },
  enrollment: { findMany: async () => [] },
  examAttempt: { groupBy: async () => [] },
  programExamAttempt: { groupBy: async () => [] },
  chatMessage: { groupBy: async () => [] },
}

mock.module('@/lib/db', () => ({ db }))
mock.module('@/lib/auth', () => ({
  requireAdmin: async () => ({ id: 'admin-1', name: 'المدير' }),
}))
mock.module('@/lib/notify', () => ({ audit: async () => ({}) }))
mock.module('@/lib/rate-limit', () => ({ enforceApiRateLimit: () => null }))
mock.module('@/lib/admin-query', () => ({
  parseAdminPagination: (sp: any, opts: any) => {
    const page = Math.max(1, Number(sp.get('page')) || 1)
    const pageSize = Math.min(opts?.maxPageSize || 100, Math.max(1, Number(sp.get('pageSize')) || opts?.pageSize || 25))
    return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize }
  },
  adminPaginationMeta: (page: number, pageSize: number, total: number) => ({ page, pageSize, total }),
}))
mock.module('@/lib/enrollment-status', () => ({
  REGISTERED_ONLY_STATUS: 'REGISTERED_ONLY',
  buildAdminStudentsEnrollmentRelationFilter: () => ({ some: {} }),
}))

const { GET } = await import('../../src/app/api/admin/students/route')

function get(path: string) {
  return new NextRequest(`http://localhost${path}`)
}

function appFixture(overrides: any) {
  return {
    id: 'app-1',
    reference: 'AACT-1',
    fullName: 'طالب اختبار',
    email: 'linked@example.test',
    country: 'فلسطين',
    program: 'دبلوم',
    status: 'UNDER_REVIEW',
    userId: 'user-1',
    acknowledged: true,
    createdAt: new Date('2026-01-01'),
    phone: 'app-phone-1',
    programRef: { titleAr: 'دبلوم' },
    _count: { files: 2 },
    ...overrides,
  }
}

beforeEach(() => {
  userRows = []
  appRows = []
  userFindManyCalls.length = 0
  appFindManyCalls.length = 0
})

describe('فلاتر قائمة الطلاب', () => {
  test('بانتظار تحقق: يعيد طلاباً مسجّلين بلا إيميل موثّق فقط، بلا قيد التحاق', async () => {
    userRows = [
      { id: 'user-1', email: 'a@example.test', name: 'أ', country: 'فلسطين', status: 'ACTIVE', createdAt: new Date(), phone: '+970500000001', emailVerifiedAt: null },
    ]
    const res = await GET(get('/api/admin/students?status=AWAITING_VERIFICATION'))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(userFindManyCalls).toHaveLength(1)
    const where = userFindManyCalls[0].where
    expect(where.role).toBe('STUDENT')
    expect(where.emailVerifiedAt).toBeNull()
    expect(where).not.toHaveProperty('enrollments')
    expect(body.students).toHaveLength(1)
    expect(body.students[0].hasAccount).toBe(true)
    expect(body.students[0].emailVerifiedAt).toBeNull()
  })

  test('بده مرفقات: يعيد طلبات بحالة DOCUMENTS_NEED_REPLACEMENT فقط', async () => {
    appRows = [appFixture({ status: 'DOCUMENTS_NEED_REPLACEMENT' })]
    userRows = []
    const res = await GET(get('/api/admin/students?status=NEEDS_DOCUMENTS'))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(appFindManyCalls).toHaveLength(1)
    expect(appFindManyCalls[0].where.status).toBe('DOCUMENTS_NEED_REPLACEMENT')
    expect(body.students).toHaveLength(1)
    expect(body.students[0].rowKind).toBe('INCOMPLETE_ADMISSION')
  })

  test('الفلاتر الفرعية لغير المستكمل تطابق شرط السبب نفسه', async () => {
    const cases: [string, any][] = [
      ['WITHOUT_ACCOUNT', { userId: null }],
      ['ACK_PENDING', { acknowledged: false }],
      ['NO_FILES', { files: { none: {} } }],
      ['NEEDS_REPLACEMENT', { status: 'DOCUMENTS_NEED_REPLACEMENT' }],
    ]
    for (const [reason, expected] of cases) {
      appFindManyCalls.length = 0
      const res = await GET(get(`/api/admin/students?status=INCOMPLETE_ADMISSIONS&incompleteReason=${reason}`))
      expect(res.status).toBe(200)
      expect(appFindManyCalls).toHaveLength(1)
      const or = appFindManyCalls[0].where.AND[1].OR
      expect(or).toEqual([expected])
    }
  })

  test('غير مستكمل بلا فلتر فرعي: يعيد كل الأسباب الأربعة', async () => {
    const res = await GET(get('/api/admin/students?status=INCOMPLETE_ADMISSIONS'))
    expect(res.status).toBe(200)
    expect(appFindManyCalls).toHaveLength(1)
    const or = appFindManyCalls[0].where.AND[1].OR
    expect(or).toHaveLength(4)
    expect(or).toContainEqual({ userId: null })
    expect(or).toContainEqual({ acknowledged: false })
    expect(or).toContainEqual({ files: { none: {} } })
    expect(or).toContainEqual({ status: 'DOCUMENTS_NEED_REPLACEMENT' })
  })

  test('صفوف الطلبات: جلبة حسابات واحدة مجمّعة تحل hasAccount والتوثيق والهاتف', async () => {
    appRows = [
      appFixture({ id: 'app-1', email: 'linked@example.test', phone: 'app-phone-1', userId: 'user-1' }),
      appFixture({ id: 'app-2', email: 'nolink@example.test', phone: 'app-phone-2', userId: null, acknowledged: false, status: 'UNDER_REVIEW', _count: { files: 0 } }),
    ]
    userRows = [{ email: 'linked@example.test', phone: '+970500000001', emailVerifiedAt: new Date('2026-01-01') }]
    const res = await GET(get('/api/admin/students?status=INCOMPLETE_ADMISSIONS'))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(userFindManyCalls).toHaveLength(1)
    expect([...userFindManyCalls[0].where.email.in].sort()).toEqual(['linked@example.test', 'nolink@example.test'])
    const [linked, unlinked] = body.students
    expect(linked.hasAccount).toBe(true)
    expect(linked.emailVerifiedAt).not.toBeNull()
    expect(linked.phone).toBe('+970500000001')
    expect(unlinked.hasAccount).toBe(false)
    expect(unlinked.emailVerifiedAt).toBeNull()
    expect(unlinked.phone).toBe('app-phone-2')
    expect(unlinked.incompleteReasons).toContain('بدون حساب مرتبط')
  })

  test('واجهة الفلاتر والزر موصولة بالحقول والعناوين الصحيحة', () => {
    const view = readFileSync(new URL('../../src/components/aact/AdminView.tsx', import.meta.url), 'utf-8')
    expect(view).toContain('بانتظار تحقق')
    expect(view).toContain('بده مرفقات')
    expect(view).toContain('INCOMPLETE_WITHOUT_ACCOUNT')
    expect(view).toContain('incompleteReason')
    expect(view).toContain('hasAccount')
    expect(view).toContain('لا يوجد حساب مرتبط')
    expect(view).toContain('!s.hasAccount')
    const route = readFileSync(new URL('../../src/app/api/admin/students/route.ts', import.meta.url), 'utf-8')
    expect(route).toContain('AWAITING_VERIFICATION')
    expect(route).toContain('NEEDS_DOCUMENTS')
    expect(route).toContain('WITHOUT_ACCOUNT')
    expect(route).toContain('hasAccount')
  })
})
