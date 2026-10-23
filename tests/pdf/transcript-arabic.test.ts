/// <reference types="bun-types" />
import { existsSync, statSync } from 'fs'
import { join } from 'path'
import { beforeAll, describe, expect, test } from 'bun:test'

const { buildTranscriptPdf } = await import('../../src/lib/transcript-pdf')
const { loadArabicCanvas } = await import('../../src/lib/pdf-arabic')
const { ARABIC_FONT_NAME } = await import('../../src/lib/invoice-pdf')

const fontPath = join(process.cwd(), 'public', 'fonts', 'Amiri-Regular.ttf')

type TranscriptFixture = Parameters<typeof buildTranscriptPdf>[0]

function sampleTranscript(overrides: Partial<TranscriptFixture> = {}): TranscriptFixture {
  return {
    title: 'السجل الأكاديمي الرسمي',
    subtitle: 'Official Academic Transcript',
    documentLabel: 'ACADEMIC TRANSCRIPT',
    reference: 'AACT-2026-A66F772F',
    issuedAt: new Date('2026-10-23T00:00:00.000Z'),
    status: 'سجل فعّال / ACTIVE RECORD',
    statusTone: 'success' as const,
    sections: [
      {
        title: 'بيانات الطالب / Student Details',
        rows: [
          { label: 'الاسم', value: 'يوسف محمود درويش الهندي' },
          { label: 'البريد', value: 'student@example.test', dir: 'ltr' as const },
          { label: 'الدولة', value: 'فلسطين' },
          { label: 'مرجع القبول', value: 'AACT-2026-A66F772F', dir: 'ltr' as const },
          { label: 'المشرف الأكاديمي', value: 'د. أحمد سامي' },
        ],
      },
      {
        title: 'البرنامج / دبلوم إدارة الموارد البشرية',
        rows: [
          { label: 'الاسم الإنجليزي', value: 'Diploma in Human Resources Management', dir: 'ltr' as const },
          { label: 'التصنيف', value: 'دبلوم مهني' },
          { label: 'الساعات', value: 120, dir: 'ltr' as const },
          { label: 'حالة التسجيل', value: 'ACTIVE', dir: 'ltr' as const },
          { label: 'الدرجة النهائية', value: 'قيد الاكتمال' },
        ],
      },
      {
        title: 'ملخص السجل / Academic Summary',
        rows: [
          { label: 'عدد البرامج', value: 1, dir: 'ltr' as const },
          { label: 'عدد التقييمات', value: 3, dir: 'ltr' as const },
          { label: 'التقييمات المجتازة', value: 2, dir: 'ltr' as const },
          { label: 'المتوسط العام', value: '86%' },
        ],
      },
    ],
    tables: [
      {
        title: 'التقييمات المسجلة / دبلوم إدارة الموارد البشرية',
        columns: ['التقييم', 'الجزء', 'الدرجة', 'الحالة', 'التاريخ'],
        rows: [
          ['اختبار الوحدة الأولى', 'مدخل إلى إدارة الموارد البشرية', '90%', 'ناجح', '2026-09-14'],
          ['اختبار الوحدة الثانية', 'التوظيف والاختيار', '82%', 'ناجح', '2026-09-28'],
          ['الاختبار الفصلي الأول', 'الفصل الأول', '—', 'غير ناجح', '2026-10-10'],
        ],
        maxRows: 14,
      },
    ],
    footer: 'هذا السجل الأكاديمي صادر إلكترونياً من منصة AACT ويعكس البيانات المسجلة وقت الإصدار.',
    ...overrides,
  }
}

function pdfOutput(pdf: Uint8Array) {
  return Buffer.from(pdf).toString('latin1')
}

beforeAll(async () => {
  await loadArabicCanvas(fontPath)
})

describe('Arabic transcript PDF rendering', () => {
  test('ships the Amiri font file used by Arabic transcript PDFs', () => {
    expect(existsSync(fontPath)).toBe(true)
    expect(statSync(fontPath).size).toBeGreaterThan(100 * 1024)
  })

  test('embeds the AmiriArabic font in the transcript PDF', () => {
    const pdf = buildTranscriptPdf(sampleTranscript(), { fontPaths: [fontPath], compress: false })
    expect(pdf.byteLength).toBeGreaterThan(1000)
    expect(pdfOutput(pdf)).toContain(ARABIC_FONT_NAME)
  })

  test('renders Arabic transcript text as images in the PDF (no system-font dependency)', () => {
    const pdf = buildTranscriptPdf(sampleTranscript(), { fontPaths: [fontPath], compress: false })
    const output = pdfOutput(pdf)
    expect(pdf.byteLength).toBeGreaterThan(1000)
    expect(output).toContain('/Subtype /Image')
  })

  test('paginates long transcripts instead of overflowing a single page', () => {
    const programSection = sampleTranscript().sections![1]
    const table = sampleTranscript().tables![0]
    const longTable = {
      ...table,
      rows: Array.from({ length: 14 }, (_, i) => [`اختبار الوحدة رقم ${i + 1}`, 'وحدة دراسية', '85%', 'ناجح', '2026-09-14']),
    }
    const pdf = buildTranscriptPdf(
      sampleTranscript({
        sections: [sampleTranscript().sections![0], programSection, programSection, programSection, sampleTranscript().sections![2]],
        tables: [longTable, longTable],
      }),
      { fontPaths: [fontPath], compress: false },
    )
    const pageObjects = pdfOutput(pdf).match(/\/Type \/Page\b/g) || []
    expect(pageObjects.length).toBeGreaterThanOrEqual(2)
  })

  test('still produces a PDF without throwing when the Arabic font is unavailable', () => {
    const missingFontPath = join(process.cwd(), 'public', 'fonts', 'Missing-Amiri-Regular.ttf')
    const pdf = buildTranscriptPdf(sampleTranscript(), { fontPaths: [missingFontPath], compress: false })
    expect(pdf.byteLength).toBeGreaterThan(1000)
    expect(pdfOutput(pdf)).not.toContain(ARABIC_FONT_NAME)
  })
})
