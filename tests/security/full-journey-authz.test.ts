// حارس صلاحيات مسار رحلة QA الكاملة (بوابة #701، 2026-11-09):
// معالج POST كان يبتلع خطأ UNAUTHORIZED من requireAdmin ويحوّله إلى 500،
// ففشل فحصا «زائر بلا دخول» و«طالب» في اختبار الرحلة (توقّعا 401/403).
// GET وDELETE كانا يرجّعان 403 بصورة صحيحة. هذا الاختبار يثبّت أن
// المعالجات الثلاثة ترفض غير الأدمن بـ403، وأن requireAdmin نفسه
// ما زال يرفض أي دور غير ADMIN (لا تخفيف للصلاحيات).
import { describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { NextRequest } from 'next/server'

// محاكاة الاعتماديات الثقيلة: ما يهمّنا هو طبقة التفويض فقط.
// requireAdmin يرمي UNAUTHORIZED كما يفعل مع غير الأدمن فعلياً.
mock.module('@/lib/db', () => ({ db: {} }))
mock.module('@/lib/auth', () => ({
  hashPassword: async () => 'unused',
  requireAdmin: async () => {
    throw new Error('UNAUTHORIZED')
  },
}))
mock.module('@/lib/notify', () => ({ audit: async () => {} }))
mock.module('@/lib/settle-payment', () => ({ markInvoicePaid: async () => ({ ok: true }) }))
mock.module('@/lib/tuition-installments', () => ({
  enforceSemesterTuitionGate: async () => ({}),
  getAdmissionTuitionPlan: async () => ({}),
}))
mock.module('@/lib/semester-readiness', () => ({
  calculateSemesterReadiness: () => ({}),
  markSemesterReady: async () => ({}),
}))
mock.module('@/lib/final-grade', () => ({ calculateFinalGrade: () => ({}) }))
mock.module('@/lib/settings', () => ({
  nextAdmissionRef: async () => 'QA-REF',
  nextInvoiceNo: async () => 'AACT-INV-QA-1',
}))
mock.module('@/lib/money', () => ({ dollarsToCents: (n: number) => Math.round(n * 100) }))
mock.module('@/lib/prod-safety', () => ({ qaProdFixturesAllowed: () => true }))

const route = await import('@/app/api/admin/full-journey/route')

describe('مسار رحلة QA يرفض غير الأدمن بـ403 لا 500', () => {
  test('POST بلا صلاحية أدمن: 403 ورسالة صلاحيات', async () => {
    const res = await route.POST()
    expect(res.status).toBe(403)
    const body = await res.json().catch(() => ({}))
    expect(String(body?.error || '')).toContain('صلاحيات')
  })

  test('GET بلا صلاحية أدمن: 403', async () => {
    const res = await route.GET()
    expect(res.status).toBe(403)
  })

  test('DELETE بلا صلاحية أدمن: 403', async () => {
    const req = new NextRequest('http://x/api/admin/full-journey', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stamp: 'qa-unauthorized-probe' }),
    })
    const res = await route.DELETE(req)
    expect(res.status).toBe(403)
  })

  test('requireAdmin الحقيقي ما زال يرفض أي دور غير ADMIN', () => {
    const authSource = readFileSync(new URL('../../src/lib/auth.ts', import.meta.url), 'utf8')
    const start = authSource.indexOf('export async function requireAdmin')
    expect(start).toBeGreaterThan(-1)
    const body = authSource.slice(start, start + 400)
    expect(body).toContain("user.role !== 'ADMIN'")
    expect(body).toContain('UNAUTHORIZED')
  })
})
