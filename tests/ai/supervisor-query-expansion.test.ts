/// <reference types="bun-types" />
import { beforeEach, describe, expect, mock, test } from 'bun:test'

type EnrollmentRow = { userId: string; programId: string; status: string }
type BookChunkRow = {
  id: string
  bookId: string
  programId: string
  index: number
  pageStart: number
  pageEnd: number
  headingPath?: string | null
  text: string
}
type KnowledgeRow = {
  id: string
  bookId?: string | null
  programId: string
  title: string
  summary: string
  excerpt?: string | null
  keywords?: string | null
  sourceNote?: string | null
  pageStart?: number | null
  pageEnd?: number | null
}

let enrollments: EnrollmentRow[] = []
let chunks: BookChunkRow[] = []
let knowledgeItems: KnowledgeRow[] = []
let textAiCalls = 0
let textAiMode: 'success' | 'throw' | 'unused' = 'unused'
let textAiTerms: string[] = []
let requestedChunkProgramIds: string[] = []

const books: Record<string, { title: string; titleEn?: string }> = {
  'book-a': { title: 'علم النفس المعرفي', titleEn: 'Cognitive Psychology' },
  'book-b': { title: 'كتاب البرنامج الآخر', titleEn: 'Other Program Book' },
}

const programs: Record<string, any> = {
  'program-a': {
    id: 'program-a',
    titleAr: 'برنامج الطالب',
    category: 'MASTERS',
    books: [{ title: books['book-a'].title, titleEn: books['book-a'].titleEn }],
    units: [],
    assignments: [],
    studyGuides: [],
    knowledgeItems: [],
    questionBankItems: [],
    programExams: [],
  },
  'program-b': {
    id: 'program-b',
    titleAr: 'برنامج آخر',
    category: 'MASTERS',
    books: [{ title: books['book-b'].title, titleEn: books['book-b'].titleEn }],
    units: [],
    assignments: [],
    studyGuides: [],
    knowledgeItems: [],
    questionBankItems: [],
    programExams: [],
  },
}

function containsInsensitive(value: unknown, term: unknown): boolean {
  return String(value || '').toLowerCase().includes(String(term || '').toLowerCase())
}

function rowMatchesOr(row: any, orEntries: any[] = []): boolean {
  if (!orEntries.length) return true
  return orEntries.some((entry) => {
    if (entry?.text?.contains != null) return containsInsensitive(row.text, entry.text.contains)
    if (entry?.title?.contains != null) return containsInsensitive(row.title, entry.title.contains)
    if (entry?.summary?.contains != null) return containsInsensitive(row.summary, entry.summary.contains)
    if (entry?.excerpt?.contains != null) return containsInsensitive(row.excerpt, entry.excerpt.contains)
    return false
  })
}

const db: any = {
  user: {
    findUnique: async ({ where }: any) => ({ id: where.id, name: 'طالب الاختبار', role: 'STUDENT', createdAt: new Date() }),
  },
  studentAcademicMemory: { findUnique: async () => null },
  chatMessage: { findMany: async () => [] },
  admissionApplication: { findFirst: async () => null },
  thesisSubmission: { findFirst: async () => null },
  program: { findMany: async () => [] },
  enrollment: {
    findMany: async ({ where }: any) => enrollments
      .filter((row) => row.userId === where.userId && where.status.in.includes(row.status))
      .map((row) => ({ ...row, program: programs[row.programId] })),
  },
  bookChunk: {
    findMany: async (args: any) => {
      const where = args?.where || {}
      requestedChunkProgramIds = [...(where?.programId?.in || [])]
      return chunks
        .filter((row) => requestedChunkProgramIds.includes(row.programId))
        .filter((row) => rowMatchesOr(row, where.OR))
        .slice(0, Math.min(Number(args?.take || 40), 40))
        .map((row) => ({ ...row, book: books[row.bookId] || { title: 'كتاب غير محدد' } }))
    },
  },
  bookKnowledgeItem: {
    findMany: async (args: any) => {
      const where = args?.where || {}
      const programIds = [...(where?.programId?.in || [])]
      return knowledgeItems
        .filter((row) => programIds.includes(row.programId))
        .filter((row) => rowMatchesOr(row, where.OR))
        .slice(0, Math.min(Number(args?.take || 30), 30))
        .map((row) => ({ ...row, book: row.bookId ? books[row.bookId] : null }))
    },
  },
}

mock.module('@/lib/db', () => ({ db }))
mock.module('@/lib/ai-context-builder', () => ({ buildScopedProgramCatalogSnapshot: async () => '' }))
mock.module('@/lib/text-ai', () => ({
  textAiCompleteJson: async () => {
    textAiCalls += 1
    if (textAiMode === 'throw') throw new Error('mock expansion failed')
    return JSON.stringify({ terms: textAiTerms })
  },
}))

const { buildSupervisorContext } = await import('../../src/lib/supervisor-ai')

beforeEach(() => {
  enrollments = [{ userId: 'student-1', programId: 'program-a', status: 'ACTIVE' }]
  chunks = []
  knowledgeItems = []
  textAiCalls = 0
  textAiMode = 'unused'
  textAiTerms = []
  requestedChunkProgramIds = []
})

describe('supervisor query expansion retrieval', () => {
  test('uses mocked expansion terms when the original question terms do not match the enrolled book', async () => {
    textAiMode = 'success'
    textAiTerms = ['الإدراك المعرفي', 'cognition']
    chunks = [{
      id: 'chunk-1',
      bookId: 'book-a',
      programId: 'program-a',
      index: 2,
      pageStart: 12,
      pageEnd: 14,
      headingPath: 'الفصل الثالث',
      text: 'يفسر الإدراك المعرفي استقبال المعلومات وتنظيمها وتحليلها داخل الذاكرة العاملة.',
    }]

    const context = await buildSupervisorContext('student-1', { query: 'اشرح لي المعالجة الذهنية' })

    expect(textAiCalls).toBe(1)
    expect(context).toContain('مقاطع من الكتب المقررة ذات صلة بسؤال الطالب')
    expect(context).toContain('علم النفس المعرفي')
    expect(context).toContain('الإدراك المعرفي')
  })

  test('does not call AI expansion when the first retrieval attempt finds a matching snippet', async () => {
    textAiMode = 'throw'
    chunks = [{
      id: 'chunk-direct',
      bookId: 'book-a',
      programId: 'program-a',
      index: 0,
      pageStart: 4,
      pageEnd: 4,
      headingPath: 'الفصل الأول',
      text: 'يربط الإدراك المعرفي الانتباه بالذاكرة العاملة واتخاذ القرار.',
    }]

    const context = await buildSupervisorContext('student-1', { query: 'ما هو الإدراك المعرفي؟' })

    expect(textAiCalls).toBe(0)
    expect(context).toContain('مقاطع من الكتب المقررة ذات صلة بسؤال الطالب')
    expect(context).toContain('يربط الإدراك المعرفي')
  })

  test('continues without a snippet block when AI expansion throws', async () => {
    textAiMode = 'throw'
    chunks = [{
      id: 'chunk-unmatched',
      bookId: 'book-a',
      programId: 'program-a',
      index: 1,
      pageStart: 9,
      pageEnd: 9,
      headingPath: 'الفصل الثاني',
      text: 'تتناول هذه الصفحة الانتباه الانتقائي والذاكرة العاملة في مواقف التعلم.',
    }]

    const context = await buildSupervisorContext('student-1', { query: 'اشرح مصطلحا لا يظهر في الكتاب' })

    expect(textAiCalls).toBe(1)
    expect(context).not.toContain('مقاطع من الكتب المقررة ذات صلة بسؤال الطالب')
    expect(context).toContain('برامج المستخدم المسجل بها ومراجعها المعتمدة')
  })

  test('does not expose another program book even when expanded terms match it', async () => {
    textAiMode = 'success'
    textAiTerms = ['الأمن السيبراني']
    chunks = [{
      id: 'chunk-other',
      bookId: 'book-b',
      programId: 'program-b',
      index: 0,
      pageStart: 21,
      pageEnd: 21,
      headingPath: 'فصل الحماية',
      text: 'الأمن السيبراني يحمي الأنظمة والشبكات من الاختراقات والهجمات.',
    }]

    const context = await buildSupervisorContext('student-1', { query: 'اشرح حماية الشبكات' })

    expect(textAiCalls).toBe(1)
    expect(requestedChunkProgramIds).toEqual(['program-a'])
    expect(context).not.toContain('كتاب البرنامج الآخر')
    expect(context).not.toContain('الأمن السيبراني يحمي الأنظمة')
    expect(context).not.toContain('مقاطع من الكتب المقررة ذات صلة بسؤال الطالب')
  })
})
