import { beforeEach, describe, expect, mock, test } from 'bun:test'

// Guard U12/M10: a FAILED book chunk (re-extracted, re-analysis failed)
// keeps stale knowledge items from its previous text. Generation and
// assignment suggestion must exclude FAILED chunks exactly like
// scopedKnowledge does (status: { not: 'FAILED' }).

const chunks = [
  { id: 'C0', bookId: 'B1', index: 0, status: 'ANALYZED', pageStart: 1, pageEnd: 5, headingPath: '', text: 'نص المقطع صفر' },
  { id: 'C1', bookId: 'B1', index: 1, status: 'FAILED', pageStart: 6, pageEnd: 9, headingPath: '', text: 'نص قديم قبل إعادة الاستخراج' },
  { id: 'C2', bookId: 'B1', index: 2, status: 'ANALYZED', pageStart: 10, pageEnd: 12, headingPath: '', text: 'نص المقطع اثنان' },
]
const items = [
  { id: 'K0', bookId: 'B1', programId: 'P1', chunkId: 'C0', kbVersion: 2, category: 'CONCEPT', title: 'مفهوم صفر', summary: 'ملخص صفر', excerpt: 'مقتطف صفر', pageStart: 1, pageEnd: 5, importance: 5, createdAt: new Date(1) },
  { id: 'K1', bookId: 'B1', programId: 'P1', chunkId: 'C1', kbVersion: 2, category: 'CONCEPT', title: 'مفهوم قديم', summary: 'ملخص قديم', excerpt: 'مقتطف قديم', pageStart: 6, pageEnd: 9, importance: 5, createdAt: new Date(2) },
  { id: 'K2', bookId: 'B1', programId: 'P1', chunkId: 'C2', kbVersion: 2, category: 'CONCEPT', title: 'مفهوم اثنان', summary: 'ملخص اثنان', excerpt: 'مقتطف اثنان', pageStart: 10, pageEnd: 12, importance: 5, createdAt: new Date(3) },
]
const unitRow: any = {
  id: 'U1', programId: 'P1', title: 'وحدة الاختبار', status: 'DRAFT', semester: 1, order: 1,
  sourceBookId: 'B1', chunkStartIndex: 0, chunkEndIndex: 2, outlineSectionId: 'OS1',
  content: null, summary: 'ملخص الوحدة', objectives: '[]', generationVersion: 0,
  program: { id: 'P1', titleAr: 'برنامج الاختبار', titleEn: 'Test Program' },
}

function matches(row: any, where: any): boolean {
  if (!where) return true
  for (const [key, cond] of Object.entries<any>(where)) {
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      if ('in' in cond) { if (!cond.in.includes(row[key])) return false; continue }
      if ('notIn' in cond) { if (cond.notIn.includes(row[key])) return false; continue }
      if ('not' in cond) { if (row[key] === cond.not) return false; continue }
      if ('gte' in cond || 'lte' in cond) {
        if (cond.gte != null && !(row[key] >= cond.gte)) return false
        if (cond.lte != null && !(row[key] <= cond.lte)) return false
        continue
      }
      continue
    }
    if (row[key] !== cond) return false
  }
  return true
}

let capturedGenerateArgs: any = null
let capturedPrompts: string[] = []

const dbMock: any = {
  bookChunk: { findMany: async ({ where }: any = {}) => chunks.filter((c) => matches(c, where)) },
  bookKnowledgeItem: { findMany: async ({ where }: any = {}) => items.filter((i) => matches(i, where)) },
  unit: {
    findUnique: async ({ where }: any) => (where.id === 'U1' ? unitRow : null),
    findMany: async ({ where }: any = {}) => [unitRow].filter((u) => matches(u, where)),
    update: async ({ data }: any) => ({ ...unitRow, ...data }),
  },
  program: { findUnique: async ({ where }: any) => (where.id === 'P1' ? { id: 'P1', titleAr: 'برنامج الاختبار', titleEn: 'Test Program', category: 'MASTERS', description: '' } : null) },
  programAssignment: { findMany: async () => [] },
  programStudyGuide: {
    findFirst: async () => null,
    create: async ({ data }: any) => ({ id: 'G1', ...data }),
    update: async () => ({}),
  },
  unitGenerationJob: {
    findFirst: async () => null,
    create: async () => ({ id: 'JOB1' }),
    update: async () => ({}),
  },
  $transaction: async (fn: any) => fn(dbMock),
}
mock.module('@/lib/db', () => ({ db: dbMock }))
mock.module('@/lib/auth', () => ({ requireAdmin: async () => ({ id: 'admin-1', name: 'الأدمن', role: 'ADMIN' }) }))
mock.module('@/lib/notify', () => ({ audit: async () => {} }))
mock.module('@/lib/outline-units', () => ({
  generateUnitContentWithAi: async (args: any) => {
    capturedGenerateArgs = args
    return { summary: 'ملخص مولد', objectives: ['هدف'], content: [{ title: 'قسم', body: 'محتوى', sourceKnowledgeIds: [args.knowledge[0]?.id], sourceChunkIndexes: [0] }] }
  },
  buildUnitStudyGuideDraft: (args: any) => ({
    title: 'دليل الدراسة', overview: 'نظرة', objectives: [], keyTerms: [],
    sections: [{ title: 'قسم' }], activities: [], discussionQuestions: [],
    sourceKnowledgeIds: args.knowledge.map((k: any) => k.id),
  }),
  validateStudyGuideSources: (ids: string[], valid: string[]) => ids.filter((id) => valid.includes(id)),
  providerUnavailableStatus: () => null,
}))
mock.module('@/lib/text-ai', () => ({
  textAiCompleteJson: async (args: any) => {
    const prompt = String(args?.history?.[0]?.text || '')
    capturedPrompts.push(prompt)
    const ids = [...prompt.matchAll(/id=(K\d+)/g)].map((m) => m[1])
    return JSON.stringify([{ title: 'واجب مقترح موثق', description: 'وصف الواجب مستند إلى المصادر المذكورة صفحات 1-12', type: 'REPORT', semester: 1, points: 10, weight: 10, rubric: 'معيار تقييم', unitId: 'U1', sourceKnowledgeIds: ids }])
  },
}))
mock.module('@/lib/knowledge-bank', () => ({
  cleanAcademicGeneratedText: (v: any) => String(v || ''),
  looksLikeBrokenAcademicOutput: () => false,
}))
mock.module('@/lib/academic-output-quality', () => ({
  conciseAcademicLabel: (v: any, fallback = '') => String(v || fallback).slice(0, 80),
  sanitizeAcademicLabelList: (values: any) => (Array.isArray(values) ? values.map((x) => String(x)) : []),
}))

const generateRoute = await import('@/app/api/admin/program-units/[unitId]/generate/route')
const suggestRoute = await import('@/app/api/admin/assignments/suggest/route')
const { NextRequest } = await import('next/server')

beforeEach(() => { capturedGenerateArgs = null; capturedPrompts = [] })

describe('FAILED-chunk grounding exclusion (U12)', () => {
  test('unit content generation receives only non-FAILED chunks and their items', async () => {
    const req = new NextRequest('http://localhost/api/admin/program-units/U1/generate', { method: 'POST', body: JSON.stringify({}) })
    const res = await generateRoute.POST(req, { params: Promise.resolve({ unitId: 'U1' }) })
    expect(res.status).toBe(200)
    const chunkIds = (capturedGenerateArgs.chunks as any[]).map((c) => c.id)
    const knowledgeIds = (capturedGenerateArgs.knowledge as any[]).map((k) => k.id)
    expect(chunkIds).toEqual(['C0', 'C2'])
    expect(knowledgeIds).toEqual(['K0', 'K2'])
    expect(knowledgeIds).not.toContain('K1')
  })

  test('assignment suggestion never grounds on the FAILED chunk item', async () => {
    const req = new NextRequest('http://localhost/api/admin/assignments/suggest', { method: 'POST', body: JSON.stringify({ programId: 'P1', semester: 1, unitId: 'U1' }) })
    const res = await suggestRoute.POST(req)
    expect(capturedPrompts.length).toBeGreaterThan(0)
    for (const prompt of capturedPrompts) {
      expect(prompt).toContain('id=K0')
      expect(prompt).not.toContain('id=K1')
    }
    if (res.status === 200) {
      const body = await res.json()
      const cited = (body.suggestions || []).flatMap((s: any) => s.sourceKnowledgeIds || [])
      expect(cited).not.toContain('K1')
    }
  })
})
