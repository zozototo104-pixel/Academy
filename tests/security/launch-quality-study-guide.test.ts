// حارس دليل دراسة فحص الجاهزية (بوابة #703، 2026-11-09):
// المسار كان يستخدم upsert بمفتاح programId_semester غير الموجود كقيد
// فريد في المخطط (فهرس فقط)، فكان يرمي PrismaClientValidationError
// ويُرجع 500 دائماً. الإصلاح: بحث-أو-إنشاء داخل قفل استشاري، مقصور على
// الدليل العام (unitId: null). هذا الاختبار يثبت سلوكياً — بقاعدة وهمية
// تحاكي تسلسل القفل — أن: أول تشغيل ينشئ دليلاً عاماً واحداً، وإعادة
// التشغيل تحدّثه ولا تنشئ نسخة، ونداءان متزامنان لا ينشئان نسختين،
// وأدلة الوحدات لا تُلمس. ويثبت نصياً أن المفتاح الوهمي لا يعود.
import { describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'

type Guide = Record<string, any>
const guides: Guide[] = []
let seq = 0
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// قفل وهمي يحاكي قفل Postgres الاستشاري: يُقتنى من $executeRaw داخل
// المعاملة ويُحرَّر عند انتهائها، فيُسلسِل المعاملات المتنافسة.
let lockChain: Promise<void> = Promise.resolve()
let releaseCurrent: (() => void) | null = null
async function acquireLock() {
  let release!: () => void
  const next = new Promise<void>((res) => {
    release = res
  })
  const prev = lockChain
  lockChain = prev.then(() => next)
  await prev
  releaseCurrent = release
}

const fakeTx = {
  $executeRaw: async () => {
    await acquireLock()
    return 0
  },
  programStudyGuide: {
    findFirst: async ({ where }: any) => {
      await sleep(5) // نافذة سباق حقيقية: بلا قفل يرى نداءان «لا شيء» معاً
      const rows = guides
        .filter(
          (g) =>
            g.programId === where.programId &&
            g.semester === where.semester &&
            (where.unitId === null ? g.unitId == null : g.unitId === where.unitId),
        )
        .sort((a, b) => +a.createdAt - +b.createdAt)
      return rows[0] || null
    },
    create: async ({ data }: any) => {
      await sleep(5) // زمن رحلة الإدراج: بلا قفل يرى النداء الثاني الفراغ أيضاً
      const row: Guide = { id: `guide-${++seq}`, createdAt: new Date(Date.now() + seq), ...data }
      guides.push(row)
      return row
    },
    update: async ({ where, data }: any) => {
      const row = guides.find((g) => g.id === where.id)
      if (!row) throw new Error('guide not found')
      Object.assign(row, data)
      return row
    },
  },
}

const fakeDb = {
  $transaction: async (cb: any) => {
    try {
      return await cb(fakeTx)
    } finally {
      releaseCurrent?.()
      releaseCurrent = null
    }
  },
}

mock.module('@/lib/db', () => ({ db: fakeDb }))

const { ensureLaunchQualityStudyGuide } = await import('@/lib/launch-quality-study-guide')

const PROGRAM_ID = 'program-diagnostic-1'
const generalGuides = () => guides.filter((g) => g.programId === PROGRAM_ID && g.unitId == null)

function reset() {
  guides.length = 0
  seq = 0
}

describe('دليل دراسة فحص الجاهزية: بحث-أو-إنشاء آمن عند إعادة التشغيل', () => {
  test('أول تشغيل ينشئ دليلاً عاماً واحداً بالحقول التشخيصية', async () => {
    reset()
    const guide = await ensureLaunchQualityStudyGuide(PROGRAM_ID)
    expect(generalGuides().length).toBe(1)
    expect(guide.unitId ?? null).toBeNull()
    expect(guide.semester).toBe(1)
    expect(guide.status).toBe('PUBLISHED')
    expect(guide.title).toContain('دليل دراسة الفصل الأول')
    expect(guide.generatedBy).toBe('ADMIN')
  })

  test('إعادة التشغيل تحدّث الدليل نفسه ولا تنشئ نسخة', async () => {
    reset()
    const first = await ensureLaunchQualityStudyGuide(PROGRAM_ID)
    const second = await ensureLaunchQualityStudyGuide(PROGRAM_ID)
    const third = await ensureLaunchQualityStudyGuide(PROGRAM_ID)
    expect(generalGuides().length).toBe(1)
    expect(second.id).toBe(first.id)
    expect(third.id).toBe(first.id)
  })

  test('نداءان متزامنان لا ينشئان دليلين عامّين', async () => {
    reset()
    const [a, b] = await Promise.all([
      ensureLaunchQualityStudyGuide(PROGRAM_ID),
      ensureLaunchQualityStudyGuide(PROGRAM_ID),
    ])
    expect(generalGuides().length).toBe(1)
    expect(a.id).toBe(b.id)
  })

  test('دليل وحدة لنفس البرنامج والفصل لا يُلمس ولا يحل محل الدليل العام', async () => {
    reset()
    guides.push({
      id: 'unit-guide-1',
      programId: PROGRAM_ID,
      semester: 1,
      unitId: 'unit-9',
      title: 'دليل وحدة أصلي',
      status: 'PUBLISHED',
      createdAt: new Date(),
    })
    const guide = await ensureLaunchQualityStudyGuide(PROGRAM_ID)
    expect(guide.id).not.toBe('unit-guide-1')
    expect(generalGuides().length).toBe(1)
    expect(guides.find((g) => g.id === 'unit-guide-1')?.title).toBe('دليل وحدة أصلي')
  })

  test('المسار لا يستخدم مفتاح programId_semester الوهمي والمخطط بلا قيد فريد جديد', () => {
    const routeSource = readFileSync(new URL('../../src/app/api/admin/launch-quality/route.ts', import.meta.url), 'utf8')
    expect(routeSource).not.toContain('programId_semester')
    expect(routeSource).toContain('ensureLaunchQualityStudyGuide')
    const schema = readFileSync(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8')
    const start = schema.indexOf('model ProgramStudyGuide ')
    const block = schema.slice(start, schema.indexOf('}', start))
    expect(block).toContain('@@index([programId, semester])')
    expect(block).not.toContain('@@unique([programId, semester])')
  })
})

describe('study-guide Arabic visibility: reject broken OCR without hiding correct text', () => {
  test('a stored semester guide with the valid word يضيف is not hidden in admin or student views', async () => {
    const { looksLikeBrokenGeneratedArabic } = await import('../../src/lib/academic-output-quality')
    const title = 'دليل الفصل الدراسي العام الأول'
    const overview = 'يجمع هذا الدليل العام وحدات الماجستير المهني في إدارة المشاريع المعتمدة في هذا النطاق. بُني الدليل من أدلة الوحدات نفسها، لذلك لا يضيف قوالب عامة ولا مصطلحات خارج الكتب؛ وتظهر مراجع الصفحات ومصادر المعرفة داخل كل قسم.'
    expect(looksLikeBrokenGeneratedArabic(`${title}. ${overview}`)).toBe(false)
    expect(looksLikeBrokenGeneratedArabic(overview)).toBe(false)
  })

  test('valid Arabic فيه and the professional-program context do not hide guides', async () => {
    const { looksLikeBrokenGeneratedArabic } = await import('../../src/lib/academic-output-quality')
    const valid = 'يوضح الدليل المهني كيفية استخدام المعرفة؛ فيه تطبيق عملي يشرح إدارة المشروع وأهداف العمل ودور المشاركين.'
    expect(looksLikeBrokenGeneratedArabic(valid)).toBe(false)
  })

  test('repairable standalone OCR يف becomes في before quality classification', async () => {
    const { cleanAcademicOutput, looksLikeBrokenGeneratedArabic } = await import('../../src/lib/academic-output-quality')
    const source = 'يعرض الفصل العلمي موضوع إدارة المشروع يف قراءة نصوص الكتاب ويوضح أثر القرار على العمل'
    const cleaned = cleanAcademicOutput(source)
    expect(cleaned).toContain('في قراءة نصوص الكتاب')
    expect(cleaned).not.toContain('يف قراءة')
    expect(looksLikeBrokenGeneratedArabic(cleaned)).toBe(false)
  })

  test('real corrupted OCR and internal placeholders stay blocked', async () => {
    const { looksLikeBrokenGeneratedArabic } = await import('../../src/lib/academic-output-quality')
    expect(looksLikeBrokenGeneratedArabic('تُعرض هذه الفقرة من كتاب احرب في إدارة المشروع وتحليل معطياته التنظيمية.')).toBe(true)
    expect(looksLikeBrokenGeneratedArabic('مقتطف داعم عن إدارة المشاريع وطرق التقييم في الفصل الدراسي.')).toBe(true)
  })
})

describe('knowledge cleanup: full correction, no partial writes, delete only empty', () => {
  test('corrects all populated text fields atomically when every corrected field is valid', async () => {
    const { planKnowledgeItemCleanup } = await import('../../src/lib/academic-output-quality')
    const result = planKnowledgeItemCleanup({
      title: '**إدارة المشاريع**',
      summary: 'يوضح هذا المفهوم إجراءات القرار في إدارة المشاريع.',
      excerpt: 'يف تحليل المشروعات تستخدم فرق الإدارة البيانات المتاحة.',
    }, () => false)
    expect(result.action).toBe('UPDATE')
    if (result.action !== 'UPDATE') throw new Error('Expected an update plan')
    expect(result.data.title).toBe('إدارة المشاريع')
    expect(result.data.summary).toContain('إجراءات القرار')
    expect(result.data.excerpt).toContain('في تحليل المشروعات')
    expect(result.data.excerpt).not.toContain('يف تحليل')
  })

  test('one unresolved field prevents saving even a valid correction to another field', async () => {
    const { planKnowledgeItemCleanup } = await import('../../src/lib/academic-output-quality')
    const result = planKnowledgeItemCleanup({
      title: '**عنوان علمي سليم**',
      summary: 'مقطع مشوّه يحتاج مراجعة مصدره الأصلي.',
      excerpt: 'تفاصيل صحيحة من محتوى الكتاب.',
    }, (text) => text.includes('مشوّه'))
    expect(result).toEqual({ action: 'REVIEW', reason: 'UNRESOLVED' })
    expect('data' in result).toBe(false)
  })

  test('only an entirely empty knowledge item can be deleted', async () => {
    const { planKnowledgeItemCleanup } = await import('../../src/lib/academic-output-quality')
    expect(planKnowledgeItemCleanup({ title: ' ', summary: '  ', excerpt: null })).toEqual({ action: 'DELETE_EMPTY' })
    expect(planKnowledgeItemCleanup({
      title: '', summary: 'تحليل معرفي مستند إلى مصدر فعلي من الكتاب.', excerpt: null,
    }).action).toBe('REVIEW')
    expect(planKnowledgeItemCleanup({
      title: 'مفهوم', summary: '', excerpt: 'شاهد نصي متاح مرتبط بالكتاب',
    }).action).toBe('REVIEW')
  })

  test('AI repair requires all THREE fields to be exact spans from a readable source', async () => {
    const { validateGroundedKnowledgeRepair } = await import('../../src/lib/academic-output-quality')
    const source = 'تخطيط الموارد وتحليل المخاطر في إدارة المشاريع. تعتمد إدارة المشاريع على تخطيط الموارد ومراجعة المخاطر وتحليل المدة والتكلفة والجودة قبل اتخاذ القرارات التنفيذية. يساعد هذا النهج في توزيع المسؤوليات وتحديد مؤشرات الأداء ومراقبة الانحرافات أثناء مراحل التنفيذ، مع توثيق النتائج وتصحيح خطة المشروع كلما ظهرت معطيات جديدة.'
    const proposed = {
      title: 'تخطيط الموارد وتحليل المخاطر في إدارة المشاريع',
      summary: 'تعتمد إدارة المشاريع على تخطيط الموارد ومراجعة المخاطر وتحليل المدة والتكلفة والجودة قبل اتخاذ القرارات التنفيذية.',
      excerpt: 'يساعد هذا النهج في توزيع المسؤوليات وتحديد مؤشرات الأداء ومراقبة الانحرافات أثناء مراحل التنفيذ، مع توثيق النتائج وتصحيح خطة المشروع كلما ظهرت معطيات جديدة.',
    }
    expect(validateGroundedKnowledgeRepair(proposed, source)).toEqual(proposed)
    expect(validateGroundedKnowledgeRepair({ ...proposed, excerpt: 'يساعد هذا النهج في توزيع المسؤوليات ويلغي تحليل المخاطر نهائياً أثناء التنفيذ.' }, source)).toBeNull()
    // Fluent, plausible hallucination that shares all the topic vocabulary
    // MUST fail: lexical overlap is not proof of entailment.
    expect(validateGroundedKnowledgeRepair({
      ...proposed, summary: 'تعتمد إدارة المشاريع على تخطيط الموارد ومراجعة المخاطر لكن استخدام مؤشرات الأداء يلغي الحاجة إلى متابعة التكلفة والجودة أثناء التنفيذ.',
    }, source)).toBeNull()
    expect(validateGroundedKnowledgeRepair({ ...proposed, title: 'تخطيط الموارد ومنع المخاطر في إدارة المشاريع' }, source)).toBeNull()
    expect(validateGroundedKnowledgeRepair({ ...proposed, summary: 'مقتطف داعم عن مجال العمل.' }, source)).toBeNull()
    expect(validateGroundedKnowledgeRepair({ title: proposed.title }, source)).toBeNull()
    expect(validateGroundedKnowledgeRepair(proposed, source + ' كتاب احرب في سياق الإدارة العملية.')).toBeNull()
    expect(validateGroundedKnowledgeRepair(proposed, '')).toBeNull()
  })

  test('formatted but non-empty original text is never deleted after cleanup', async () => {
    const { planKnowledgeItemCleanup } = await import('../../src/lib/academic-output-quality')
    expect(planKnowledgeItemCleanup({ title: '***', summary: '', excerpt: null }).action).toBe('REVIEW')
  })

  test('AI repair request only enqueues; cron owns bounded, source-first updates', () => {
    const api = readFileSync(new URL('../../src/app/api/admin/knowledge-bank/route.ts', import.meta.url), 'utf8')
    const ai = api.split("if (action === 'repair-ai')")[1]?.split("if (action === 'sanitize'")[0] || ''
    const worker = readFileSync(new URL('../../src/lib/book-knowledge-v2-scheduler.ts', import.meta.url), 'utf8')
    const cron = readFileSync(new URL('../../src/app/api/cron/question-bank-jobs/route.ts', import.meta.url), 'utf8')
    expect(ai).toContain('enqueueKnowledgeAiRepairJob(programId)')
    expect(ai).not.toContain('textAiCompleteJson(')
    expect(ai).not.toContain('db.bookKnowledgeItem.update')
    expect(worker).toContain("'AI_KNOWLEDGE_REPAIR_PROVIDER'")
    expect(worker).toContain("'AI_KNOWLEDGE_REPAIR_MODEL'")
    expect(worker).toContain("'AI_KNOWLEDGE_REPAIR_INTERVAL_SECONDS'")
    expect(worker).toContain("'AI_KNOWLEDGE_REPAIR_CALLS_PER_RUN'")
    expect(worker).toContain('next.attempts - state.attempts >= maxCallsPerRun')
    expect(worker).toContain('Date.now() + 25_000 >= stopStartingAt')
    expect(worker).toContain('restrictToModels: chosenModel')
    expect(worker).toContain('apinexPromptOnlyJson: true')
    expect(worker).not.toContain("excludeProviders: ['APINEX']")
    expect(worker).toContain("'CLOUDFLARE', 'APINEX', 'OXION', 'AUTO'")
    expect(worker).not.toContain('Math.max(90_000,')
    expect(worker).toContain('intervalMs > 0')
    expect(worker).toContain('REPAIR_RATE_GATE')
    expect(worker).toContain("const owned = await db.setting.updateMany")
    expect(worker).toContain('validateGroundedKnowledgeRepair(parsed, evidence)')
    expect(worker).toContain('planKnowledgeItemCleanup(item, looksLikeBrokenAcademicOutput)')
    expect(worker).toContain('!looksLikeBrokenAcademicOutput(candidate.excerpt)')
    expect(worker).toContain('db.bookKnowledgeItem.updateMany')
    expect(worker).toContain('updatedAt: item.updatedAt')
    expect(worker).not.toContain('db.bookKnowledgeItem.create(')
    expect(worker).not.toContain('db.bookKnowledgeItem.delete(')
    expect(cron).toContain('runNextKnowledgeAiRepairStep()')
    expect(cron.indexOf('runNextKnowledgeAiRepairStep()')).toBeGreaterThan(cron.indexOf("'[question-bank-cron] done'"))
  })

  test('repair provider/model selection is isolated from student/global AI settings', () => {
    const system = readFileSync(new URL('../../src/app/api/admin/system/route.ts', import.meta.url), 'utf8')
    const modelPanel = readFileSync(new URL('../../src/components/aact/AdminSystemTab.tsx', import.meta.url), 'utf8')
    const books = readFileSync(new URL('../../src/components/aact/AdminBooks.tsx', import.meta.url), 'utf8')
    const worker = readFileSync(new URL('../../src/lib/book-knowledge-v2-scheduler.ts', import.meta.url), 'utf8')
    const repairPage = books.split('export function AdminKnowledgeAiRepairTab()')[1] || ''
    expect(system).toContain("'AI_KNOWLEDGE_REPAIR_PROVIDER', 'AI_KNOWLEDGE_REPAIR_MODEL', 'AI_KNOWLEDGE_REPAIR_INTERVAL_SECONDS'")
    expect(system).toContain('const repairProvider =')
    expect(system).toContain('const repairModel =')
    expect(system).toContain("'ALBORIHI', 'MISTRAL', 'CLOUDFLARE', 'APINEX', 'OXION'")
    expect(system).toContain('if (!repairProviderNames.has(repairProvider))')
    expect(modelPanel).not.toContain('gemini-section-repair')
    expect(modelPanel).toContain("const [openGeminiSection, setOpenGeminiSection] = useState<'core' | 'routing' | 'providers' | 'health' | 'cooldowns' | 'tests' | null>('core')")
    expect(repairPage).toContain('TEXT_PROVIDER_CHOICES')
    expect(repairPage).toContain("action: 'text-ai-models'")
    expect(repairPage).toContain("method: 'PATCH'")
    expect(repairPage).toContain('AI_KNOWLEDGE_REPAIR_PROVIDER: repairProvider')
    expect(repairPage).toContain('AI_KNOWLEDGE_REPAIR_MODEL:')
    expect(worker).toContain('restrictToModels: chosenModel')
    expect(worker).toContain('intervalMs > 0')
    expect(worker).not.toContain("excludeProviders: ['APINEX']")
  })

  test('AI repair has its own main admin navigation, not another books button', () => {
    const admin = readFileSync(new URL('../../src/components/aact/AdminView.tsx', import.meta.url), 'utf8')
    const books = readFileSync(new URL('../../src/components/aact/AdminBooks.tsx', import.meta.url), 'utf8')
    const booksPanel = books.split('export function AdminBooksTab()')[1]?.split('export function AdminKnowledgeAiRepairTab()')[0] || ''
    const repairPanel = books.split('export function AdminKnowledgeAiRepairTab()')[1] || ''
    expect(admin).toContain('TabsTrigger value="knowledge-ai-repair"')
    expect(admin).toContain('TabsContent value="knowledge-ai-repair"')
    expect(admin).toContain('AdminKnowledgeAiRepairTab />')
    expect(admin).toContain("'books', 'knowledge-ai-repair'")
    expect(booksPanel).toContain('تصحيح بالقواعد (حذف الفارغ فقط)')
    expect(booksPanel).not.toContain('startKnowledgeAiRepair')
    expect(repairPanel).toContain('بدء التصحيح الذكي')
    expect(repairPanel).toContain('استكمال مهمة التصحيح')
    expect(repairPanel).toContain('repairStatus=1')
  })

  test('rules-only cleanup NEVER automatically starts AI repair', () => {
    const books = readFileSync(new URL('../../src/components/aact/AdminBooks.tsx', import.meta.url), 'utf8')
    const route = readFileSync(new URL('../../src/app/api/admin/knowledge-bank/route.ts', import.meta.url), 'utf8')
    const rulesHandler = books.split('const sanitizeKnowledge = async () => {')[1]?.split('const refreshCurriculumUnits')[0] || ''
    const aiPanel = books.split('export function AdminKnowledgeAiRepairTab()')[1] || ''
    const rulesRoute = route.split("if (action === 'sanitize' || action === 'clean')")[1]?.split("if (action === 'rebuild-book'")[0] || ''
    expect(rulesHandler).toContain("action: 'sanitize'")
    expect(rulesHandler).not.toContain("action: 'repair-ai'")
    expect(rulesHandler).not.toContain('startKnowledgeAiRepair')
    expect(books).toContain('onClick={sanitizeKnowledge}')
    expect(rulesRoute).not.toContain('enqueueKnowledgeAiRepairJob')
    expect(rulesRoute).not.toContain('textAiCompleteJson(')
    expect(aiPanel).toContain("action: 'repair-ai'")
    expect(aiPanel).toContain('onClick={start}')
    expect(aiPanel).toContain('بدء التصحيح الذكي')
  })

  test('already valid content stays intact', async () => {
    const { planKnowledgeItemCleanup } = await import('../../src/lib/academic-output-quality')
    const item = {
      title: 'إدارة المشاريع',
      summary: 'تساعد إدارة المشاريع على التخطيط والتنفيذ ومتابعة النتائج بوضوح.',
      excerpt: 'يركّز المقطع على متابعة الوقت والتكلفة والجودة في مراحل المشروع.',
    }
    expect(planKnowledgeItemCleanup(item, () => false)).toEqual({ action: 'KEEP' })
  })

  test('admin sanitizer routes deletion only through the fully-empty classification', () => {
    const source = readFileSync(new URL('../../src/app/api/admin/knowledge-bank/route.ts', import.meta.url), 'utf8')
    expect(source).toContain("const plan = planKnowledgeItemCleanup(row, looksLikeBrokenAcademicOutput)")
    expect(source).toContain("if (plan.action === 'DELETE_EMPTY')")
    expect(source).toContain("} else if (plan.action === 'REVIEW') {")
    expect(source).toContain("needsReview++")
    expect(source).not.toContain("if (!title || !summary || looksLikeBrokenAcademicOutput")
  })
})

describe('saved study-guide visibility and citation integrity contracts', () => {
  const adminRoute = readFileSync(new URL('../../src/app/api/admin/study-guides/route.ts', import.meta.url), 'utf8')
  const adminBooks = readFileSync(new URL('../../src/components/aact/AdminBooks.tsx', import.meta.url), 'utf8')
  const studentRoute = readFileSync(new URL('../../src/app/api/study-guides/route.ts', import.meta.url), 'utf8')
  const studentDashboard = readFileSync(new URL('../../src/components/aact/DashboardView.tsx', import.meta.url), 'utf8')

  test('all persisted semester guides stay visible to admin without truncating sections', () => {
    const displayBlock = adminBooks.split('const displayStudyGuides = useMemo(')[1]?.split('const hiddenKnowledgeItemsCount')[0] || ''
    expect(displayBlock).toContain('rootStudyGuides.map')
    expect(displayBlock).not.toContain('.slice(0, 8)')
    expect(displayBlock).not.toContain('.filter((guide)')
    expect(adminBooks).toContain('flaggedStudyGuidesCount')
    expect(adminBooks).toContain('missingReferenceCount')
  })

  test('save and publish verify the real referenced book, analyzed chunk and pages', () => {
    expect(adminRoute).toContain('async function assertStudyGuideReferences(')
    expect(adminRoute).toContain("chunk.status !== 'ANALYZED'")
    expect(adminRoute).toContain('item.pageStart < chunk.pageStart')
    expect(adminRoute).toContain('item.pageEnd > chunk.pageEnd')
    expect(adminRoute).toContain('await assertStudyGuideReferences(programId, generated)')
    expect(adminRoute).toContain('isPublishingOrRevisingReferences')
    expect(adminRoute).toContain('await assertStudyGuideReferences(existing.programId')
    expect(adminRoute).toContain('missingReferenceCount:')
    expect(adminRoute).toContain("status: 422")
    expect(adminRoute).toContain('STUDY_GUIDE_UNIT_SOURCE_MISSING')
  })

  test('student guide returns complete sections and actual page/citation fields', () => {
    const mapBlock = studentRoute.split('function mapGuide(g: any)')[1]?.split('export async function GET')[0] || ''
    expect(mapBlock).toContain('sourceKnowledgeIds:')
    expect(mapBlock).toContain('pageRefs:')
    expect(mapBlock).not.toContain('.slice(0, 8)')
    expect(studentDashboard).toContain('عرض جميع محاور الدليل')
    expect(studentDashboard).toContain('section.pageRefs?.join')
  })

  test('knowledge repair remains manually triggered and rule-based repair is unchanged', () => {
    expect(adminBooks).toContain('تصحيح بالقواعد (حذف الفارغ فقط)')
    expect(adminBooks).toContain('export function AdminKnowledgeAiRepairTab()')
  })
})

// Behavioral regression: one click makes a missing unit draft from its already
// generated book-grounded content, then publishes the semester aggregate.
let autoUnits: any[] = []
let autoBooks: any[] = []
let autoChunks: any[] = []
let autoKnowledge: any[] = []
const AUTO_PROGRAM_ID = 'test-auto-semester-guide'
const AUTO_UNIT_ID = 'unit-existing-content'
const AUTO_BOOK_ID = 'book-backed-source'
const AUTO_CHUNK_ID = 'chunk-analyzed-source'
const AUTO_KNOWLEDGE_ID = 'kb-source-item'

Object.assign(fakeDb, {
  program: { findUnique: async ({ where }: any) => where.id === AUTO_PROGRAM_ID
    ? { id: AUTO_PROGRAM_ID, titleAr: 'برنامج الاختبار', titleEn: null } : null },
  unit: { findMany: async ({ where }: any) => autoUnits.filter((unit) =>
    unit.programId === where.programId && (where.semester === undefined || unit.semester === where.semester)) },
  programStudyGuide: { findMany: async ({ where }: any) => guides.filter((guide) =>
    where.unitId?.in?.includes(guide.unitId) && where.status.in.includes(guide.status)) },
  book: { findMany: async ({ where }: any) => autoBooks.filter((book) =>
    where.id.in.includes(book.id) && (!where.programId || book.programId === where.programId)) },
  bookOutlineSection: { findMany: async ({ where }: any) =>
    where.id.in.includes('source-outline') ? [{ id: 'source-outline', outline: { bookId: AUTO_BOOK_ID } }] : [] },
  bookChunk: { findMany: async ({ where }: any) => autoChunks.filter((chunk) =>
    (!where.id || where.id.in.includes(chunk.id)) &&
    (!where.programId || chunk.programId === where.programId) &&
    (!where.bookId || chunk.bookId === where.bookId) &&
    (!where.status || chunk.status === where.status) &&
    (!where.index || (where.index.in ? where.index.in.includes(chunk.index) :
      chunk.index >= where.index.gte && chunk.index <= where.index.lte))) },
  bookKnowledgeItem: { findMany: async ({ where }: any) => autoKnowledge.filter((item) =>
    (where.id ? where.id.in.includes(item.id) : true) &&
    (where.bookId ? where.bookId === item.bookId : true) &&
    (where.programId ? where.programId === item.programId : true) &&
    (where.chunkId ? where.chunkId.in.includes(item.chunkId) : true)) },
})
mock.module('@/lib/auth', () => ({ requireAdmin: async () => ({ id: 'admin-guide-test', name: 'Administrator' }) }))
mock.module('@/lib/notify', () => ({ audit: async () => {} }))
mock.module('@/lib/timing', () => ({
  withTiming: async (_name: string, fn: () => any) => fn(),
  withTimedResponse: async (fn: () => any) => fn(),
}))

const { POST: postSemesterGuide } = await import('../../src/app/api/admin/study-guides/route')

function resetAutoGuideFixture() {
  reset()
  autoUnits = [{
    id: AUTO_UNIT_ID, programId: AUTO_PROGRAM_ID, semester: 1, order: 1,
    title: 'إدارة المشروعات', summary: 'تشرح الوحدة الإدارة والتخطيط من صفحات الكتاب الأصلية.',
    objectives: '["تحليل الممارسات الإدارية"]',
    content: JSON.stringify([{ heading: 'التخطيط والتنفيذ',
      body: 'يوضح هذا القسم من النص الأكاديمي خطوات التخطيط والتنفيذ ومتابعة النتائج وربط المهام بالمصادر الأصلية داخل نفس الوحدة.',
      pageRefs: ['صفحات 10–12'], sourceKnowledgeIds: [AUTO_KNOWLEDGE_ID], sourceChunkIndexes: [1] }]),
    sourceBookId: AUTO_BOOK_ID, outlineSectionId: 'source-outline',
    chunkStartIndex: 1, chunkEndIndex: 1,
  }]
  autoBooks = [{ id: AUTO_BOOK_ID, programId: AUTO_PROGRAM_ID, title: 'كتاب الإدارة المعتمد' }]
  autoChunks = [{ id: AUTO_CHUNK_ID, programId: AUTO_PROGRAM_ID, bookId: AUTO_BOOK_ID,
    index: 1, status: 'ANALYZED', pageStart: 10, pageEnd: 12 }]
  autoKnowledge = [{ id: AUTO_KNOWLEDGE_ID, programId: AUTO_PROGRAM_ID,
    bookId: AUTO_BOOK_ID, chunkId: AUTO_CHUNK_ID, pageStart: 10, pageEnd: 12,
    category: 'CONCEPT', title: 'إدارة المشروعات',
    summary: 'يربط التخطيط المهام والموارد وطرق التنفيذ بالنتائج.',
    excerpt: 'أهمية التخطيط المؤسسي للموارد' }]
}

async function clickSemesterGuide() {
  const req = { json: async () => ({ programId: AUTO_PROGRAM_ID, semester: 1, status: 'PUBLISHED' }) }
  const response = await postSemesterGuide(req as any)
  return { response, body: await response.json() }
}

describe('semester guide: automatic missing unit guide backed by knowledge sources', () => {
  test('one click generates a DRAFT unit guide and a published semester guide', async () => {
    resetAutoGuideFixture()
    const { response, body } = await clickSemesterGuide()
    expect(response.status).toBe(200)
    expect(body.autoCreatedUnitGuides).toBe(1)
    const unitGuide = guides.find((g) => g.unitId === AUTO_UNIT_ID)
    const semesterGuide = guides.find((g) => g.programId === AUTO_PROGRAM_ID && g.unitId == null)
    expect(unitGuide?.status).toBe('DRAFT')
    expect(unitGuide?.generatedBy).toBe('SOURCE_DERIVED')
    expect(JSON.parse(unitGuide!.sections)[0].sourceKnowledgeIds).toEqual([AUTO_KNOWLEDGE_ID])
    expect(JSON.parse(unitGuide!.sections)[0].sourceTitles).toEqual(['كتاب الإدارة المعتمد'])
    expect(JSON.parse(unitGuide!.sections)[0].pageRefs).toEqual(['صفحات 10–12'])
    expect(semesterGuide?.status).toBe('PUBLISHED')
    expect(JSON.parse(semesterGuide!.sourceKnowledgeIds)).toContain(AUTO_KNOWLEDGE_ID)
  })

  test('repeated click keeps a single unit guide and a single semester guide', async () => {
    resetAutoGuideFixture()
    await clickSemesterGuide()
    const second = await clickSemesterGuide()
    expect(second.response.status).toBe(200)
    expect(second.body.autoCreatedUnitGuides).toBe(0)
    expect(guides.filter((g) => g.unitId === AUTO_UNIT_ID)).toHaveLength(1)
    expect(guides.filter((g) => g.programId === AUTO_PROGRAM_ID && g.unitId == null)).toHaveLength(1)
  })

  test('empty unit content is reported without creating any guide', async () => {
    resetAutoGuideFixture()
    autoUnits[0].content = '[]'
    const { response, body } = await clickSemesterGuide()
    expect(response.status).toBe(422)
    expect(body.error).toContain('STUDY_GUIDE_UNIT_CONTENT_MISSING')
    expect(guides).toHaveLength(0)
  })

  test('a missing knowledge ID is never silently substituted or published', async () => {
    resetAutoGuideFixture()
    autoUnits[0].content = JSON.stringify([{ heading: 'سجل مرجعي',
      body: 'يدرس هذا القسم موضوعًا مرتبطًا بمصدر محذوف ولا يمكن تمريره كمرجع سليم دون التحقق من الأصل.',
      sourceKnowledgeIds: ['deleted-source-id'], sourceChunkIndexes: [1] }])
    const { response, body } = await clickSemesterGuide()
    expect(response.status).toBe(422)
    expect(body.error).toContain('STUDY_GUIDE_UNIT_REFERENCES_MISSING')
    expect(guides).toHaveLength(0)
  })

  test('source book missing blocks generation without deleting unit content', async () => {
    resetAutoGuideFixture()
    autoBooks = []
    const originalContent = autoUnits[0].content
    const { response, body } = await clickSemesterGuide()
    expect(response.status).toBe(422)
    expect(body.error).toContain('STUDY_GUIDE_UNIT_SOURCE_MISSING')
    expect(guides).toHaveLength(0)
    expect(autoUnits[0].content).toBe(originalContent)
  })

  test('short, evidenced sections are preserved instead of silently dropped', async () => {
    resetAutoGuideFixture()
    const sections = JSON.parse(autoUnits[0].content)
    sections.push({ heading: 'مصطلح قصير', body: 'تعريف موثق.', sourceKnowledgeIds: [AUTO_KNOWLEDGE_ID], sourceChunkIndexes: [1] })
    autoUnits[0].content = JSON.stringify(sections)
    const { response } = await clickSemesterGuide()
    expect(response.status).toBe(200)
    const unitGuide = guides.find((guide) => guide.unitId === AUTO_UNIT_ID)!
    expect(JSON.parse(unitGuide.sections)).toHaveLength(2)
    expect(JSON.parse(unitGuide.sections)[1].summary).toBe('تعريف موثق.')
  })

  test('an empty section cannot be omitted from a supposedly complete guide', async () => {
    resetAutoGuideFixture()
    const sections = JSON.parse(autoUnits[0].content)
    sections.push({ heading: 'محور ناقص', body: '', sourceKnowledgeIds: [AUTO_KNOWLEDGE_ID] })
    autoUnits[0].content = JSON.stringify(sections)
    const { response, body } = await clickSemesterGuide()
    expect(response.status).toBe(422)
    expect(body.error).toContain('STUDY_GUIDE_UNIT_CONTENT_INCOMPLETE')
    expect(guides).toHaveLength(0)
  })

  test('chunk proximity never substitutes for a missing evidence ID', async () => {
    resetAutoGuideFixture()
    const sections = JSON.parse(autoUnits[0].content)
    sections[0].sourceKnowledgeIds = []
    autoUnits[0].content = JSON.stringify(sections)
    const { response, body } = await clickSemesterGuide()
    expect(response.status).toBe(422)
    expect(body.error).toContain('STUDY_GUIDE_UNIT_REFERENCES_MISSING')
    expect(guides).toHaveLength(0)
  })

  test('an item cited from a different chunk index is refused', async () => {
    resetAutoGuideFixture()
    const sections = JSON.parse(autoUnits[0].content)
    sections[0].sourceChunkIndexes = [999]
    autoUnits[0].content = JSON.stringify(sections)
    const { response, body } = await clickSemesterGuide()
    expect(response.status).toBe(422)
    expect(body.error).toContain('STUDY_GUIDE_UNIT_REFERENCES_MISSING')
    expect(guides).toHaveLength(0)
  })
})


describe('manual review: unified quality checkers never flag valid يضيف/فيه text', () => {
  test('valid verbs ending in يف and valid فيه phrases pass BOTH checkers', async () => {
    const { looksLikeBrokenGeneratedArabic } = await import('../../src/lib/academic-output-quality')
    const { looksLikeBrokenAcademicOutput } = await import('../../src/lib/knowledge-bank')
    const valid = [
      'لذلك لا يضيف قوالب عامة ولا مصطلحات خارج الكتب.',
      'الكتاب يضيف قراءة جديدة في الفصل المهني.',
      'المدرب يضيف تحليل المشروع ويضيف سياق العمل.',
      'فيه قراءة متأنية تساعد الطالب على الفهم.',
      'المشروع فيه تحليل دقيق للنتائج.',
      'الوحدة تضيف بداية واضحة وسياقًا عمليًا لإطار القرار.',
    ]
    for (const text of valid) {
      expect(looksLikeBrokenGeneratedArabic(text)).toBe(false)
      expect(looksLikeBrokenAcademicOutput(text)).toBe(false)
    }
  })

  test('real garbled OCR still fails BOTH checkers', async () => {
    const { looksLikeBrokenGeneratedArabic } = await import('../../src/lib/academic-output-quality')
    const { looksLikeBrokenAcademicOutput } = await import('../../src/lib/knowledge-bank')
    const broken = [
      'تُعرض هذه الفقرة من كتاب احرب في إدارة المشروع وتحليل معطياته التنظيمية.',
      'مقتطف داعم عن إدارة المشاريع وطرق التقييم في الفصل الدراسي.',
      'صوت الى استراتيجية يشرح إدارة المشروعات والقرارات.',
    ]
    for (const text of broken) {
      expect(looksLikeBrokenGeneratedArabic(text)).toBe(true)
      expect(looksLikeBrokenAcademicOutput(text)).toBe(true)
    }
  })

  test('the planner keeps a valid يضيف item instead of queuing it for review', async () => {
    const { planKnowledgeItemCleanup } = await import('../../src/lib/academic-output-quality')
    const { looksLikeBrokenAcademicOutput } = await import('../../src/lib/knowledge-bank')
    const row = {
      title: 'إدارة المشروعات تضيف قراءة جديدة',
      summary: 'يوضح هذا المفهوم كيف تضيف إدارة المشروعات تحليل المخاطر وسياق القرار إلى خطة العمل.',
      excerpt: 'الكتاب يضيف قراءة جديدة في الفصل المهني.',
    }
    expect(planKnowledgeItemCleanup(row, looksLikeBrokenAcademicOutput).action).toBe('KEEP')
  })
})

// Manual-review queue + save: the backend the admin panel now calls.
// The fake models the real queries (id cursor, take, orderBy, optimistic
// concurrency) so the queue and the PATCH are proven behaviorally, not pinned.
let reviewItems: any[] = []
let reviewBooks: any[] = []
let reviewChunks: any[] = []
const REVIEW_PROGRAM_ID = AUTO_PROGRAM_ID
const REVIEW_BOOK_ID = 'book-review-source'
const REVIEW_CHUNK_ID = 'chunk-review-source'
const REVIEW_CHUNK_TEXT = 'تخطيط الموارد وتحليل المخاطر في إدارة المشاريع. تعتمد إدارة المشاريع على تخطيط الموارد ومراجعة المخاطر وتحليل المدة والتكلفة والجودة قبل اتخاذ القرارات التنفيذية. يساعد هذا النهج في توزيع المسؤوليات وتحديد مؤشرات الأداء ومراقبة الانحرافات أثناء مراحل التنفيذ، مع توثيق النتائج وتصحيح خطة المشروع كلما ظهرت معطيات جديدة. الكتاب يضيف قراءة جديدة في الفصل المهني.'
const REVIEW_UPDATED_AT = new Date('2026-11-12T10:00:00.000Z')

Object.assign(fakeDb, {
  bookKnowledgeItem: {
    findMany: async ({ where, orderBy, take }: any) => {
      let rows = [...autoKnowledge, ...reviewItems].filter((item) =>
        (where?.id ? (where.id.in ? where.id.in.includes(item.id) : where.id.gt ? item.id > where.id.gt : true) : true) &&
        (where?.bookId ? where.bookId === item.bookId : true) &&
        (where?.programId ? where.programId === item.programId : true) &&
        (where?.chunkId ? where.chunkId.in.includes(item.chunkId) : true))
      if (orderBy?.id === 'asc') rows = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      return take ? rows.slice(0, take) : rows
    },
    findFirst: async ({ where }: any) => [...autoKnowledge, ...reviewItems].find((item) => item.id === where.id && item.programId === where.programId) || null,
    updateMany: async ({ where, data }: any) => {
      const row = [...autoKnowledge, ...reviewItems].find((item) =>
        item.id === where.id && item.programId === where.programId && item.updatedAt.getTime() === where.updatedAt.getTime())
      if (!row) return { count: 0 }
      Object.assign(row, data)
      row.updatedAt = new Date()
      return { count: 1 }
    },
  },
  book: {
    findMany: async ({ where }: any) => [...autoBooks, ...reviewBooks].filter((book) =>
      where.id.in.includes(book.id) && (!where.programId || book.programId === where.programId)),
    findFirst: async ({ where }: any) => [...autoBooks, ...reviewBooks].find((book) => book.id === where.id && book.programId === where.programId) || null,
  },
  bookChunk: {
    findMany: async ({ where }: any) => [...autoChunks, ...reviewChunks].filter((chunk) =>
      (!where.id || where.id.in.includes(chunk.id)) &&
      (!where.programId || chunk.programId === where.programId) &&
      (!where.bookId || chunk.bookId === where.bookId) &&
      (!where.status || chunk.status === where.status) &&
      (!where.index || (where.index.in ? where.index.in.includes(chunk.index) :
        chunk.index >= where.index.gte && chunk.index <= where.index.lte))),
    findFirst: async ({ where }: any) => [...autoChunks, ...reviewChunks].find((chunk) =>
      chunk.id === where.id && chunk.programId === where.programId && chunk.bookId === where.bookId) || null,
  },
})

const { GET: getKnowledgeBank, PATCH: patchKnowledgeBank } = await import('../../src/app/api/admin/knowledge-bank/route')

function resetReviewFixture() {
  reset()
  autoUnits = []
  autoBooks = []
  autoChunks = []
  autoKnowledge = []
  reviewBooks = [{ id: REVIEW_BOOK_ID, programId: REVIEW_PROGRAM_ID, title: 'كتاب المراجعة المعتمد' }]
  reviewChunks = [{ id: REVIEW_CHUNK_ID, programId: REVIEW_PROGRAM_ID, bookId: REVIEW_BOOK_ID,
    index: 1, status: 'ANALYZED', pageStart: 10, pageEnd: 40, text: REVIEW_CHUNK_TEXT }]
  reviewItems = [
    {
      id: 'review-valid-yadeef', programId: REVIEW_PROGRAM_ID, bookId: REVIEW_BOOK_ID, chunkId: REVIEW_CHUNK_ID,
      pageStart: 10, pageEnd: 12, category: 'CONCEPT',
      title: 'إدارة المشروعات تضيف قراءة جديدة',
      summary: 'يوضح هذا المفهوم كيف تضيف إدارة المشروعات تحليل المخاطر وسياق القرار إلى خطة العمل.',
      excerpt: 'الكتاب يضيف قراءة جديدة في الفصل المهني.',
      updatedAt: REVIEW_UPDATED_AT,
    },
    {
      id: 'review-broken-text', programId: REVIEW_PROGRAM_ID, bookId: REVIEW_BOOK_ID, chunkId: REVIEW_CHUNK_ID,
      pageStart: 10, pageEnd: 12, category: 'CONCEPT',
      title: 'مقتطف داعم عن إدارة المشاريع وطرق التقييم',
      summary: 'يوضح هذا المفهوم إجراءات القرار في إدارة المشاريع.',
      excerpt: 'تفاصيل صحيحة من محتوى الكتاب.',
      updatedAt: REVIEW_UPDATED_AT,
    },
    {
      id: 'review-no-source', programId: REVIEW_PROGRAM_ID, bookId: null, chunkId: null,
      pageStart: null, pageEnd: null, category: 'CONCEPT',
      title: 'إدارة المشروعات تضيف قراءة جديدة',
      summary: 'يوضح هذا المفهوم كيف تضيف إدارة المشروعات تحليل المخاطر وسياق القرار إلى خطة العمل.',
      excerpt: 'الكتاب يضيف قراءة جديدة في الفصل المهني.',
      updatedAt: REVIEW_UPDATED_AT,
    },
  ]
}

async function getReviewPage(cursor?: string | null) {
  const url = `http://localhost/api/admin/knowledge-bank?programId=${REVIEW_PROGRAM_ID}&review=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
  const response = await getKnowledgeBank({ nextUrl: new URL(url) } as any)
  return { response, body: await response.json() }
}

async function patchReview(body: Record<string, any>) {
  const response = await patchKnowledgeBank({ json: async () => body } as any)
  return { response, body: await response.json() }
}

describe('manual review queue: valid يضيف items stay out, broken and sourceless items queue with reasons', () => {
  test('queue lists the broken-text and no-source items only, with source preview for the verified one', async () => {
    resetReviewFixture()
    const { response, body } = await getReviewPage()
    expect(response.status).toBe(200)
    expect(body.items).toHaveLength(2)
    expect(body.items.map((item: any) => item.id).sort()).toEqual(['review-broken-text', 'review-no-source'])
    const broken = body.items.find((item: any) => item.id === 'review-broken-text')
    expect(broken.reason).toBe('TEXT_UNRESOLVED')
    expect(broken.sourceValid).toBe(true)
    expect(broken.sourceTextPreview).toContain('تخطيط الموارد وتحليل المخاطر')
    expect(broken.bookTitle).toBe('كتاب المراجعة المعتمد')
    const sourceless = body.items.find((item: any) => item.id === 'review-no-source')
    expect(sourceless.reason).toBe('SOURCE_UNVERIFIED')
    expect(sourceless.sourceValid).toBe(false)
    expect(sourceless.sourceTextPreview).toBeNull()
    expect(body.hasMore).toBe(false)
    expect(body.nextCursor).toBeNull()
  })

  test('pagination reaches every review item past the first page', async () => {
    resetReviewFixture()
    reviewItems = reviewItems.filter((item) => item.id === 'review-valid-yadeef')
    for (let i = 1; i <= 21; i++) {
      reviewItems.push({
        id: `review-p${String(i).padStart(2, '0')}`, programId: REVIEW_PROGRAM_ID, bookId: REVIEW_BOOK_ID, chunkId: REVIEW_CHUNK_ID,
        pageStart: 10, pageEnd: 12, category: 'CONCEPT',
        title: `مقتطف داعم رقم ${i} عن إدارة المشاريع`,
        summary: 'يوضح هذا المفهوم إجراءات القرار في إدارة المشاريع.',
        excerpt: 'تفاصيل صحيحة من محتوى الكتاب.',
        updatedAt: REVIEW_UPDATED_AT,
      })
    }
    const first = await getReviewPage()
    expect(first.response.status).toBe(200)
    expect(first.body.items).toHaveLength(20)
    expect(first.body.hasMore).toBe(true)
    expect(first.body.nextCursor).toBe('review-p20')
    const second = await getReviewPage(first.body.nextCursor)
    expect(second.response.status).toBe(200)
    expect(second.body.items).toHaveLength(1)
    expect(second.body.items[0].id).toBe('review-p21')
    expect(second.body.hasMore).toBe(false)
    expect(second.body.nextCursor).toBeNull()
  })
})

describe('manual review save: grounded correction only, same item, optimistic concurrency', () => {
  test('a valid manual correction saves on the same item without changing its references', async () => {
    resetReviewFixture()
    const { response, body } = await patchReview({
      programId: REVIEW_PROGRAM_ID, id: 'review-broken-text',
      title: 'تخطيط الموارد وتحليل المخاطر في إدارة المشاريع',
      summary: 'تعتمد إدارة المشاريع على تخطيط الموارد ومراجعة المخاطر وتحليل المدة والتكلفة والجودة قبل اتخاذ القرارات التنفيذية.',
      excerpt: 'يساعد هذا النهج في توزيع المسؤوليات وتحديد مؤشرات الأداء ومراقبة الانحرافات أثناء مراحل التنفيذ، مع توثيق النتائج وتصحيح خطة المشروع كلما ظهرت معطيات جديدة.',
      expectedUpdatedAt: REVIEW_UPDATED_AT.toISOString(),
    })
    expect(response.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.id).toBe('review-broken-text')
    const row = reviewItems.find((item) => item.id === 'review-broken-text')!
    expect(row.title).toBe('تخطيط الموارد وتحليل المخاطر في إدارة المشاريع')
    expect(row.bookId).toBe(REVIEW_BOOK_ID)
    expect(row.chunkId).toBe(REVIEW_CHUNK_ID)
    expect(row.pageStart).toBe(10)
    const stale = await patchReview({
      programId: REVIEW_PROGRAM_ID, id: 'review-broken-text',
      title: 'تخطيط الموارد وتحليل المخاطر في إدارة المشاريع',
      summary: 'تعتمد إدارة المشاريع على تخطيط الموارد ومراجعة المخاطر وتحليل المدة والتكلفة والجودة قبل اتخاذ القرارات التنفيذية.',
      excerpt: 'يساعد هذا النهج في توزيع المسؤوليات وتحديد مؤشرات الأداء ومراقبة الانحرافات أثناء مراحل التنفيذ، مع توثيق النتائج وتصحيح خطة المشروع كلما ظهرت معطيات جديدة.',
      expectedUpdatedAt: REVIEW_UPDATED_AT.toISOString(),
    })
    expect(stale.response.status).toBe(409)
  })

  test('a correction containing valid يضيف passes the keep-gate instead of a false 422', async () => {
    resetReviewFixture()
    const { response, body } = await patchReview({
      programId: REVIEW_PROGRAM_ID, id: 'review-broken-text',
      title: 'إدارة المشروعات تضيف قراءة جديدة',
      summary: 'يوضح هذا المفهوم كيف تضيف إدارة المشروعات تحليل المخاطر وسياق القرار إلى خطة العمل.',
      excerpt: 'الكتاب يضيف قراءة جديدة في الفصل المهني.',
      expectedUpdatedAt: REVIEW_UPDATED_AT.toISOString(),
    })
    expect(response.status).toBe(200)
    expect(body.ok).toBe(true)
  })

  test('a non-verbatim excerpt is refused without changing the item', async () => {
    resetReviewFixture()
    const before = { ...reviewItems.find((item) => item.id === 'review-broken-text')! }
    const { response, body } = await patchReview({
      programId: REVIEW_PROGRAM_ID, id: 'review-broken-text',
      title: 'تخطيط الموارد وتحليل المخاطر في إدارة المشاريع',
      summary: 'تعتمد إدارة المشاريع على تخطيط الموارد ومراجعة المخاطر وتحليل المدة والتكلفة والجودة قبل اتخاذ القرارات التنفيذية.',
      excerpt: 'نص مخترع لا يوجد في المقطع الأصلي إطلاقاً ولا يطابق أي جملة فيه.',
      expectedUpdatedAt: REVIEW_UPDATED_AT.toISOString(),
    })
    expect(response.status).toBe(422)
    expect(body.error).toContain('حرفيًا')
    const row = reviewItems.find((item) => item.id === 'review-broken-text')!
    expect(row.title).toBe(before.title)
    expect(row.excerpt).toBe(before.excerpt)
  })

  test('a stale expectedUpdatedAt is refused with 409', async () => {
    resetReviewFixture()
    const { response } = await patchReview({
      programId: REVIEW_PROGRAM_ID, id: 'review-broken-text',
      title: 'تخطيط الموارد وتحليل المخاطر في إدارة المشاريع',
      summary: 'تعتمد إدارة المشاريع على تخطيط الموارد ومراجعة المخاطر وتحليل المدة والتكلفة والجودة قبل اتخاذ القرارات التنفيذية.',
      excerpt: 'يساعد هذا النهج في توزيع المسؤوليات وتحديد مؤشرات الأداء ومراقبة الانحرافات أثناء مراحل التنفيذ، مع توثيق النتائج وتصحيح خطة المشروع كلما ظهرت معطيات جديدة.',
      expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
    })
    expect(response.status).toBe(409)
  })

  test('a still-broken correction is refused at the keep-gate', async () => {
    resetReviewFixture()
    const { response, body } = await patchReview({
      programId: REVIEW_PROGRAM_ID, id: 'review-broken-text',
      title: 'تخطيط الموارد وتحليل المخاطر في إدارة المشاريع',
      summary: 'تعتمد إدارة المشاريع على تخطيط الموارد ومراجعة المخاطر وتحليل المدة والتكلفة والجودة قبل اتخاذ القرارات التنفيذية.',
      excerpt: 'مقتطف داعم عن إدارة المشاريع وطرق التقييم.',
      expectedUpdatedAt: REVIEW_UPDATED_AT.toISOString(),
    })
    expect(response.status).toBe(422)
    expect(body.error).toContain('بقي تشوه')
  })
})

describe('manual review UI: the admin panel reaches the review queue and the manual save', () => {
  test('AdminBooks wires the review list and the manual save to the knowledge-bank endpoints', () => {
    const adminBooks = readFileSync(new URL('../../src/components/aact/AdminBooks.tsx', import.meta.url), 'utf8')
    expect(adminBooks).toContain('المراجعة اليدوية للعناصر المشوّهة')
    expect(adminBooks).toContain('عرض عناصر المراجعة')
    expect(adminBooks).toContain('المصدر غير موثّق')
    expect(adminBooks).toContain('sourceTextPreview')
    expect(adminBooks).toContain('تصحيح يدويًا')
    expect(adminBooks).toContain('&review=1')
    expect(adminBooks).toContain('encodeURIComponent(cursor)')
    expect(adminBooks).toContain("method: 'PATCH'")
    expect(adminBooks).toContain('expectedUpdatedAt: item.updatedAt')
    expect(adminBooks).toContain('اعتماد التصحيح')
  })

  test('a completely blank item still appears in the review queue for possible recovery', async () => {
    resetReviewFixture()
    reviewItems.push({
      id: 'review-fully-empty', programId: REVIEW_PROGRAM_ID,
      bookId: REVIEW_BOOK_ID, chunkId: REVIEW_CHUNK_ID,
      title: '', summary: '', excerpt: '', pageStart: 10, pageEnd: 12,
      category: 'CONCEPT', updatedAt: REVIEW_UPDATED_AT,
    })
    const { response, body } = await getReviewPage()
    expect(response.status).toBe(200)
    expect(body.items.map((item: any) => item.id)).toContain('review-fully-empty')
  })

  test('review queue and cursor are cleared when the administrator switches programs', () => {
    const adminBooks = readFileSync(new URL('../../src/components/aact/AdminBooks.tsx', import.meta.url), 'utf8')
    const resetBlock = adminBooks.split('Review results are program-scoped.')[1]?.split('const [rebuildingBookId')[0] || ''
    expect(resetBlock).toContain('setManualReviewItems([])')
    expect(resetBlock).toContain('setManualReviewCursor(null)')
    expect(resetBlock).toContain('setManualReviewEditingId(null)')
    expect(resetBlock).toContain('}, [programId])')
  })
})
