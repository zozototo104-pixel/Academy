import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const root = process.cwd()
const sourcePath = path.join(root, 'src/components/aact/AdminExtras.tsx')
const source = fs.readFileSync(sourcePath, 'utf8')

const financeStart = source.indexOf('export function AdminFinanceTab()')
const certMarker = '// ============ إدارة الشهادات ============'
const certStart = source.indexOf(certMarker)
expect(financeStart).toBeGreaterThan(-1)
expect(certStart).toBeGreaterThan(financeStart)
const financeBlock = source.slice(financeStart, certStart)
const certificatesAndAfter = source.slice(certStart)

const required = (text: string, needle: string) => {
  expect(text.includes(needle), `Missing required text: ${needle}`).toBe(true)
}

const functionBody = (name: string) => {
  const marker = `const ${name}`
  const start = financeBlock.indexOf(marker)
  expect(start, `Missing function: ${name}`).toBeGreaterThan(-1)
  const firstBrace = financeBlock.indexOf('{', start)
  expect(firstBrace, `Missing body for: ${name}`).toBeGreaterThan(start)
  let depth = 0
  for (let i = firstBrace; i < financeBlock.length; i += 1) {
    const char = financeBlock[i]
    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      if (depth === 0) return financeBlock.slice(start, i + 1)
    }
  }
  throw new Error(`Unclosed body for: ${name}`)
}

const requireAll = (text: string, needles: string[]) => {
  for (const needle of needles) required(text, needle)
}

describe('AdminFinanceTab workspace organization', () => {
  test('keeps AdminExtras TSX parseable through supported TypeScript API', () => {
    const result = ts.transpileModule(source, {
      fileName: sourcePath,
      compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      reportDiagnostics: true,
    })
    const errors = (result.diagnostics || []).filter((d) => d.category === ts.DiagnosticCategory.Error)
    expect(errors).toEqual([])
  })

  test('confines finance workspace state before certificates', () => {
    required(financeBlock, "const [openFinanceSection, setOpenFinanceSection] = useState<'payments' | 'reports'>('payments')")
    expect(certificatesAndAfter.includes('openFinanceSection')).toBe(false)
    expect(certificatesAndAfter.includes('finance-section-')).toBe(false)
  })

  test('renders two visual workspaces without changing behavior on open', () => {
    required(financeBlock, 'aria-label="مساحات عمل المالية والفواتير"')
    required(financeBlock, "['payments', 'الفواتير والإثباتات والإعفاءات'")
    required(financeBlock, "['reports', 'التقارير والتحليلات'")
    required(financeBlock, 'type="button"')
    required(financeBlock, 'aria-expanded={active}')
    required(financeBlock, 'aria-controls={`finance-section-${value}`}')
    required(financeBlock, 'onClick={() => setOpenFinanceSection(value)}')
    expect(financeBlock.includes('setOpenFinanceSection(value); load')).toBe(false)
    expect(financeBlock.includes('setOpenFinanceSection(value); api')).toBe(false)
  })

  test('keeps both workspaces mounted and only hides their wrappers', () => {
    required(financeBlock, 'id="finance-section-reports"')
    required(financeBlock, 'id="finance-section-payments"')
    required(financeBlock, "hidden={openFinanceSection !== 'reports'}")
    required(financeBlock, "hidden={openFinanceSection !== 'payments'}")
    expect(financeBlock.includes("openFinanceSection === 'reports' &&")).toBe(false)
    expect(financeBlock.includes("openFinanceSection === 'payments' &&")).toBe(false)
  })

  test('keeps finance KPI and warning content visible outside workspaces', () => {
    const switcherIndex = financeBlock.indexOf('aria-label="مساحات عمل المالية والفواتير"')
    for (const text of ['إجمالي المحصّل', 'مستحق غير مسدد', 'فواتير مسددة', 'شهادات صادرة (طلبات)', 'طلبات دفع مباشر بانتظار تأكيد وصول المبلغ']) {
      const index = financeBlock.indexOf(text)
      expect(index).toBeGreaterThan(-1)
      expect(index).toBeLessThan(switcherIndex)
    }
  })

  test('keeps report cards in the reports workspace', () => {
    const reportsIndex = financeBlock.indexOf('id="finance-section-reports"')
    const paymentsIndex = financeBlock.indexOf('id="finance-section-payments"')
    for (const text of ['معدلات القبول', 'الإيرادات حسب الدولة', 'أداء الوكلاء']) {
      const index = financeBlock.indexOf(text)
      expect(index).toBeGreaterThan(reportsIndex)
      expect(index).toBeLessThan(paymentsIndex)
    }
  })

  test('keeps invoices, proofs, waivers, and pager in the payments workspace', () => {
    const paymentsIndex = financeBlock.indexOf('id="finance-section-payments"')
    for (const text of [
      'AdminListToolbar',
      'كل الفواتير والإيصالات',
      'إثباتات الدفع',
      'قبول الإثبات',
      'رفض بسبب',
      'تأكيد وصول المبلغ',
      'كود إعفاء 30$',
      'إعفاء جزئي',
      'منحة كاملة',
      'اعتماد الإعفاء',
      'تطبيق الإعفاء على البرنامج',
      'AdminPager',
    ]) {
      expect(financeBlock.indexOf(text)).toBeGreaterThan(paymentsIndex)
    }
  })

  test('keeps load and query effects unchanged at contract level', () => {
    required(financeBlock, 'const load = () => setPaymentRefresh((v) => v + 1)')
    required(financeBlock, "api<{ payments: PaymentRow[]; totals: any; total: number }>(`/api/admin/payments?${params.toString()}`)")
    required(financeBlock, "api<Report>('/api/admin/reports')")
    required(financeBlock, "params.set('search', paymentSearch.trim())")
    required(financeBlock, "params.set('status', paymentStatusFilter)")
    required(financeBlock, "params.set('page', String(paymentPage))")
    required(financeBlock, "params.set('pageSize', String(paymentPageSize))")
  })

  test('keeps protected finance action body contracts', () => {
    requireAll(functionBody('confirm'), [
      "api('/api/admin/payments/confirm', { method: 'POST', body: JSON.stringify({ id: p.id, note }) })",
      "toast({ title: 'تم التأكيد'",
      'load()',
    ])

    requireAll(functionBody('reviewPaymentProof'), [
      "api<{ payment?: PaymentRow; emailStatus?: 'SENT' | 'FAILED' | 'SKIPPED' }>('/api/admin/payments/proofs', {",
      "method: 'PATCH'",
      'body: JSON.stringify({ proofId: proof.id, action, note })',
      "toast({ title: 'تم رفض الإثبات'",
      "toast({ title: 'تم قبول الإثبات'",
      'load()',
      'setProofReviewBusy(null)',
    ])

    requireAll(functionBody('generateWaiver'), [
      "api<{ code: string; waiver: PaymentWaiverCodeRow; emailStatus?: 'SENT' | 'FAILED' | 'SKIPPED' }>('/api/admin/payments/waivers', {",
      "method: 'POST'",
      'body: JSON.stringify({ paymentId: payment.id, waiverType, requestedAmount, reason })',
      'setGeneratedWaiverCodes((prev) => ({ ...prev, [payment.id]: result.code }))',
      'await copyWaiverCode(payment.id, result.code)',
      'load()',
    ])

    requireAll(functionBody('approveWaiver'), [
      "await api('/api/admin/payments/waivers', { method: 'PATCH', body: JSON.stringify({ action: 'APPROVE', waiverId: waiver.id }) })",
      "toast({ title: 'تم اعتماد الإعفاء'",
      'load()',
    ])

    requireAll(functionBody('openInvoicePdf'), [
      'window.open',
      'getToken()',
      'fetch(`/api/pdf/invoices/${encodeURIComponent(id)}`',
      'URL.createObjectURL(blob)',
      "toast({ title: 'تعذر فتح PDF الفاتورة'",
      'setPdfBusy(null)',
    ])
  })

  test('keeps payment filters, statuses, purposes, and manual pending shortcut', () => {
    for (const value of ['ALL', 'UNPAID', 'PAID', 'WAIVED', 'MANUAL_PENDING', 'APPLICATION_FEE', 'TUITION', 'TUITION_INSTALLMENT', 'SERVICE_FEE', 'AI_LIVE_CREDIT']) {
      required(financeBlock, `value: '${value}'`)
    }
    for (const purpose of ['APPLICATION_FEE', 'TUITION', 'TUITION_INSTALLMENT', 'ACCREDITATION_APP', 'ACCREDITATION_FEE', 'ACCREDITATION', 'SERVICE_FEE', 'AI_LIVE_CREDIT', 'OTHER']) {
      required(financeBlock, purpose)
    }
    required(financeBlock, "onClick={() => { setPaymentStatusFilter('MANUAL_PENDING'); setPaymentPage(1) }}")
  })
})
