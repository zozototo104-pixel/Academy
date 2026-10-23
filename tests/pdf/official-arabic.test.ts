/// <reference types="bun-types" />
import { existsSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { describe, expect, test } from 'bun:test'

const { renderOfficialPdf } = await import('../../src/lib/pdf/official')

const officialSourcePath = join(process.cwd(), 'src', 'lib', 'pdf', 'official.ts')
const officialSource = readFileSync(officialSourcePath, 'utf8')
const amiriFontPath = join(process.cwd(), 'public', 'fonts', 'Amiri-Regular.ttf')

describe('official Arabic PDF rendering', () => {
  test('uses the bundled Arabic font instead of relying on system fonts', () => {
    expect(existsSync(amiriFontPath)).toBe(true)
    expect(statSync(amiriFontPath).size).toBeGreaterThan(100_000)
    expect(officialSource).toContain("const OFFICIAL_ARABIC_FONT_FILE = 'Amiri-Regular.ttf'")
    expect(officialSource).toContain('getOfficialArabicFontFace()')
    expect(officialSource).toContain('@font-face')
    expect(officialSource).toContain('data:font/truetype;charset=utf-8;base64')
    expect(officialSource).toContain("'AACTOfficialArabic','Amiri','Noto Naskh Arabic'")
  })

  test('renders an official document with Arabic content into a PDF buffer', async () => {
    const pdf = await renderOfficialPdf({
      title: 'السجل الأكاديمي',
      subtitle: 'وثيقة رسمية قابلة للطباعة',
      documentLabel: 'AACT-TRANSCRIPT',
      status: 'الدرجة النهائية: قيد الاكتمال',
      statusTone: 'warning',
      reference: 'AACT-2026-TEST',
      sections: [
        {
          title: 'بيانات الطالب',
          rows: [
            { label: 'الطالب', value: 'يوسف محمود درويش الهندي' },
            { label: 'البرنامج', value: 'دبلوم إدارة الموارد البشرية' },
            { label: 'الحالة', value: 'ACTIVE', dir: 'ltr' },
          ],
        },
        {
          title: 'ملخص أكاديمي',
          lines: ['تظهر هذه الوثيقة السجل الأكاديمي والبرامج المسجلة والدرجات المتاحة للطالب.'],
        },
      ],
      tables: [
        {
          title: 'البرامج',
          columns: ['البرنامج', 'الحالة', 'الدرجة'],
          rows: [['دبلوم إدارة الموارد البشرية', 'ACTIVE', 'قيد الاكتمال']],
        },
      ],
    })
    const header = Buffer.from(pdf.slice(0, 4)).toString('utf8')
    expect(header).toBe('%PDF')
    expect(pdf.byteLength).toBeGreaterThan(25_000)
  })
})
