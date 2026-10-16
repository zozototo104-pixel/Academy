/// <reference types="bun-types" />
import { existsSync, statSync } from 'fs'
import { join } from 'path'
import { describe, expect, mock, test } from 'bun:test'
import { jsPDF } from 'jspdf'

mock.module('@/lib/db', () => ({ db: {} }))
mock.module('@/lib/auth', () => ({ requireUser: async () => ({ id: 'admin-1', role: 'ADMIN' }) }))

const { ARABIC_FONT_NAME, buildInvoicePdf } = await import('../../src/app/api/pdf/invoices/[id]/route')
const { toVisualArabic } = await import('../../src/lib/pdf-arabic')

const fontPath = join(process.cwd(), 'public', 'fonts', 'Amiri-Regular.ttf')

type InvoicePdfFixture = Parameters<typeof buildInvoicePdf>[0]

function sampleInvoice(overrides: Partial<InvoicePdfFixture> = {}): InvoicePdfFixture {
  return {
    invoiceNo: 'INV-AR-1',
    receiptNo: 'RCPT-AR-1',
    title: 'OFFICIAL RECEIPT',
    status: 'PAID / Receipt issued',
    statusKind: 'PAID' as const,
    issueDate: '2026-10-16',
    settledAt: '2026-10-16',
    payerName: 'أحمد محمود',
    payerNameFallback: 'Ahmed Mahmoud',
    payerEmail: 'ahmed@example.test',
    payerCountry: 'Palestine',
    programOrService: 'برنامج الاستشارات الإدارية',
    programOrServiceFallback: 'Management Consulting Program',
    purpose: 'Tuition Invoice',
    description: 'رسوم البرنامج التدريبي للفصل الأول',
    descriptionFallback: 'Tuition Invoice',
    amount: '250.00 USD',
    originalAmount: '250.00 USD',
    waivedAmount: '0.00 USD',
    method: 'Bank Transfer',
    reference: 'APP-AR-1',
    ...overrides,
  }
}

function pdfOutput(pdf: Uint8Array) {
  return Buffer.from(pdf).toString('latin1')
}

describe('Arabic invoice PDF rendering', () => {
  test('converts Arabic to visual order without reversing embedded Latin and numbers', () => {
    const visual = toVisualArabic('رقم الفاتورة')
    expect(visual).not.toBe('رقم الفاتورة')
    expect(visual).not.toBe(Array.from(Array.from('رقم الفاتورة').reverse().join('')).reverse().join(''))
    const mixed = toVisualArabic('المتبقي: 100.00 USD')
    expect(mixed).toContain('100.00')
    expect(mixed).toContain('USD')
    expect(mixed).not.toContain('00.001')
    expect(mixed).not.toContain('DSU')
  })

  test('ships the Amiri font file used by Arabic invoice PDFs', () => {
    expect(existsSync(fontPath)).toBe(true)
    expect(statSync(fontPath).size).toBeGreaterThan(100 * 1024)
  })

  test('embeds the AmiriArabic font when Arabic invoice data is rendered with the font available', () => {
    const pdf = buildInvoicePdf(sampleInvoice(), { fontPaths: [fontPath] })

    expect(pdf.byteLength).toBeGreaterThan(1000)
    expect(pdfOutput(pdf)).toContain(ARABIC_FONT_NAME)
  })

  test('falls back without throwing when the Arabic font is unavailable', () => {
    const missingFontPath = join(process.cwd(), 'public', 'fonts', 'Missing-Amiri-Regular.ttf')
    const warnings: unknown[][] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warnings.push(args)
    }

    try {
      const pdf = buildInvoicePdf(sampleInvoice(), { fontPaths: [missingFontPath], compress: false })
      const output = pdfOutput(pdf)

      expect(pdf.byteLength).toBeGreaterThan(1000)
      expect(output).toContain('Management Consulting Program')
      expect(output).toContain('Tuition Invoice')
      expect(output).not.toContain(ARABIC_FONT_NAME)
      expect(warnings.some((entry) => String(entry[0]).includes('Arabic font missing') && String(entry[0]).includes(missingFontPath))).toBe(true)
    } finally {
      console.warn = originalWarn
    }
  })
})
