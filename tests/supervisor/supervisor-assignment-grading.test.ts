/// <reference types="bun-types" />
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { NextRequest } from 'next/server'

// ===== حالة الاختبار القابلة للتبديل =====
let currentUser: any = { id: 'sup-1', role: 'SUPERVISOR', name: 'المشرف' }
let admissionSupervisorId: string | null = 'sup-1'
let textAiResponse = ''
let extractedText: string | null = 'نص إجابة الطالب المكتوب في الملف المرفق بشكل واضح ومفصل.'
const updateCalls: any[] = []
const assignmentCreates: any[] = []
const notifyCalls: any[] = []
const emailCalls: any[] = []
const auditCalls: any[] = []
let textAiCalls = 0
let lastGradingPrompt = ''
let mockSourceUnit = false
let mockMissingOriginal = false
let mockCorruptedReference = false
let fileBufferToReturn: Buffer | null = null
let bookReaderCalls = 0
let bookOcrCalls = 0
let sourcePdfBuffer: Buffer | null = null
let nativeSourcePages: Record<number, string> = {}
let ocrSourcePages: Record<number, string> = {}
let ocrPageRequests: number[][] = []

const submission: any = {
  id: 'sub-1',
  userId: 'student-1',
  answerText: 'إجابة الطالب النصية: تحليل لعملية الاستقطاب مع أمثلة من سوق العمل المحلي.',
  fileName: null,
  fileStorageKey: null,
  fileUrl: null,
  data: null,
  fileStorageProvider: null,
  mimeType: null,
  status: 'SUBMITTED',
  score: null,
  feedback: null,
  submittedAt: new Date(),
  assignment: {
    id: 'assign-1',
    programId: 'prog-1',
    unitId: null,
    title: 'التكليف الثاني',
    description: 'صمّم خطة عملية للبحث عن الكفاءات.',
    semester: 1,
    points: 100,
    rubric: 'الاستناد إلى مصادر الوحدة 30%، جودة التحليل 30%، التطبيق المهني 25%، وضوح العرض 15%',
  },
  user: { id: 'student-1', name: 'محمود', email: 'student@example.com' },
}

const submissionPdf: any = {
  ...submission,
  id: 'sub-pdf',
  answerText: '',
  fileName: 'answer.pdf',
  fileStorageKey: 'answers/sub-pdf.pdf',
  fileUrl: null,
  data: null,
  fileStorageProvider: 'LOCAL',
  mimeType: 'application/pdf',
}

const db: any = {
  assignmentSubmission: {
    findUnique: async (args: any) => (args?.where?.id === 'sub-pdf' ? submissionPdf : submission),
    update: async (_args: any) => {
      updateCalls.push(_args)
      return { ...submission, score: _args.data.score, feedback: _args.data.feedback, status: _args.data.status }
    },
  },
  admissionApplication: {
    findFirst: async () => ({ id: 'app-1', supervisorId: admissionSupervisorId, supervisionMode: 'HYBRID' }),
    count: async (args: any) => args.where.supervisorId === 'other-supervisor' ? 0 : 1,
    findMany: async (args: any) => args.where.supervisorId === 'other-supervisor' ? [] : [{
      id: 'app-1', userId: 'student-1', fullName: 'محمود',
    }].slice(args.skip, args.skip + args.take),
  },
  program: { findUnique: async () => ({ id: 'prog-1', titleAr: 'إدارة الموارد البشرية' }) },
  programAssignment: {
    findUnique: async () => null,
    create: async (args: any) => { assignmentCreates.push(args.data); return { id: 'assign-new', ...args.data } },
  },
  unit: {
    findUnique: async () => mockSourceUnit ? { id: 'unit-1', title: 'إدارة الكفاءات', sourceBookId: 'book-1', chunkStartIndex: 0, chunkEndIndex: 1 } : null,
    findFirst: async (args: any) => mockSourceUnit && args?.where?.programId === 'prog-1' && args?.where?.id === 'unit-1' ? { id: 'unit-1', semester: 1, sourceBookId: 'book-1', chunkStartIndex: 0, chunkEndIndex: 1 } : null,
    findMany: async () => [],
  },
  bookChunk: { findMany: async () => mockSourceUnit ? [{ id: 'chunk-1', pageStart: 1, pageEnd: 2, text: 'نص كتاب الموارد البشرية عن التخطيط والاستقطاب.' }] : [] },
  bookKnowledgeItem: { findMany: async (args: any) => {
    if (!mockSourceUnit) return []
    const exact = { id: 'ki-exact', title: 'الاستقطاب الموثّق', summary: 'المصدر الأصلي عن معايير الاختيار والموارد البشرية.', excerpt: 'إجراءات الاستقطاب' }
    const unitExtra = { id: 'ki-other-unit', title: 'تخطيط الكفاءات', summary: 'معلومات إضافية من الوحدة الصحيحة.', excerpt: 'التخطيط' }
    if (args?.where?.id?.in) return mockMissingOriginal ? [] : args.where.id.in.includes(exact.id) ? [exact] : []
    return mockCorruptedReference ? [{ ...unitExtra, summary: ('[غير واضح] محتوى المرجع غير قابل للقراءة. ').repeat(5) }] : [unitExtra]
  } },
  book: { findUnique: async () => mockSourceUnit ? { title: 'كتاب الموارد البشرية', storageProvider: 'LOCAL', storageKey: 'books/book-1.pdf', mimeType: 'application/pdf' } : null },
}

mock.module('@/lib/db', () => ({ db }))
mock.module('@/lib/auth', () => ({
  requireUser: async () => currentUser,
  requireAdmin: async () => {
    if (currentUser.role === 'ADMIN') return currentUser
    throw new Error('UNAUTHORIZED')
  },
}))
mock.module('@/lib/text-ai', () => ({
  textAiCompleteJson: async (args: any) => {
    textAiCalls += 1
    lastGradingPrompt = String(args?.history?.[0]?.text || '')
    return textAiResponse
  },
  textAiCompleteJsonWithMetadata: async (args: any) => {
    textAiCalls += 1
    lastGradingPrompt = String(args?.history?.[0]?.text || '')
    return { text: textAiResponse, provider: 'GEMINI', model: 'test-grading-model' }
  },
}))
mock.module('@/lib/document-extract', () => ({
  extractDocumentText: async () => ({
    text: extractedText || '',
    readable: Boolean(extractedText && extractedText.length >= 40),
    reader: 'PDF',
    note: '',
  }),
  isPdfLike: () => true,
}))
mock.module('@/lib/storage', () => ({
  getFileBufferFromStorageOrBase64: async (args: any) => {
    const buffer = String(args?.key || '').startsWith('books/') ? sourcePdfBuffer : fileBufferToReturn
    return buffer ? { buffer, mimeType: 'application/pdf' } : null
  },
  getStorageDownloadPathForKey: (key: string) => `/api/files/${key}`,
}))
mock.module('@/lib/book-reader', () => ({
  extractNumberedPdfPages: async (_buffer: Buffer, numbers: number[]) => {
    bookReaderCalls += 1
    return numbers.map((n) => ({
      page: n,
      text: Object.prototype.hasOwnProperty.call(nativeSourcePages, n) ? nativeSourcePages[n] : n === 1 ? 'نص صفحة أولى من إجابة الطالب مكتوب بشكل واضح ومفصل ويشرح التحليل والتطبيق المهني.' : '',
      textProvenance: 'NATIVE_TEXT' as const,
    }))
  },
  pagesNeedingOcr: (pages: any[]) => {
    const missing = pages.filter((p) => p.text.trim().length < 80).map((p) => p.page)
    const batches: number[][] = []
    for (let i = 0; i < missing.length; i += 4) batches.push(missing.slice(i, i + 4))
    return batches
  },
  transcribeScannedDocumentWithVision: async (_buffer: Buffer, range: number[]) => {
    bookOcrCalls += 1
    ocrPageRequests.push(range)
    return range.map((p) => ({ page: p, text: Object.prototype.hasOwnProperty.call(ocrSourcePages, p) ? ocrSourcePages[p] : 'نص مقروء بالرؤية من الصفحة المصورة يشرح أمثلة من الواقع.', textProvenance: 'VISION_OCR' as const }))
  },
  planBookChunks: (pages: any[]) => [{ text: pages.map((p) => p.text).filter(Boolean).join(' ') }],
}))
mock.module('@/lib/notify', () => ({
  notify: async (...args: any[]) => {
    notifyCalls.push(args)
  },
  audit: async (...args: any[]) => {
    auditCalls.push(args)
  },
}))
mock.module('@/lib/mailer', () => ({
  emailAssignmentGraded: async (...args: any[]) => {
    emailCalls.push(args)
  },
  emailAssignmentPublished: async (...args: any[]) => {
    emailCalls.push(args)
  },
}))

const validDraft = () =>
  JSON.stringify({
    score: 85,
    criteria: [
      { label: 'الاستناد إلى مصادر الوحدة', points: 25, justification: 'استند إلى مصادر الوحدة مع أمثلة.' },
      { label: 'جودة التحليل', points: 25, justification: 'تحليل متماسك ومرتب.' },
      { label: 'التطبيق المهني', points: 20, justification: 'تطبيق عملي جيد مع نقص في التفاصيل.' },
      { label: 'وضوح العرض', points: 15, justification: 'عرض واضح ومنظم.' },
    ],
    strengths: ['تحليل واضح', 'أمثلة من الواقع'],
    gaps: ['ينقصه تفصيل خطوات التنفيذ'],
    errors: [],
    effortNote: 'يظهر اجتهاد شخصي في التحليل والتطبيق.',
    feedback: 'أحسنت يا محمود، تحليلك واضح وتطبيقك المهني جيد مع أمثلة من الواقع. ينقصك تفصيل خطوات التنفيذ أكثر، وربط كل خطوة بمصدر من الوحدة. خطوتك التالية: أعد صياغة خطة التنفيذ بجدول زمني واضح.',
  })

function postRequest(body: any) {
  return new NextRequest('http://localhost/api/supervisor/assignments', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

describe('AI_OUTPUT_INVALID rejection diagnostics', () => {
  test('classifies malformed JSON without guessing a score', async () => {
    const { classifyAssignmentAiOutput } = await import('@/lib/supervisor-assignment-grading')
    expect(classifyAssignmentAiOutput('{bad json')).toBe('INVALID_JSON')
  })

  test('classifies missing or nonnumeric scores', async () => {
    const { classifyAssignmentAiOutput } = await import('@/lib/supervisor-assignment-grading')
    expect(classifyAssignmentAiOutput(JSON.stringify({ score: null, feedback: 'هذه ملاحظة طويلة وكافية عن الإجابة' }))).toBe('INVALID_SCORE')
    expect(classifyAssignmentAiOutput(JSON.stringify({ score: 'oops', feedback: 'هذه ملاحظة طويلة وكافية عن الإجابة' }))).toBe('INVALID_SCORE')
  })

  test('rejects an empty-string score rather than silently treating it as zero', async () => {
    const { classifyAssignmentAiOutput } = await import('@/lib/supervisor-assignment-grading')
    expect(classifyAssignmentAiOutput(JSON.stringify({ score: '', feedback: 'هذه ملاحظة طويلة وكافية عن الإجابة' }))).toBe('INVALID_SCORE')
  })

  test('classifies broken Arabic output after feedback length validation', async () => {
    const { classifyAssignmentAiOutput } = await import('@/lib/supervisor-assignment-grading')
    expect(classifyAssignmentAiOutput(JSON.stringify({
      score: 80,
      feedback: 'محور معرفي مهم في إجابة الطالب ويحتاج إلى شرح أكاديمي وتطبيق مهني مناسب.',
    }))).toBe('BROKEN_ARABIC')
  })

  test('classifies missing or short feedback', async () => {
    const { classifyAssignmentAiOutput } = await import('@/lib/supervisor-assignment-grading')
    expect(classifyAssignmentAiOutput(JSON.stringify({ score: 80, feedback: 'قصير' }))).toBe('SHORT_FEEDBACK')
  })

  test('valid model output is not classified as rejected', async () => {
    const { classifyAssignmentAiOutput } = await import('@/lib/supervisor-assignment-grading')
    expect(classifyAssignmentAiOutput(validDraft())).toBeNull()
  })

  test('invalid AI output returns 502 without saving grades or sending notices', async () => {
    currentUser = { id: 'sup-1', role: 'SUPERVISOR', name: 'المشرف' }
    admissionSupervisorId = 'sup-1'
    mockSourceUnit = false
    submission.assignment.unitId = null
    submission.answerText = 'إجابة الطالب النصية: تحليل لعملية الاستقطاب مع أمثلة من سوق العمل المحلي.'
    textAiResponse = '{bad json'
    updateCalls.length = 0
    notifyCalls.length = 0
    emailCalls.length = 0
    const route = await import('@/app/api/supervisor/assignments/route')
    const response = await route.POST(postRequest({ action: 'analyze', submissionId: 'sub-1' }))
    expect(response.status).toBe(502)
    expect(updateCalls).toHaveLength(0)
    expect(notifyCalls).toHaveLength(0)
    expect(emailCalls).toHaveLength(0)
  })
})

describe('explicit PDF citations and mathematical source isolation', () => {
  test('accepts Eastern Arabic digits and marked ranges', async () => {
    const { extractExplicitPageCitations } = await import('@/lib/supervisor-assignment-grading')
    expect(extractExplicitPageCitations('راجع ص ٤٥')).toEqual([45])
    expect(extractExplicitPageCitations('من ص 45 إلى 48')).toEqual([45, 46, 47, 48])
    expect(extractExplicitPageCitations('ص 45–48')).toEqual([45, 46, 47, 48])
  })

  test('ignores PO boxes and unmarked years or chapter numbers', async () => {
    const { extractExplicitPageCitations } = await import('@/lib/supervisor-assignment-grading')
    expect(extractExplicitPageCitations('ص.ب 1234، ص ب 100، سنة 2024، السؤال 3، الفصل 4')).toEqual([])
  })

  test('bounds very large ranges without enumerating them', async () => {
    const { extractExplicitPageCitations } = await import('@/lib/supervisor-assignment-grading')
    expect(extractExplicitPageCitations('ص 1-999999')).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  test('changing source points cannot change the isolated score', async () => {
    const { isolateSourceCriterion, DEFAULT_RUBRIC } = await import('@/lib/supervisor-assignment-grading')
    const makeDraft = (sourcePoints: number) => ({
      score: 75, criteria: [
        { label: DEFAULT_RUBRIC[0].label, points: sourcePoints, maxPoints: 30, justification: '' },
        { label: DEFAULT_RUBRIC[1].label, points: 24, maxPoints: 30, justification: '' },
        { label: DEFAULT_RUBRIC[2].label, points: 20, maxPoints: 25, justification: '' },
        { label: DEFAULT_RUBRIC[3].label, points: 12, maxPoints: 15, justification: '' },
      ], feedback: '', strengths: [], gaps: [], errors: [], effortNote: '',
    })
    const a = makeDraft(30), b = makeDraft(0)
    expect(isolateSourceCriterion(a, DEFAULT_RUBRIC, 100, true).status).toBe('ISOLATED')
    expect(isolateSourceCriterion(b, DEFAULT_RUBRIC, 100, true).status).toBe('ISOLATED')
    expect(a.score).toBe(80)
    expect(b.score).toBe(80)
    expect(a.criteria[0].points).toBe(30)
    expect(a.criteria[0].justification).toContain('مُستبعَد')
  })

  test('reports missing breakdown or source criterion without claiming isolation', async () => {
    const { isolateSourceCriterion, DEFAULT_RUBRIC } = await import('@/lib/supervisor-assignment-grading')
    const draft: any = { score: 60, criteria: null, feedback: '', strengths: [], gaps: [], errors: [], effortNote: '' }
    expect(isolateSourceCriterion(draft, DEFAULT_RUBRIC, 100, true).status).toBe('NO_VALID_BREAKDOWN')
    expect(draft.score).toBe(60)
    expect(isolateSourceCriterion(draft, [{ label: 'التحليل', weightPct: 100 }], 100, true).status).toBe('NO_SOURCE_CRITERION')
  })
})

describe('assignment reference readability guard', () => {
  test('detects repeated explicit OCR gaps', async () => {
    const { isUnreadableBookReference } = await import('@/lib/supervisor-assignment-grading')
    const damaged = ('هذه فقرة مرجعية غير مكتملة [غير واضح] وبعض تفاصيل المصدر مفقودة. ').repeat(5)
    expect(isUnreadableBookReference(damaged)).toBe(true)
  })
  test('does not reject valid Arabic, mixed-language or short sources', async () => {
    const { isUnreadableBookReference } = await import('@/lib/supervisor-assignment-grading')
    expect(isUnreadableBookReference('هذا شرح أكاديمي واضح عن التخطيط وإدارة الموارد البشرية مع أمثلة عملية. '.repeat(8))).toBe(false)
    expect(isUnreadableBookReference('Deprivation, Tension Building, Conflict and Post-Crisis. '.repeat(8))).toBe(false)
    expect(isUnreadableBookReference('[غير واضح]')).toBe(false)
  })
})

describe('supervisor assignment grading — rubric and draft normalization', () => {
  test('screenshot rubric parses to 30/30/25/15', async () => {
    const lib = await import('@/lib/supervisor-assignment-grading')
    const criteria = lib.parseRubricCriteria('الاستناد إلى مصادر الوحدة 30%، جودة التحليل 30%، التطبيق المهني 25%، وضوح العرض 15%')
    expect(criteria.map((c: any) => c.weightPct)).toEqual([30, 30, 25, 15])
  })

  test('missing or non-summing rubric falls back to the default', async () => {
    const lib = await import('@/lib/supervisor-assignment-grading')
    expect(lib.parseRubricCriteria(null).map((c: any) => c.weightPct)).toEqual([30, 30, 25, 15])
    expect(lib.parseRubricCriteria('تحليل 40%، عرض 20%').map((c: any) => c.weightPct)).toEqual([30, 30, 25, 15])
  })

  test('valid per-criterion breakdown is kept', async () => {
    const lib = await import('@/lib/supervisor-assignment-grading')
    const draft = lib.normalizeAiDraft(JSON.parse(validDraft()), 100, lib.DEFAULT_RUBRIC)
    expect(draft?.score).toBe(85)
    expect(draft?.criteria?.length).toBe(4)
    expect(draft?.criteria?.reduce((t: number, c: any) => t + c.points, 0)).toBe(85)
  })

  test('breakdown that does not sum to the total is discarded, total kept', async () => {
    const lib = await import('@/lib/supervisor-assignment-grading')
    const raw = JSON.parse(validDraft())
    raw.criteria[0].points = 10
    const draft = lib.normalizeAiDraft(raw, 100, lib.DEFAULT_RUBRIC)
    expect(draft?.score).toBe(85)
    expect(draft?.criteria).toBeNull()
  })

  test('score above assignment points is clamped, short feedback rejected', async () => {
    const lib = await import('@/lib/supervisor-assignment-grading')
    const raw = JSON.parse(validDraft())
    raw.score = 140
    expect(lib.normalizeAiDraft(raw, 100, lib.DEFAULT_RUBRIC)?.score).toBe(100)
    raw.score = 80
    raw.feedback = 'جيد'
    expect(lib.normalizeAiDraft(raw, 100, lib.DEFAULT_RUBRIC)).toBeNull()
  })
})

describe('admin assignment source persistence — verified program/unit/knowledge contract', () => {
  beforeEach(() => {
    currentUser = { id: 'admin-1', role: 'ADMIN', name: 'المدير' }
    mockSourceUnit = true
    mockMissingOriginal = false
    assignmentCreates.length = 0
  })

  const save = (extra: any) => new NextRequest('http://localhost/api/admin/assignments', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      programId: 'prog-1', title: 'واجب إدارة الموارد البشرية', description: 'طبّق معايير الاستقطاب في حالة واقعية مفصلة.',
      semester: 1, points: 100, status: 'DRAFT', unitId: 'unit-1', ...extra,
    }),
  })

  test('verified original source ID is written to assignment JSONB field', async () => {
    const route = await import('@/app/api/admin/assignments/route')
    const res = await route.POST(save({ sourceKnowledgeIds: ['ki-exact'] }))
    expect(res.status).toBe(200)
    expect(assignmentCreates).toHaveLength(1)
    expect(assignmentCreates[0].unitId).toBe('unit-1')
    expect(assignmentCreates[0].sourceKnowledgeIds).toEqual(['ki-exact'])
  })

  test('knowledge ID outside the verified unit is rejected without any write', async () => {
    const route = await import('@/app/api/admin/assignments/route')
    const res = await route.POST(save({ sourceKnowledgeIds: ['ki-outside'] }))
    expect(res.status).toBe(400)
    expect(assignmentCreates).toHaveLength(0)
  })

  test('legacy manual assignment without source/unit still saves without invented provenance', async () => {
    const route = await import('@/app/api/admin/assignments/route')
    const res = await route.POST(save({ unitId: null }))
    expect(res.status).toBe(200)
    expect(assignmentCreates).toHaveLength(1)
    expect(assignmentCreates[0].sourceKnowledgeIds).toBeUndefined()
    expect(assignmentCreates[0].unitId).toBeNull()
  })
})


describe('original PDF citation verification and approval safety', () => {
  beforeEach(() => {
    currentUser = { id: 'sup-1', role: 'SUPERVISOR', name: 'المشرف' }
    admissionSupervisorId = 'sup-1'
    textAiResponse = validDraft()
    textAiCalls = 0
    lastGradingPrompt = ''
    mockSourceUnit = true
    mockMissingOriginal = false
    mockCorruptedReference = false
    submission.assignment.unitId = 'unit-1'
    submission.assignment.sourceKnowledgeIds = null
    submission.assignment.rubric = 'الاستناد إلى مصادر الوحدة 30%، جودة التحليل 30%، التطبيق المهني 25%، وضوح العرض 15%'
    submission.answerText = 'استشهد الطالب بالمرجع ص 1، مع تحليل واضح للعمل.'
    sourcePdfBuffer = null
    fileBufferToReturn = null
    nativeSourcePages = {}
    ocrSourcePages = {}
    ocrPageRequests = []
    bookReaderCalls = 0
    bookOcrCalls = 0
    updateCalls.length = 0
    notifyCalls.length = 0
    emailCalls.length = 0
  })

  async function pdfWithPages(count: number) {
    const { PDFDocument } = await import('pdf-lib')
    const doc = await PDFDocument.create()
    for (let i = 0; i < count; i++) doc.addPage()
    sourcePdfBuffer = Buffer.from(await doc.save())
  }

  const analyze = async () => {
    const route = await import('@/app/api/supervisor/assignments/route')
    const response = await route.POST(postRequest({ action: 'analyze', submissionId: 'sub-1' }))
    expect(response.status).toBe(200)
    return response.json()
  }

  test('native cited page is used without vision', async () => {
    await pdfWithPages(2)
    const result = await analyze()
    expect(result.provenance.citationPages[0].source).toBe('NATIVE_TEXT')
    expect(bookOcrCalls).toBe(0)
    expect(lastGradingPrompt).toContain('صفحة PDF 1 [NATIVE_TEXT]')
  })

  test('unreadable native page invokes vision only for that cited page', async () => {
    await pdfWithPages(3)
    submission.answerText = 'اقتبست من ص 2 في الكتاب الأصلي.'
    nativeSourcePages[2] = '[غير واضح] '.repeat(20)
    const result = await analyze()
    expect(ocrPageRequests).toEqual([[2]])
    expect(result.provenance.citationPages[0].source).toBe('VISION_OCR')
    expect(result.provenance.citationReviewRequired).toBe(true)
    expect(result.provenance.isolationStatus).toBe('NOT_REQUIRED')
  })

  test('OCR failure remains unverified and never labels citation false', async () => {
    await pdfWithPages(2)
    nativeSourcePages[1] = '[غير واضح] '.repeat(20)
    ocrSourcePages[1] = '[غير واضح] '.repeat(20)
    const result = await analyze()
    expect(result.provenance.citationPages[0].source).toBe('UNVERIFIED')
    expect(result.provenance.isolationStatus).toBe('ISOLATED')
    expect(result.draft.criteria[0].justification).toContain('مُستبعَد')
    expect(lastGradingPrompt).toContain('لا تخصم')
  })

  test('readable PDF mismatch is supervisor decision, not an automatic error', async () => {
    await pdfWithPages(2)
    submission.answerText = 'يقول الطالب إن ص 1 تتحدث عن نظرية لا توجد في النص.'
    const result = await analyze()
    expect(result.provenance.citationPages[0].source).toBe('NATIVE_TEXT')
    expect(lastGradingPrompt).toContain('القرار للمشرف')
    expect(result.provenance.isolationStatus).toBe('NOT_REQUIRED')
  })

  test('more than eight citations marks overflow unverified and does not OCR overflow', async () => {
    await pdfWithPages(12)
    submission.answerText = 'راجع ص 1-10'
    const result = await analyze()
    expect(result.provenance.citationPages).toHaveLength(9)
    expect(result.provenance.citationPages[8].source).toBe('UNVERIFIED')
    expect(result.provenance.isolationStatus).toBe('ISOLATED')
    expect(bookOcrCalls).toBe(7)
  })

  test('no explicit citation uses reference ranges, not fabricated student citations', async () => {
    await pdfWithPages(2)
    submission.answerText = 'تحليل مهني دون أي إشارة لصفحات.'
    const result = await analyze()
    expect(result.provenance.citationMode).toBe('REFERENCE_RANGES')
    expect(lastGradingPrompt).toContain('ليست صفحات استشهد بها الطالب')
    expect(bookOcrCalls).toBe(0)
  })

  test('out-of-range citation requires 409 and passes only with explicit supervisor review', async () => {
    await pdfWithPages(2)
    submission.answerText = 'أستشهد بالصفحة ص 99'
    const route = await import('@/app/api/supervisor/assignments/route')
    const request = { action: 'grade', submissionId: 'sub-1', score: 80, feedback: 'راجعت المصدر الأصلي.', status: 'GRADED' }
    expect((await route.POST(postRequest(request))).status).toBe(409)
    expect(textAiCalls).toBe(0)
    expect(bookOcrCalls).toBe(0)
    expect((await route.POST(postRequest({ ...request, sourceReviewed: true }))).status).toBe(200)
  })

  test('overflow citations require 409 without vision during approval', async () => {
    await pdfWithPages(10)
    submission.answerText = 'ص 1-9'
    const route = await import('@/app/api/supervisor/assignments/route')
    expect((await route.POST(postRequest({ action: 'grade', submissionId: 'sub-1', score: 80, feedback: 'تمت المراجعة.', status: 'GRADED' }))).status).toBe(409)
    expect(textAiCalls).toBe(0)
    expect(bookOcrCalls).toBe(0)
  })

  test('locally unreadable citation requires 409 even if vision could recover it', async () => {
    await pdfWithPages(2)
    nativeSourcePages[1] = '[غير واضح] '.repeat(20)
    const route = await import('@/app/api/supervisor/assignments/route')
    expect((await route.POST(postRequest({ action: 'grade', submissionId: 'sub-1', score: 80, feedback: 'تمت المراجعة.', status: 'GRADED' }))).status).toBe(409)
    expect(bookOcrCalls).toBe(0)
  })

  test('scanned student attachment fails closed while plain written answer remains eligible', async () => {
    await pdfWithPages(2)
    submission.answerText = 'إجابة نصية بلا استشهادات.'
    const route = await import('@/app/api/supervisor/assignments/route')
    const request = { action: 'grade', submissionId: 'sub-1', score: 80, feedback: 'تمت مراجعة الإجابة.', status: 'GRADED' }
    expect((await route.POST(postRequest(request))).status).toBe(200)
    updateCalls.length = 0
    const { PDFDocument } = await import('pdf-lib')
    const doc = await PDFDocument.create()
    doc.addPage()
    fileBufferToReturn = Buffer.from(await doc.save())
    nativeSourcePages[1] = ''
    const scannedRequest = { ...request, submissionId: 'sub-pdf' }
    expect((await route.POST(postRequest(scannedRequest))).status).toBe(409)
    expect((await route.POST(postRequest({ ...scannedRequest, sourceReviewed: true }))).status).toBe(200)
    expect(bookOcrCalls).toBe(0)
  })

  test('no source criterion exposes impossible isolation status and strong warning', async () => {
    await pdfWithPages(2)
    submission.answerText = 'راجع ص 99'
    submission.assignment.rubric = 'جودة التحليل 60%، التطبيق المهني 40%'
    const result = await analyze()
    expect(result.provenance.isolationStatus).toBe('NO_SOURCE_CRITERION')
    expect(result.provenance.isolationNote).toContain('لا يمكن عزل أثرها رياضيًا')
  })

  test('invalid model breakdown exposes manual-review-only protection', async () => {
    await pdfWithPages(2)
    submission.answerText = 'راجع ص 99'
    textAiResponse = JSON.stringify({ ...JSON.parse(validDraft()), criteria: [] })
    const result = await analyze()
    expect(result.provenance.isolationStatus).toBe('NO_VALID_BREAKDOWN')
    expect(result.draft.criteria).toBeNull()
    expect(result.draft.score).toBe(85)
  })
})

describe('supervisor assignments route — scope is the gate, analyze never saves', () => {
  beforeEach(() => {
    currentUser = { id: 'sup-1', role: 'SUPERVISOR', name: 'المشرف' }
    admissionSupervisorId = 'sup-1'
    textAiResponse = validDraft()
    textAiCalls = 0
    lastGradingPrompt = ''
    mockSourceUnit = false
    mockMissingOriginal = false
    mockCorruptedReference = false
    submission.assignment.unitId = null
    submission.assignment.sourceKnowledgeIds = null
    fileBufferToReturn = null
    sourcePdfBuffer = null
    nativeSourcePages = {}
    ocrSourcePages = {}
    ocrPageRequests = []
    submission.answerText = 'إجابة الطالب النصية: تحليل لعملية الاستقطاب مع أمثلة من سوق العمل المحلي.'
    submission.assignment.rubric = 'الاستناد إلى مصادر الوحدة 30%، جودة التحليل 30%، التطبيق المهني 25%، وضوح العرض 15%'
    bookReaderCalls = 0
    bookOcrCalls = 0
    updateCalls.length = 0
    notifyCalls.length = 0
    emailCalls.length = 0
    auditCalls.length = 0
  })

  test('assigned supervisor analyzes: draft returned, no DB update, no student notification', async () => {
    const route = await import('@/app/api/supervisor/assignments/route')
    const res = await route.POST(postRequest({ action: 'analyze', submissionId: 'sub-1' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.saved).toBe(false)
    expect(body.draft.score).toBe(85)
    expect(body.draft.feedback).toContain('أحسنت يا محمود')
    expect(updateCalls.length).toBe(0)
    expect(notifyCalls.length).toBe(0)
    expect(emailCalls.length).toBe(0)
    expect(textAiCalls).toBe(1)
  })

  test('supervisor who is not assigned to this student gets 403 and no AI call', async () => {
    admissionSupervisorId = 'sup-OTHER'
    const route = await import('@/app/api/supervisor/assignments/route')
    const res = await route.POST(postRequest({ action: 'analyze', submissionId: 'sub-1' }))
    expect(res.status).toBe(403)
    expect(textAiCalls).toBe(0)
    expect(updateCalls.length).toBe(0)
  })

  test('admin override analyzes and grades, grade notifies and emails the student', async () => {
    currentUser = { id: 'admin-1', role: 'ADMIN', name: 'المدير' }
    admissionSupervisorId = null
    const route = await import('@/app/api/supervisor/assignments/route')
    const graded = await route.POST(
      postRequest({ action: 'grade', submissionId: 'sub-1', score: 80, feedback: 'ملاحظة مفصلة للطالب بعد المراجعة.', status: 'GRADED' })
    )
    expect(graded.status).toBe(200)
    expect(updateCalls.length).toBe(1)
    expect(updateCalls[0].data.score).toBe(80)
    expect(notifyCalls.length).toBe(1)
    expect(emailCalls.length).toBe(1)
    expect(auditCalls.length).toBe(1)
  })

  test('PDF answer is read through the book path: numbered pages, OCR only for empty pages, no single-vision call', async () => {
    const { PDFDocument } = await import('pdf-lib')
    const doc = await PDFDocument.create()
    doc.addPage()
    doc.addPage()
    fileBufferToReturn = Buffer.from(await doc.save())
    const route = await import('@/app/api/supervisor/assignments/route')
    const res = await route.POST(postRequest({ action: 'analyze', submissionId: 'sub-pdf' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.saved).toBe(false)
    expect(body.provenance.answerSourceLabel).toContain('مسار الكتب')
    expect(body.provenance.ocrNote).toContain('OCR')
    expect(bookReaderCalls).toBeGreaterThan(0)
    expect(bookOcrCalls).toBe(1)
    // نداء ذكاء واحد فقط هو التصحيح؛ قراءة PDF لم تمر بنداء رؤية منفرد.
    expect(textAiCalls).toBe(1)
    expect(updateCalls.length).toBe(0)
  })

  test('original source IDs are read and sent to AI before all other unit knowledge', async () => {
    mockSourceUnit = true
    submission.assignment.unitId = 'unit-1'
    submission.assignment.sourceKnowledgeIds = ['ki-exact']
    const route = await import('@/app/api/supervisor/assignments/route')
    const res = await route.POST(postRequest({ action: 'analyze', submissionId: 'sub-1' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.provenance.bookSourceStatus).toBe('EXACT')
    expect(body.provenance.sourceKnowledgeCount).toBe(1)
    expect(body.provenance.sourceKnowledgeMatched).toBe(1)
    expect(lastGradingPrompt).toContain('مصدر الواجب الأصلي: الاستقطاب الموثّق')
    expect(lastGradingPrompt).not.toContain('تخطيط الكفاءات')
    expect(updateCalls).toHaveLength(0)
    expect(notifyCalls).toHaveLength(0)
  })

  test('deleted original knowledge is flagged and supplemented only from the same unit', async () => {
    mockSourceUnit = true
    mockMissingOriginal = true
    submission.assignment.unitId = 'unit-1'
    submission.assignment.sourceKnowledgeIds = ['ki-exact']
    const route = await import('@/app/api/supervisor/assignments/route')
    const res = await route.POST(postRequest({ action: 'analyze', submissionId: 'sub-1' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.provenance.bookSourceStatus).toBe('PARTIAL')
    expect(body.provenance.sourceKnowledgeCount).toBe(1)
    expect(body.provenance.sourceKnowledgeMatched).toBe(0)
    expect(lastGradingPrompt).toContain('استكمال من الوحدة نفسها: تخطيط الكفاءات')
    expect(lastGradingPrompt).not.toContain('مصدر الواجب الأصلي: الاستقطاب الموثّق')
    expect(updateCalls).toHaveLength(0)
  })

  test('legacy manual linked task uses UNIT status, unlinked task uses NONE with no invented reference', async () => {
    mockSourceUnit = true
    submission.assignment.unitId = 'unit-1'
    const route = await import('@/app/api/supervisor/assignments/route')
    const linked = await route.POST(postRequest({ action: 'analyze', submissionId: 'sub-1' }))
    expect((await linked.json()).provenance.bookSourceStatus).toBe('UNIT')
    expect(lastGradingPrompt).toContain('تخطيط الكفاءات')
    submission.assignment.unitId = null
    const unlinked = await route.POST(postRequest({ action: 'analyze', submissionId: 'sub-1' }))
    expect((await unlinked.json()).provenance.bookSourceStatus).toBe('NONE')
    expect(lastGradingPrompt).toContain('لا يوجد سياق كتاب متاح')
    expect(updateCalls).toHaveLength(0)
  })

  test('obsolete repair-reference action is rejected without issuing a grade', async () => {
    mockSourceUnit = true
    mockCorruptedReference = true
    submission.assignment.unitId = 'unit-1'
    const route = await import('@/app/api/supervisor/assignments/route')
    const res = await route.POST(postRequest({ action: 'repair-reference', submissionId: 'sub-1' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('إجراء غير معروف')
    expect(textAiCalls).toBe(0)
    expect(updateCalls).toHaveLength(0)
  })

  test('unreadable source blocks approval until supervisor explicitly confirms original review', async () => {
    mockSourceUnit = true
    mockCorruptedReference = true
    submission.assignment.unitId = 'unit-1'
    const route = await import('@/app/api/supervisor/assignments/route')
    const analysis = await route.POST(postRequest({ action: 'analyze', submissionId: 'sub-1' }))
    expect(analysis.status).toBe(200)
    const draft = await analysis.json()
    expect(draft.provenance.referenceWarning).toBe('REFERENCE_UNREADABLE')
    expect(draft.draft.feedback).toContain('المرجع غير مقروء')
    const body = { action: 'grade', submissionId: 'sub-1', score: 80, feedback: 'راجعت المحتوى الأكاديمي.', status: 'GRADED' }
    const rejected = await route.POST(postRequest(body))
    expect(rejected.status).toBe(409)
    expect(updateCalls).toHaveLength(0)
    const approved = await route.POST(postRequest({ ...body, sourceReviewed: true }))
    expect(approved.status).toBe(200)
    expect(updateCalls).toHaveLength(1)
  })

  test('grade above assignment points is rejected without saving', async () => {
    const route = await import('@/app/api/supervisor/assignments/route')
    const res = await route.POST(
      postRequest({ action: 'grade', submissionId: 'sub-1', score: 150, feedback: 'ملاحظة مفصلة للطالب بعد المراجعة.', status: 'GRADED' })
    )
    expect(res.status).toBe(400)
    expect(updateCalls.length).toBe(0)
  })
})
