// Comprehensive exam — custom-book route against an in-memory fake DB.
// Real route code; only the DB/auth/audit and the extraction+generation
// lib are faked (the lib itself is unit-tested separately).
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { NextRequest } from 'next/server'

let exams: any[] = []
let questions: any[] = []
let qSeq = 0

let extractResult: any = null
let extractError: Error | null = null
let generateResult: any = null
let generateError: any = null

const fakeDb: any = {
  $transaction: async (work: (tx: any) => Promise<any>) => work(fakeDb),
  program: {
    findUnique: async ({ where }: any) =>
      where?.id === 'program-1' ? { id: 'program-1', titleAr: 'الماجستير المهني في إدارة الأعمال' } : null,
  },
  comprehensiveExam: {
    findUnique: async ({ where }: any) => exams.find((x) => x.id === where?.id) || null,
  },
  comprehensiveExamQuestion: {
    findMany: async ({ where }: any = {}) =>
      questions.filter((q) => !where?.examId || q.examId === where.examId).sort((a, b) => a.order - b.order),
    findFirst: async ({ where, orderBy }: any = {}) => {
      const rows = questions.filter((q) => !where?.examId || q.examId === where.examId)
      if (orderBy?.order === 'desc') rows.sort((a, b) => b.order - a.order)
      return rows[0] || null
    },
    createMany: async ({ data }: any) => {
      for (const row of data) {
        questions.push({ id: `q-${++qSeq}`, ...row, createdAt: new Date(), updatedAt: new Date() })
      }
      return { count: data.length }
    },
  },
}

mock.module('@/lib/db', () => ({ db: fakeDb }))
mock.module('@/lib/auth', () => ({ requireAdmin: async () => ({ id: 'admin-1', name: 'مدير الاختبار', role: 'ADMIN' }) }))
mock.module('@/lib/notify', () => ({ audit: async () => null }))
mock.module('@/lib/comprehensive-exam-custom-book', () => ({
  CUSTOM_BOOK_MAX_FILE_BYTES: 10 * 1024 * 1024,
  CUSTOM_BOOK_MAX_PAGES: 300,
  clampCustomBookQuestionCount: (v: unknown) => {
    const n = Number(v)
    if (!Number.isFinite(n)) return 5
    return Math.max(1, Math.min(10, Math.floor(n)))
  },
  extractCustomBookChunks: async () => {
    if (extractError) throw extractError
    return extractResult
  },
  generateCustomBookQuestions: async () => {
    if (generateError) throw generateError
    return generateResult
  },
}))

const route = await import('../../src/app/api/admin/comprehensive-exams/[id]/questions/from-custom-book/route')

function ctx(id: string): any {
  return { params: Promise.resolve({ id }) }
}

function fileReq(examId: string, file: File | null, count = '2') {
  const fd = new FormData()
  if (file) fd.append('file', file)
  fd.append('count', count)
  return new NextRequest(new URL(`/api/admin/comprehensive-exams/${examId}/questions/from-custom-book`, 'http://localhost'), {
    method: 'POST',
    body: fd,
  })
}

function pdfFile(name = 'book.pdf', bytes = new Uint8Array([1, 2, 3])) {
  return new File([bytes], name, { type: 'application/pdf' })
}

function seedExam(status = 'DRAFT') {
  const exam = { id: 'exam-1', programId: 'program-1', title: 'امتحان شامل تجريبي', status, passScore: 60, durationMin: 120 }
  exams.push(exam)
  return exam.id
}

function defaultExtraction() {
  return {
    bookId: 'custom-upload:testbook00000001',
    bookTitle: 'مبادئ المحاسبة',
    totalPages: 4,
    readablePages: 4,
    unreadablePages: [],
    chunks: [{ sourceIndex: 1 }],
  }
}

function defaultGeneration() {
  return {
    questions: [
      {
        type: 'MCQ',
        text: 'أي مما يلي يُعد من الأصول المتداولة؟',
        options: ['النقدية', 'المباني', 'براءات الاختراع', 'الشهرة'],
        correctAnswer: '0',
        sourceEvidence: 'الأصول المتداولة هي الموارد الاقتصادية التي تتوقع المنشأة تحويلها إلى نقد.',
      },
      {
        type: 'TF',
        text: 'الالتزامات المتداولة تستحق السداد خلال سنة مالية واحدة.',
        options: ['صح', 'خطأ'],
        correctAnswer: '0',
        sourceEvidence: 'الالتزامات المتداولة هي الالتزامات التي تستحق السداد خلال سنة مالية واحدة.',
      },
    ],
    requested: 2,
    accepted: 2,
    rejected: [],
    rejectedCount: 0,
    provider: 'GEMINI',
    model: 'gemini-3.5-flash-lite',
  }
}

beforeEach(() => {
  exams = []
  questions = []
  qSeq = 0
  extractResult = defaultExtraction()
  extractError = null
  generateResult = defaultGeneration()
  generateError = null
})

describe('POST .../questions/from-custom-book', () => {
  test('404 for a missing exam, 409 for a published one', async () => {
    const missing = await route.POST(fileReq('nope', pdfFile()), ctx('nope'))
    expect(missing.status).toBe(404)
    const id = seedExam('READY')
    const published = await route.POST(fileReq(id, pdfFile()), ctx(id))
    expect(published.status).toBe(409)
  })

  test('400 without a file, for a non-PDF, and for an oversized file', async () => {
    const id = seedExam()
    expect((await route.POST(fileReq(id, null), ctx(id))).status).toBe(400)
    expect((await route.POST(fileReq(id, pdfFile('book.txt')), ctx(id))).status).toBe(400)
    const big = new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'big.pdf', { type: 'application/pdf' })
    expect((await route.POST(fileReq(id, big), ctx(id))).status).toBe(400)
  })

  test('422 when the file is not a readable PDF', async () => {
    const id = seedExam()
    extractError = new Error('CUSTOM_BOOK_NOT_A_PDF')
    const res = await route.POST(fileReq(id, pdfFile()), ctx(id))
    expect(res.status).toBe(422)
    expect((await res.json()).error).toContain('ليس PDF صالحاً')
    expect(questions).toHaveLength(0)
  })

  test('422 with the extraction report when no chunk survives reading', async () => {
    const id = seedExam()
    extractResult = { ...defaultExtraction(), chunks: [], readablePages: 0, unreadablePages: [{ page: 1, reason: 'NO_EXTRACTABLE_TEXT' }] }
    const res = await route.POST(fileReq(id, pdfFile()), ctx(id))
    const body = await res.json()
    expect(res.status).toBe(422)
    expect(body.extraction.unreadablePages).toHaveLength(1)
    expect(questions).toHaveLength(0)
  })

  test('422 when generation finds the source insufficient, 502 on a plain AI failure', async () => {
    const id = seedExam()
    const insufficient: any = new Error('مصادر الكتاب غير كافية لتوليد أسئلة موثّقة')
    insufficient.code = 'INSUFFICIENT_SOURCE'
    generateError = insufficient
    expect((await route.POST(fileReq(id, pdfFile()), ctx(id))).status).toBe(422)
    generateError = new Error('AI exploded')
    expect((await route.POST(fileReq(id, pdfFile()), ctx(id))).status).toBe(502)
    expect(questions).toHaveLength(0)
  })

  test('422 when generation yields zero savable questions', async () => {
    const id = seedExam()
    generateResult = { ...defaultGeneration(), questions: [], accepted: 0, rejectedCount: 2 }
    const res = await route.POST(fileReq(id, pdfFile()), ctx(id))
    expect(res.status).toBe(422)
    expect(questions).toHaveLength(0)
  })

  test('happy path saves PENDING_REVIEW with source CUSTOM_BOOK and continues the order', async () => {
    const id = seedExam()
    questions.push({
      id: 'q-old', examId: id, order: 3, type: 'MCQ', text: 'سؤال قديم؟',
      options: JSON.stringify(['أ', 'ب', 'ج']), correctAnswer: '0', source: 'MANUAL', status: 'PENDING_REVIEW',
    })
    const res = await route.POST(fileReq(id, pdfFile()), ctx(id))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.imported).toBe(2)
    expect(body.source).toBe('CUSTOM_BOOK')
    expect(body.extraction.bookTitle).toBe('مبادئ المحاسبة')
    expect(body.extraction.totalPages).toBe(4)
    const saved = questions.filter((q) => q.source === 'CUSTOM_BOOK')
    expect(saved).toHaveLength(2)
    expect(saved.map((q) => q.order)).toEqual([4, 5])
    expect(saved.every((q) => q.status === 'PENDING_REVIEW')).toBe(true)
    expect(saved.every((q) => q.sourceBookId === 'custom-upload:testbook00000001')).toBe(true)
    expect(saved[0].sourceEvidence).toContain('الأصول المتداولة')
  })
})
