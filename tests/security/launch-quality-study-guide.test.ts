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
