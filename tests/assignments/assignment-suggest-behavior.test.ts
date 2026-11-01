import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { NextRequest } from 'next/server'

/**
 * اختبارات سلوكية حقيقية لمسار اقتراح الواجبات (PR #168):
 *  - توليد الفصل الثالث (بحث/مشروع) يستفيد من مصادر الفصلين الأول والثاني،
 *    بينما يبقى فصل الواجب نفسه مثبّتًا على الثالث من الطلب الموثوق.
 *  - الفصل الذي يعيده الذكاء لا يستطيع تجاوز الفصل المطلوب أبدًا.
 *  - كتالوج الفصل الثالث يعرض وحدات الفصول السابقة.
 *  - اقتراحان بالعنوان نفسه لوحدتين مختلفتين يُحفظان مستقلين عبر مسار الحفظ.
 * تُقاد المعالجات الحقيقية للمسارين بقاعدة بيانات ذاكرية ونموذج ذكاء مُتحكَّم فيه.
 */

const program = { id: 'prog1', titleAr: 'برنامج تجريبي', titleEn: '', category: 'DIPLOMA', description: '' }
const units = [
  { id: 'u1', programId: 'prog1', semester: 1, title: 'وحدة الفصل الأول', order: 1, sourceBookId: 'b1', chunkStartIndex: 0, chunkEndIndex: 0 },
  { id: 'u2', programId: 'prog1', semester: 2, title: 'وحدة الفصل الثاني', order: 2, sourceBookId: 'b1', chunkStartIndex: 1, chunkEndIndex: 1 },
]
const chunks = [
  { id: 'c0', bookId: 'b1', index: 0 },
  { id: 'c1', bookId: 'b1', index: 1 },
]
const knowledge = [
  { id: 'k1', programId: 'prog1', kbVersion: 2, chunkId: 'c0', category: 'CONCEPT', title: 'مفهوم الفصل الأول', summary: 'ملخص المفهوم الأول', excerpt: 'مقتطف المفهوم الأول', importance: 5, pageStart: 1, pageEnd: 2 },
  { id: 'k2', programId: 'prog1', kbVersion: 2, chunkId: 'c1', category: 'CONCEPT', title: 'مفهوم الفصل الثاني', summary: 'ملخص المفهوم الثاني', excerpt: 'مقتطف المفهوم الثاني', importance: 5, pageStart: 3, pageEnd: 4 },
]
const createdAssignments: any[] = []

function matchesWhere(row: any, where: any): boolean {
  for (const [key, cond] of Object.entries(where || {})) {
    if (cond && typeof cond === 'object') {
      const c: any = cond
      if (Array.isArray(c.in) && !c.in.includes(row[key])) return false
      if (Array.isArray(c.notIn) && c.notIn.includes(row[key])) return false
      if (c.gte != null && !(row[key] >= c.gte)) return false
      if (c.lte != null && !(row[key] <= c.lte)) return false
    } else if (row[key] !== cond) return false
  }
  return true
}

const fakeDb = {
  program: {
    findUnique: async ({ where }: any) => (where.id === program.id ? program : null),
  },
  unit: {
    findMany: async ({ where }: any) => units.filter((u) => matchesWhere(u, where)),
    findFirst: async ({ where }: any) => units.find((u) => matchesWhere(u, where)) || null,
  },
  bookChunk: {
    findMany: async ({ where }: any) => chunks.filter((c) => c.bookId === where.bookId && c.index >= where.index.gte && c.index <= where.index.lte),
  },
  bookKnowledgeItem: {
    findMany: async ({ where }: any) => knowledge.filter((k) => matchesWhere(k, where)),
  },
  programAssignment: {
    findMany: async ({ where }: any) => createdAssignments.filter((a) => a.programId === where.programId),
    findUnique: async ({ where }: any) => createdAssignments.find((a) => a.id === where.id) || null,
    create: async ({ data }: any) => {
      const row = { id: `a${createdAssignments.length + 1}`, createdAt: new Date(), updatedAt: new Date(), ...data }
      createdAssignments.push(row)
      return row
    },
  },
  enrollment: { findMany: async () => [] },
}

// نموذج ذكاء مُتحكَّم فيه: يقترح واجبًا واحدًا يستشهد بأول مصدر في موجهه،
// ويعيد فصلًا خاطئًا عمدًا (${modelSemester}) لإثبات أن الخادم لا يثق به.
let modelSemester = 1
let modelSourceFormat: 'id' | 'index' | 'invalid' = 'id'
const textAiCompleteJson = async (input: any) => {
  const prompt = String(input?.history?.[0]?.text || '')
  const firstId = prompt.match(/id=([A-Za-z0-9_-]+)/)?.[1] || ''
  return JSON.stringify([{
    title: 'واجب بحثي موثق بالمصادر الأصلية المحددة',
    description: 'اكتب واجبًا أكاديميًا موثقًا يستند إلى عناصر المعرفة المرفقة حصرًا مع الاستشهاد بصفحات المصدر كما وردت في المراجع المعروضة أمامك الآن.',
    type: 'REPORT',
    semester: modelSemester,
    points: 15,
    weight: 10,
    rubric: 'التوثيق بالمصادر ٥٠٪، التحليل ٥٠٪',
    sourceKnowledgeIds: [firstId],
  }])
}

mock.module('@/lib/db', () => ({ db: fakeDb }))
mock.module('@/lib/auth', () => ({ requireAdmin: async () => ({ id: 'admin1', role: 'ADMIN', email: 'a@t.st' }) }))
mock.module('@/lib/text-ai', () => ({ textAiCompleteJson }))
mock.module('@/lib/notify', () => ({ audit: async () => {}, notify: async () => {} }))
mock.module('@/lib/mailer', () => ({ emailAssignmentGraded: async () => {}, emailAssignmentPublished: async () => {} }))
mock.module('@/lib/storage', () => ({ getStorageDownloadPathForKey: (k: string) => k }))
mock.module('@prisma/client', () => ({ Prisma: {} }))
mock.module('@/lib/knowledge-bank', () => ({
  cleanAcademicGeneratedText: (s: unknown) => String(s || '').trim(),
  looksLikeBrokenAcademicOutput: () => false,
}))
mock.module('@/lib/academic-output-quality', () => ({
  cleanAcademicOutput: (s: unknown) => String(s || '').trim(),
  looksLikeBrokenGeneratedArabic: () => false,
  conciseAcademicLabel: (s: unknown) => String(s || '').trim().slice(0, 160),
  sanitizeAcademicLabelList: (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x)) : []),
}))

let suggestGET: any
let suggestPOST: any
let savePOST: any
beforeAll(async () => {
  const suggest = await import('../../src/app/api/admin/assignments/suggest/route')
  const save = await import('../../src/app/api/admin/assignments/route')
  suggestGET = suggest.GET
  suggestPOST = suggest.POST
  savePOST = save.POST
})

function postReq(url: string, body: unknown) {
  return new NextRequest(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

describe('assignment suggestions: semester scope and pinning (behavioral)', () => {
  test('semester-3 generation is grounded in semester 1+2 units while the assignment semester stays 3', async () => {
    modelSemester = 1 // النموذج يحاول إعادة الفصل الأول
    const res = await suggestPOST(postReq('http://t/api/admin/assignments/suggest', { programId: 'prog1', semester: 3 }))
    const data = await res.json()
    expect(res.status).toBe(200)
    const unitIds = (data.suggestions || []).map((s: any) => s.unitId).sort()
    expect(unitIds).toEqual(['u1', 'u2'])
    for (const s of data.suggestions) {
      expect(s.semester).toBe(3)
      expect(s.sourceKnowledgeIds.length).toBeGreaterThan(0)
    }
    const byUnit = Object.fromEntries(data.suggestions.map((s: any) => [s.unitId, s.sourceKnowledgeIds]))
    expect(byUnit.u1).toEqual(['k1'])
    expect(byUnit.u2).toEqual(['k2'])
    expect(data.coverage).toEqual({ eligibleUnits: 2, coveredUnits: 2, failedUnits: [] })
  })

  test('a model-returned semester never overrides the requested semester', async () => {
    modelSemester = 3 // النموذج يحاول إعادة الفصل الثالث لطلب فصل أول
    const res = await suggestPOST(postReq('http://t/api/admin/assignments/suggest', { programId: 'prog1', semester: 1, unitId: 'u1' }))
    const data = await res.json()
    expect(res.status).toBe(200)
    expect(data.suggestions).toHaveLength(1)
    expect(data.suggestions[0].semester).toBe(1)
    expect(data.suggestions[0].unitId).toBe('u1')
  })

  test('semester-3 catalog lists the earlier semesters units as research sources', async () => {
    const res = await suggestGET(new NextRequest('http://t/api/admin/assignments/suggest?programId=prog1&semester=3'))
    const data = await res.json()
    expect(res.status).toBe(200)
    expect((data.units || []).map((u: any) => u.unitId).sort()).toEqual(['u1', 'u2'])
  })

  test('semester-1 catalog stays limited to semester-1 units', async () => {
    const res = await suggestGET(new NextRequest('http://t/api/admin/assignments/suggest?programId=prog1&semester=1'))
    const data = await res.json()
    expect((data.units || []).map((u: any) => u.unitId)).toEqual(['u1'])
  })

  test('same-title suggestions for two different units save independently', async () => {
    const base = {
      programId: 'prog1', semester: 3, type: 'REPORT', points: 15, weight: 10,
      title: 'عنوان مكرر مقصود للاختبار السلوكي الكامل هنا', description: 'وصف الواجب الموثق بالمصادر الأصلية للوحدة المرجعية المحددة حصرًا دون أي مصادر خارجية أخرى.',
      dueDays: null, dueAt: null, rubric: 'التوثيق ١٠٠٪', status: 'DRAFT',
    }
    const r1 = await savePOST(postReq('http://t/api/admin/assignments', { ...base, unitId: 'u1', sourceKnowledgeIds: ['k1'] }))
    const r2 = await savePOST(postReq('http://t/api/admin/assignments', { ...base, unitId: 'u2', sourceKnowledgeIds: ['k2'] }))
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)
    const mine = createdAssignments.filter((a) => a.title === base.title)
    expect(mine).toHaveLength(2)
    expect(mine.map((a) => a.unitId).sort()).toEqual(['u1', 'u2'])
  })
})
