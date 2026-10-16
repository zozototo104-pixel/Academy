/// <reference types="bun-types" />
import { existsSync, statSync } from 'fs'
import { join } from 'path'
import { beforeAll, describe, expect, test } from 'bun:test'
import { jsPDF } from 'jspdf'

const { ARABIC_FONT_NAME, buildInvoicePdf } = await import('../../src/lib/invoice-pdf')
const { loadArabicCanvas, toVisualArabic } = await import('../../src/lib/pdf-arabic')

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
  test('converts Arabic to visual presentation forms without reversing embedded Latin and numbers', () => {
    const visual = toVisualArabic('رقم')
    expect(visual).not.toBe('رقم')
    expect(/[\uFE70-\uFEFF]/.test(visual)).toBe(true)
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

  test('embeds the AmiriArabic font without using jsPDF RTL double-flip mode', () => {
    const originalSetR2L = (jsPDF as any).API.setR2L
    const originalIsInputRtl = (jsPDF as any).API.isInputRtl
    let r2lCalls = 0
    let inputRtlCalls = 0
    ;(jsPDF as any).API.setR2L = function (...args: any[]) {
      r2lCalls += 1
      return originalSetR2L?.apply(this, args)
    }
    ;(jsPDF as any).API.isInputRtl = function (...args: any[]) {
      inputRtlCalls += 1
      return originalIsInputRtl?.apply(this, args)
    }
    try {
      const pdf = buildInvoicePdf(sampleInvoice(), { fontPaths: [fontPath], compress: false })
      expect(pdf.byteLength).toBeGreaterThan(1000)
      expect(pdfOutput(pdf)).toContain(ARABIC_FONT_NAME)
      expect(r2lCalls).toBe(0)
      expect(inputRtlCalls).toBe(0)
    } finally {
      ;(jsPDF as any).API.setR2L = originalSetR2L
      ;(jsPDF as any).API.isInputRtl = originalIsInputRtl
    }
  })

  test('renders Arabic invoice text as images in the PDF', () => {
    const pdf = buildInvoicePdf(sampleInvoice(), { fontPaths: [fontPath], compress: false })
    const output = pdfOutput(pdf)

    expect(pdf.byteLength).toBeGreaterThan(1000)
    expect(output).toContain('/Subtype /Image')
  })

  test('falls back to shaped Amiri text when the Arabic image renderer throws', () => {
    const pdf = buildInvoicePdf(sampleInvoice(), {
      fontPaths: [fontPath],
      compress: false,
      arabicImageRenderer: () => {
        throw new Error('canvas unavailable')
      },
    })
    const output = pdfOutput(pdf)

    expect(pdf.byteLength).toBeGreaterThan(1000)
    expect(output).toContain(ARABIC_FONT_NAME)
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
