/// <reference types="bun-types" />
import { beforeEach, describe, expect, mock, test } from 'bun:test'

type EnrollmentRow = { userId: string; programId: string; status: string }
type BookChunkRow = {
  id: string
  bookId: string
  programId: string
  index: number
  pageStart?: number
  pageEnd?: number
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
let requestedChunkProgramIds: string[] = []
let requestedKnowledgeProgramIds: string[] = []
let lastBookChunkFindManyArgs: any = null

const books: Record<string, { title: string }> = {
  'book-a': { title: 'علم النفس المعرفي' },
  'book-b': { title: 'كتاب البرنامج الآخر' },
}

const programs: Record<string, any> = {
  'program-a': {
    id: 'program-a',
    titleAr: 'برنامج الطالب',
    category: 'MASTERS',
    books: [],
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
    books: [],
    units: [],
    assignments: [],
    studyGuides: [],
    knowledgeItems: [],
    questionBankItems: [],
    programExams: [],
  },
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
      lastBookChunkFindManyArgs = args
      const where = args?.where || {}
      requestedChunkProgramIds = [...(where?.programId?.in || [])]
      return chunks
        .filter((row) => requestedChunkProgramIds.includes(row.programId))
        .map((row) => ({ ...row, book: books[row.bookId] || { title: 'كتاب غير محدد' } }))
    },
  },
  bookKnowledgeItem: {
    findMany: async ({ where }: any) => {
      requestedKnowledgeProgramIds = [...(where?.programId?.in || [])]
      return knowledgeItems
        .filter((row) => requestedKnowledgeProgramIds.includes(row.programId))
        .map((row) => ({ ...row, book: row.bookId ? books[row.bookId] : null }))
    },
  },
}

mock.module('@/lib/db', () => ({ db }))
mock.module('@/lib/ai-context-builder', () => ({ buildScopedProgramCatalogSnapshot: async () => '' }))

const { buildSupervisorContext } = await import('../../src/lib/supervisor-ai')

beforeEach(() => {
  enrollments = [{ userId: 'student-1', programId: 'program-a', status: 'ACTIVE' }]
  chunks = []
  knowledgeItems = []
  requestedChunkProgramIds = []
  requestedKnowledgeProgramIds = []
  lastBookChunkFindManyArgs = null
})

describe('supervisor enrolled book retrieval', () => {
  test('a question about a known concept adds the matching enrolled book excerpt', async () => {
    chunks = [{
      id: 'chunk-1',
      bookId: 'book-a',
      programId: 'program-a',
      index: 2,
      pageStart: 12,
      pageEnd: 14,
      headingPath: 'الفصل الثالث',
      text: 'تشرح هذه الوحدة الإدراك المعرفي باعتباره عملية تنظيم المعلومات وتحليلها قبل اتخاذ القرار.',
    }]
    knowledgeItems = [{
      id: 'knowledge-1',
      bookId: 'book-a',
      programId: 'program-a',
      title: 'الإدراك المعرفي',
      summary: 'الإدراك المعرفي يربط الانتباه بالذاكرة العاملة.',
      excerpt: 'يركز الإدراك المعرفي على استقبال المعلومات وتفسيرها.',
      sourceNote: 'الفصل الثالث',
      pageStart: 15,
      pageEnd: 15,
    }]

    const context = await buildSupervisorContext('student-1', { query: 'اشرح مفهوم الإدراك المعرفي' })

    expect(context).toContain('مقاطع من الكتب المقررة ذات صلة بسؤال الطالب')
    expect(context).toContain('علم النفس المعرفي')
    expect(context).toContain('الفصل الثالث، ص 12-14')
    expect(context).toContain('عملية تنظيم المعلومات')
    expect(context).toContain('استقبال المعلومات وتفسيرها')
  })

  test('an unrelated question keeps the relevant book excerpt block out of context', async () => {
    chunks = [{
      id: 'chunk-1',
      bookId: 'book-a',
      programId: 'program-a',
      index: 0,
      pageStart: 3,
      pageEnd: 3,
      headingPath: 'الفصل الأول',
      text: 'يتناول الكتاب الذاكرة العاملة والانتباه الانتقائي في التعلم.',
    }]

    const context = await buildSupervisorContext('student-1', { query: 'ما علاقة الميزانية الرقمية بالتحول المؤسسي؟' })

    expect(context).not.toContain('مقاطع من الكتب المقررة ذات صلة بسؤال الطالب')
  })

  test('the student does not receive matching excerpts from another program', async () => {
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

    const context = await buildSupervisorContext('student-1', { query: 'اشرح الأمن السيبراني' })

    expect(requestedChunkProgramIds).toEqual(['program-a'])
    expect(requestedKnowledgeProgramIds).toEqual(['program-a'])
    expect(context).not.toContain('كتاب البرنامج الآخر')
    expect(context).not.toContain('الأمن السيبراني يحمي الأنظمة')
    expect(context).not.toContain('مقاطع من الكتب المقررة ذات صلة بسؤال الطالب')
  })
})
