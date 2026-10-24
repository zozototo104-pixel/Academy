/// <reference types="bun-types" />
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { NextRequest } from 'next/server'

let paymentRows: any[] = []
const findManyCalls: any[] = []

const db: any = {
  payment: {
    findMany: async (args: any) => {
      findManyCalls.push(args)
      return paymentRows
    },
    count: async () => paymentRows.length,
    aggregate: async () => ({ _sum: { amount: 0 } }),
  },
}

mock.module('@/lib/db', () => ({ db }))
mock.module('@/lib/auth', () => ({
  requireAdmin: async () => ({ id: 'admin-1', name: 'المدير' }),
}))
mock.module('@/lib/settle-payment', () => ({
  markInvoicePaid: async () => ({}),
}))
mock.module('@/lib/notify', () => ({
  notify: async () => ({}),
  audit: async () => ({}),
}))
mock.module('@/lib/admin-query', () => ({
  cleanAdminQuery: (value: unknown, max = 160) => String(value || '').trim().slice(0, max),
  parseAdminPagination: (sp: any, opts: any) => {
    const page = Math.max(1, Number(sp.get('page')) || 1)
    const pageSize = Math.min(opts?.maxPageSize || 100, Math.max(1, Number(sp.get('pageSize')) || opts?.pageSize || 25))
    return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize }
  },
  adminPaginationMeta: (page: number, pageSize: number, total: number) => ({ page, pageSize, total }),
}))
mock.module('@/lib/settings', () => ({
  getSettings: async () => ({}),
}))
mock.module('@/lib/money', () => ({
  dollarsToCents: (n: number) => Math.round((Number(n) || 0) * 100),
}))

const { GET } = await import('../../src/app/api/admin/payments/route')

function get(path: string) {
  return new NextRequest(`http://localhost${path}`)
}

function paymentFixture(overrides: any = {}) {
  return {
    id: 'pay-1',
    invoiceNo: 'AACT-INV-2026-0001',
    purpose: 'TUITION',
    description: 'رسوم دراسية',
    amount: 100,
    status: 'UNPAID',
    admission: { reference: 'AACT-1', fullName: 'طالب اختبار', country: 'فلسطين', program: 'دبلوم' },
    proofs: [],
    waiverCodes: [],
    ...overrides,
  }
}

function waiverFilterFromWhere(where: any) {
  const and = where?.AND || []
  for (const clause of and) {
    if (clause?.waiverCodes?.some?.status) return clause.waiverCodes.some.status
    if (clause?.waiverCodes) return clause.waiverCodes
  }
  return undefined
}

beforeEach(() => {
  paymentRows = []
  findManyCalls.length = 0
})

describe('finance waiver-code filters', () => {
  test('WAIVER_AWAITING_ENTRY filters on an ISSUED waiver code only', async () => {
    paymentRows = [paymentFixture({ waiverCodes: [{ id: 'w-1', status: 'ISSUED', codePreview: 'AACT-****' }] })]
    const res = await GET(get('/api/admin/payments?status=WAIVER_AWAITING_ENTRY'))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(findManyCalls.length).toBe(1)
    expect(waiverFilterFromWhere(findManyCalls[0].where)).toBe('ISSUED')
    expect(body.payments).toHaveLength(1)
  })

  test('WAIVER_AWAITING_APPROVAL filters on a VERIFIED waiver code only', async () => {
    paymentRows = [paymentFixture({ waiverCodes: [{ id: 'w-2', status: 'VERIFIED', codePreview: 'AACT-****' }] })]
    const res = await GET(get('/api/admin/payments?status=WAIVER_AWAITING_APPROVAL'))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(waiverFilterFromWhere(findManyCalls[0].where)).toBe('VERIFIED')
    expect(body.payments).toHaveLength(1)
  })

  test('EXPIRED codes match neither filter (exact-status match, not a status list)', async () => {
    paymentRows = [paymentFixture({ waiverCodes: [{ id: 'w-3', status: 'EXPIRED', codePreview: 'AACT-****' }] })]
    for (const status of ['WAIVER_AWAITING_ENTRY', 'WAIVER_AWAITING_APPROVAL']) {
      findManyCalls.length = 0
      const res = await GET(get(`/api/admin/payments?status=${status}`))
      expect(res.status).toBe(200)
      const and = findManyCalls[0].where?.AND || []
      const waiverClause = and.find((c: any) => c?.waiverCodes)
      // Exact equality: only the named status can satisfy the relation filter.
      expect(waiverClause.waiverCodes.some.status).not.toBe('EXPIRED')
      expect(waiverClause.waiverCodes.some.status).not.toContain('EXPIRED')
      expect(waiverClause.waiverCodes.some).not.toHaveProperty('in')
    }
  })

  test('existing filters keep their exact behavior', async () => {
    paymentRows = [paymentFixture()]
    const cases: Array<[string, (where: any) => void]> = [
      ['PAID', (w) => expect(w.AND).toContainEqual({ status: 'PAID' })],
      ['TUITION', (w) => expect(w.AND).toContainEqual({ purpose: 'TUITION' })],
      ['MANUAL_PENDING', (w) => {
        expect(w.AND).toContainEqual(expect.objectContaining({ status: 'UNPAID' }))
      }],
    ]
    for (const [status, check] of cases) {
      findManyCalls.length = 0
      const res = await GET(get(`/api/admin/payments?status=${status}`))
      expect(res.status).toBe(200)
      check(findManyCalls[0].where)
    }
    findManyCalls.length = 0
    const resAll = await GET(get('/api/admin/payments?status=ALL'))
    expect(resAll.status).toBe(200)
    expect(findManyCalls[0].where).toEqual({})
  })

  test('UI + route source pins for the new options', () => {
    const ui = readFileSync('src/components/aact/AdminExtras.tsx', 'utf8')
    expect(ui).toContain("value: 'WAIVER_AWAITING_ENTRY'")
    expect(ui).toContain("label: 'بانتظار إدخال الطالب'")
    expect(ui).toContain("value: 'WAIVER_AWAITING_APPROVAL'")
    expect(ui).toContain("label: 'بانتظار اعتمادك'")
    const route = readFileSync('src/app/api/admin/payments/route.ts', 'utf8')
    expect(route).toContain("status === 'WAIVER_AWAITING_ENTRY'")
    expect(route).toContain("waiverCodes: { some: { status: 'ISSUED' } }")
    expect(route).toContain("status === 'WAIVER_AWAITING_APPROVAL'")
    expect(route).toContain("waiverCodes: { some: { status: 'VERIFIED' } }")
  })
})
