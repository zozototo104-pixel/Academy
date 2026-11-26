// Comprehensive exam — Excel + document import parsing.
import { describe, expect, test } from 'bun:test'
import * as XLSX from 'xlsx'
import {
  buildComprehensiveExamTemplateBuffer,
  parseComprehensiveExamDocText,
  parseComprehensiveExamExcel,
} from '../../src/lib/comprehensive-exam'

function buildWorkbook(rows: unknown[][]): Buffer {
  const ws = XLSX.utils.aoa_to_sheet(rows)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'أسئلة')
  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }))
}

const HEADER = ['السؤال', 'النوع', 'الخيار 1', 'الخيار 2', 'الخيار 3', 'الخيار 4', 'الإجابة الصحيحة', 'الدليل']

describe('parseComprehensiveExamExcel', () => {
  test('parses MCQ + TF rows and collects bad rows without stopping', () => {
    const buffer = buildWorkbook([
      HEADER,
      ['أي مما يلي يُعد من الأصول المتداولة؟', 'اختيار متعدد', 'النقدية', 'المباني', 'براءات الاختراع', 'الشهرة', '1', 'النقدية أصل متداول.'],
      ['تُقاس الأصول المتداولة بأنها الموارد المتوقع تحويلها إلى نقد.', 'صح/خطأ', '', '', '', '', 'صح', ''],
      [],
      ['اشرح بالتفصيل مفهوم الأصول المتداولة.', 'مقالي', '', '', '', '', '', ''],
      ['سؤال بخيارين فقط؟', 'اختيار متعدد', 'أ', 'ب', '', '', '1', ''],
    ])
    const result = parseComprehensiveExamExcel(buffer)
    expect(result.questions).toHaveLength(2)
    expect(result.questions[0].type).toBe('MCQ')
    expect(result.questions[0].correctAnswer).toBe('0')
    expect(result.questions[1].type).toBe('TF')
    expect(result.questions[1].correctAnswer).toBe('0')
    expect(result.errors).toHaveLength(2)
    expect(result.errors[0].row).toBe(5) // the essay row
    expect(result.errors[0].message).toContain('لا مقالي')
    expect(result.errors[1].row).toBe(6) // the 2-option MCQ
    expect(result.skippedEmpty).toBe(1)
  })

  test('accepts English headers and a correct answer given as option text', () => {
    const buffer = buildWorkbook([
      ['Question', 'Type', 'Option 1', 'Option 2', 'Option 3', 'Option 4', 'Correct answer', 'Evidence'],
      ['Which of the following is a current asset in financial statements?', 'MCQ', 'Cash', 'Buildings', 'Patents', 'Goodwill', 'Cash', ''],
    ])
    const result = parseComprehensiveExamExcel(buffer)
    expect(result.questions).toHaveLength(1)
    expect(result.questions[0].correctAnswer).toBe('0')
    expect(result.errors).toHaveLength(0)
  })

  test('fails clearly when no header row exists', () => {
    const buffer = buildWorkbook([['foo', 'bar'], ['baz', 'qux']])
    const result = parseComprehensiveExamExcel(buffer)
    expect(result.questions).toHaveLength(0)
    expect(result.errors[0].message).toContain('صف عناوين')
  })

  test('the shipped template parses back to two valid example questions', () => {
    const buffer = buildComprehensiveExamTemplateBuffer()
    const result = parseComprehensiveExamExcel(buffer)
    expect(result.questions).toHaveLength(2)
    expect(result.errors).toHaveLength(0)
    expect(result.questions.map((q) => q.type)).toEqual(['TF', 'MCQ'])
  })
})

describe('parseComprehensiveExamDocText', () => {
  test('parses a JSON array and refuses essay rows', () => {
    const result = parseComprehensiveExamDocText(
      JSON.stringify({
        questions: [
          { type: 'MCQ', text: 'أي مما يلي يُعد من الأصول المتداولة؟', options: ['النقدية', 'المباني', 'الشهرة'], correctAnswer: '0' },
          { type: 'ESSAY', text: 'اشرح الأصول المتداولة بالتفصيل.' },
        ],
      }),
    )
    expect(result.questions).toHaveLength(1)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].message).toContain('لا مقالي')
  })

  test('parses tab-delimited rows and counts skipped lines', () => {
    const text = [
      'MCQ\tأي مما يلي يُعد من الأصول المتداولة؟\tالنقدية\tالمباني\tالشهرة\t\t0',
      'TF\tالمباني أصل متداول.\t\t\t\t\tخطأ',
      '',
      'سطر بلا أعمدة كافية',
    ].join('\n')
    const result = parseComprehensiveExamDocText(text)
    expect(result.questions).toHaveLength(2)
    expect(result.questions[1].type).toBe('TF')
    expect(result.questions[1].correctAnswer).toBe('1')
  })

  test('empty text is an error, not a silent zero', () => {
    const result = parseComprehensiveExamDocText('   ')
    expect(result.questions).toHaveLength(0)
    expect(result.errors).toHaveLength(1)
  })
})
