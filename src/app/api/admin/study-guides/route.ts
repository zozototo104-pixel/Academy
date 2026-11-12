import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { audit } from '@/lib/notify'
import { buildUnitStudyGuideDraft, type UnitContentSection } from '@/lib/outline-units'
import { withTimedResponse, withTiming } from '@/lib/timing'

export const runtime = 'nodejs'
export const maxDuration = 180

type GuideSection = { title: string; summary: string; outcomes?: string[]; sourceTitles?: string[]; sourceKnowledgeIds?: string[]; pageRefs?: string[]; sourceReviewRequired?: boolean }

function clean(value: unknown, max = 3000) {
  return String(value || '').replace(/\u0000/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max)
}

function parseArray(value: unknown): any[] {
  if (Array.isArray(value)) return value
  if (typeof value === 'string') { try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : [] } catch { return [] } }
  return []
}

function json(value: unknown[]) { return JSON.stringify(value || []) }
function unique<T>(items: T[]) { return [...new Set(items.filter(Boolean))] }

function mapGuide(g: any) {
  return {
    id: g.id,
    programId: g.programId,
    unitId: g.unitId || null,
    semester: g.semester,
    title: clean(g.title, 220),
    overview: clean(g.overview, 4000),
    objectives: parseArray(g.objectives).map((x) => clean(x, 220)).filter(Boolean),
    keyTerms: parseArray(g.keyTerms).map((x) => clean(x, 260)).filter(Boolean),
    sections: parseArray(g.sections) as GuideSection[],
    activities: parseArray(g.activities).map((x) => clean(x, 260)).filter(Boolean),
    discussionQuestions: parseArray(g.discussionQuestions).map((x) => clean(x, 280)).filter(Boolean),
    sourceKnowledgeIds: parseArray(g.sourceKnowledgeIds).map((x) => clean(x, 100)).filter(Boolean),
    status: g.status,
    updatedAt: g.updatedAt,
  }
}

function pageRefsFromSections(sections: GuideSection[]) {
  return unique(sections.flatMap((section) => Array.isArray(section.pageRefs) ? section.pageRefs.map((x) => clean(x, 80)) : []))
}

// Reject fabricated, deleted, cross-program or untraceable citations before
// creating or publishing a guide. Keep historical guides untouched for review.
async function assertStudyGuideReferences(programId: string, guide: { sourceKnowledgeIds?: unknown; sections?: unknown }) {
  const sections = parseArray(guide.sections) as GuideSection[]
  // Historical sections that lost all evidence remain visible in DRAFT for
  // recovery, but cannot be republished merely because other sections cite
  // valid knowledge items.
  if (sections.some((section) => section.sourceReviewRequired === true)) {
    throw new Error('STUDY_GUIDE_SECTION_SOURCE_REVIEW_REQUIRED')
  }
  const sourceIds = unique([
    ...parseArray(guide.sourceKnowledgeIds).map((id) => clean(id, 100)),
    ...sections.flatMap((section) => parseArray(section?.sourceKnowledgeIds).map((id) => clean(id, 100))),
  ])
  if (!sourceIds.length) throw new Error('STUDY_GUIDE_REQUIRES_SOURCE_KNOWLEDGE_IDS')

  const items = await db.bookKnowledgeItem.findMany({
    where: { id: { in: sourceIds } },
    select: { id: true, programId: true, bookId: true, chunkId: true, pageStart: true, pageEnd: true },
  })
  const books = await db.book.findMany({
    where: { id: { in: unique(items.map((item) => item.bookId).filter((id): id is string => !!id)) } },
    select: { id: true, programId: true },
  })
  const chunks = await db.bookChunk.findMany({
    where: { id: { in: unique(items.map((item) => item.chunkId).filter((id): id is string => !!id)) } },
    select: { id: true, programId: true, bookId: true, pageStart: true, pageEnd: true, status: true },
  })
  const itemById = new Map(items.map((item) => [item.id, item]))
  const bookById = new Map(books.map((book) => [book.id, book]))
  const chunkById = new Map(chunks.map((chunk) => [chunk.id, chunk]))
  const invalid = sourceIds.filter((id) => {
    const item = itemById.get(id)
    if (!item || item.programId !== programId || !item.bookId || !item.chunkId) return true
    const book = bookById.get(item.bookId)
    const chunk = chunkById.get(item.chunkId)
    return !book || book.programId !== programId ||
      !chunk || chunk.programId !== programId || chunk.bookId !== item.bookId ||
      chunk.status !== 'ANALYZED' ||
      item.pageStart == null || item.pageEnd == null ||
      item.pageStart < chunk.pageStart || item.pageEnd > chunk.pageEnd ||
      item.pageStart > item.pageEnd
  })
  if (invalid.length) throw new Error(`STUDY_GUIDE_INVALID_REFERENCES: ${invalid.length}/${sourceIds.length}; ${invalid.slice(0, 5).join(', ')}`)
}

async function unitGuidesForProgram(programId: string, semester: number) {
  const units = await withTiming('db_study_guides_units', () => db.unit.findMany({
    where: { programId, ...(semester === 3 ? {} : { semester }) },
    orderBy: [{ semester: 'asc' }, { order: 'asc' }],
    select: { id: true, title: true, semester: true, objectives: true, summary: true, content: true, sourceBookId: true, outlineSectionId: true, chunkStartIndex: true, chunkEndIndex: true },
  }))
  const guides = units.length ? await withTiming('db_study_guides_unit_guides', () => db.programStudyGuide.findMany({ where: { unitId: { in: units.map((unit) => unit.id) }, status: { in: ['DRAFT', 'PUBLISHED'] } } })) : []
  const guideByUnit = new Map(guides.filter((guide) => guide.unitId).map((guide) => [guide.unitId!, guide] as const))
  const missing = units.filter((unit) => !guideByUnit.has(unit.id))
  return { units, guides, guideByUnit, missing }
}

type ProgramUnit = Awaited<ReturnType<typeof unitGuidesForProgram>>['units'][number]

// A missing unit guide can be assembled from existing, sourced unit content.
// No model call, guessed source or new academic claim is needed.
async function buildMissingUnitGuide(programId: string, programTitle: string, unit: ProgramUnit, bookTitle: string) {
  const content = parseArray(unit.content) as UnitContentSection[]
  if (!content.length) throw new Error(`STUDY_GUIDE_UNIT_CONTENT_MISSING: «${unit.title}» ليس لها محتوى دراسي مولّد، ولا يمكن توليد دليل موثق لها.`)
  // Every saved heading is part of the source material, including short ones.
  // Never silently discard a populated section or build a "complete" guide
  // from only a subset of the unit's sections.
  const incompleteIndex = content.findIndex((section) => !section || typeof section.body !== 'string' || !section.body.trim())
  if (incompleteIndex !== -1) {
    throw new Error(`STUDY_GUIDE_UNIT_CONTENT_INCOMPLETE: المحور ${incompleteIndex + 1} في «${unit.title}» فارغ؛ صحح المحتوى قبل إنشاء الدليل.`)
  }
  if (!unit.sourceBookId) throw new Error(`STUDY_GUIDE_UNIT_SOURCE_MISSING: مصدر الوحدة «${unit.title}» غير محدد.`)
  const allIndexes = unique(content.flatMap((section) =>
    parseArray(section.sourceChunkIndexes).map(Number).filter(Number.isInteger)))
  if ((unit.chunkStartIndex == null || unit.chunkEndIndex == null) && !allIndexes.length) {
    throw new Error(`STUDY_GUIDE_UNIT_SOURCE_MISSING: نطاق مقاطع وحدة «${unit.title}» غير محدد.`)
  }

  const chunks = await db.bookChunk.findMany({
    where: {
      programId, bookId: unit.sourceBookId, status: 'ANALYZED',
      index: unit.chunkStartIndex != null && unit.chunkEndIndex != null
        ? { gte: unit.chunkStartIndex, lte: unit.chunkEndIndex }
        : { in: allIndexes },
    },
    select: { id: true, index: true, pageStart: true, pageEnd: true },
  })
  if (!chunks.length) throw new Error(`STUDY_GUIDE_UNIT_SOURCE_MISSING: لا توجد مقاطع محللة للوحدة «${unit.title}».`)
  const indexByChunk = new Map(chunks.map((chunk) => [chunk.id, chunk.index]))
  const knowledge = await db.bookKnowledgeItem.findMany({
    where: { programId, bookId: unit.sourceBookId, chunkId: { in: chunks.map((chunk) => chunk.id) } },
    select: { id: true, category: true, title: true, summary: true, excerpt: true, pageStart: true, pageEnd: true, chunkId: true },
    orderBy: [{ importance: 'desc' }, { createdAt: 'asc' }],
  })
  const knowledgeById = new Map(knowledge.map((item) => [item.id, item]))
  const pageRef = (start: number | null, end: number | null) =>
    start == null || end == null ? '' : start === end ? `صفحة ${start}` : `صفحات ${start}–${end}`
  const sections: GuideSection[] = content.map((section, index) => {
    const ids = unique(parseArray(section.sourceKnowledgeIds).map((id) => clean(id, 100)))
    const indexes = unique(parseArray(section.sourceChunkIndexes).map(Number).filter(Number.isInteger))
    // Page/chunk proximity is not proof that an item supports this heading.
    // Only IDs explicitly saved with this source section may be cited.
    const matched = ids.map((id) => knowledgeById.get(id)).filter((item): item is NonNullable<typeof item> => !!item)
    if (!ids.length || matched.length !== ids.length ||
        (indexes.length > 0 && matched.some((item) =>
          !item.chunkId || !indexes.includes(indexByChunk.get(item.chunkId) ?? -1)))) {
      throw new Error(`STUDY_GUIDE_UNIT_REFERENCES_MISSING: المحور ${index + 1} في «${unit.title}» يفتقد معرّفات معرفة موثقة لنفس مقاطع المحور؛ لا يجوز تخمين المراجع من المجاورة.`)
    }
    const refs = unique(matched.map((item) => pageRef(item.pageStart, item.pageEnd)).filter(Boolean))
    if (!refs.length) throw new Error(`STUDY_GUIDE_UNIT_REFERENCES_MISSING: لا توجد صفحات مثبتة للمحور ${index + 1} في «${unit.title}».`)
    return {
      title: clean(section.heading || `محور ${index + 1}`, 120),
      summary: clean(section.body, 1600),
      outcomes: [],
      sourceTitles: [bookTitle],
      sourceKnowledgeIds: matched.map((item) => item.id),
      pageRefs: refs,
    }
  })
  const selectedIds = unique(sections.flatMap((section) => section.sourceKnowledgeIds || []))
  const selectedKnowledge = selectedIds.map((id) => knowledgeById.get(id)!).filter(Boolean)
  const draft = buildUnitStudyGuideDraft({
    programTitle, unitTitle: unit.title, unitSummary: unit.summary,
    semester: unit.semester, knowledge: selectedKnowledge, unitContent: content,
  })
  const guide = {
    title: draft.title,
    overview: draft.overview,
    objectives: parseArray(unit.objectives).map((objective) => clean(objective, 220)).filter(Boolean).slice(0, 12),
    keyTerms: draft.keyTerms,
    sections,
    activities: draft.activities,
    discussionQuestions: draft.discussionQuestions,
    sourceKnowledgeIds: selectedIds,
  }
  await assertStudyGuideReferences(programId, guide)
  return { unitId: unit.id, semester: unit.semester, guide }
}

async function buildSemesterGuide(programId: string, semester: number) {
  const program = await withTiming('db_study_guides_program', () => db.program.findUnique({ where: { id: programId }, select: { id: true, titleAr: true, titleEn: true } }))
  if (!program) throw new Error('PROGRAM_NOT_FOUND')
  const { units, guideByUnit, missing } = await unitGuidesForProgram(programId, semester)
  if (!units.length) throw new Error('لا توجد وحدات لهذا النطاق. ولّد الوحدات ومحتواها أولاً.')

  const bookIds = unique(units.map((unit) => unit.sourceBookId).filter((id): id is string => !!id))
  const sectionIds = unique(units.map((unit) => unit.outlineSectionId).filter((id): id is string => !!id))
  const [sourceBooks, outlineSections] = await Promise.all([
    db.book.findMany({ where: { id: { in: bookIds }, programId }, select: { id: true, title: true } }),
    db.bookOutlineSection.findMany({ where: { id: { in: sectionIds } }, select: { id: true, outline: { select: { bookId: true } } } }),
  ])
  const existingBooks = new Set(sourceBooks.map((book) => book.id))
  const bookTitleById = new Map(sourceBooks.map((book) => [book.id, book.title]))
  const outlineBookById = new Map(outlineSections.map((section) => [section.id, section.outline.bookId]))
  const brokenUnits = units.filter((unit) =>
    (unit.sourceBookId && !existingBooks.has(unit.sourceBookId)) ||
    (unit.outlineSectionId && (!outlineBookById.has(unit.outlineSectionId) ||
      outlineBookById.get(unit.outlineSectionId) !== unit.sourceBookId))
  )
  if (brokenUnits.length) {
    throw new Error(`STUDY_GUIDE_UNIT_SOURCE_MISSING: ${brokenUnits.length} وحدة مرتبطة بكتاب أو فهرس مفقود. راجع مصادر الوحدات قبل التوليد.`)
  }
  const pendingUnitGuides: Awaited<ReturnType<typeof buildMissingUnitGuide>>[] = []
  for (const unit of missing) {
    const bookTitle = unit.sourceBookId ? bookTitleById.get(unit.sourceBookId) : null
    if (!bookTitle) throw new Error(`STUDY_GUIDE_UNIT_SOURCE_MISSING: لم يُعثر على كتاب الوحدة «${unit.title}».`)
    pendingUnitGuides.push(await buildMissingUnitGuide(programId, program.titleAr || program.titleEn || 'البرنامج الأكاديمي', unit, bookTitle))
  }
  const pendingById = new Map(pendingUnitGuides.map((item) => [item.unitId, item.guide]))
  const unitGuides = units.map((unit) => ({
    unit,
    guide: guideByUnit.get(unit.id) || pendingById.get(unit.id)!,
  }))
  const sourceKnowledgeIds = unique(unitGuides.flatMap(({ guide }) => parseArray(guide.sourceKnowledgeIds).map((id) => clean(id, 100))))
  if (!sourceKnowledgeIds.length) throw new Error('STUDY_GUIDE_REQUIRES_SOURCE_KNOWLEDGE_IDS')
  const title = semester === 3 ? 'دليل الفصل الدراسي العام للبحث/المشروع' : `دليل الفصل الدراسي العام ${semester === 2 ? 'الثاني' : 'الأول'}`
  const objectives = unique(unitGuides.flatMap(({ unit, guide }) => [...parseArray(unit.objectives), ...parseArray(guide.objectives)].map((x) => clean(x, 220)))).slice(0, 12)
  const keyTerms = unique(unitGuides.flatMap(({ guide }) => parseArray(guide.keyTerms).map((x) => clean(x, 260)))).slice(0, 30)
  const sections = unitGuides.map(({ unit, guide }) => {
    const parsed = parseArray(guide.sections) as GuideSection[]
    const refs = pageRefsFromSections(parsed)
    const guideIds = unique([...parseArray(guide.sourceKnowledgeIds).map((id) => clean(id, 100)), ...parsed.flatMap((section) => Array.isArray(section.sourceKnowledgeIds) ? section.sourceKnowledgeIds.map((id) => clean(id, 100)) : [])])
    return {
      title: unit.title,
      summary: clean(`${clean(unit.summary || guide.overview, 1100)}${refs.length ? ` مراجع الصفحات: ${refs.join('، ')}.` : ''}`, 1400),
      outcomes: parseArray(unit.objectives).map((x) => clean(x, 200)).filter(Boolean).slice(0, 5),
      sourceTitles: unit.sourceBookId && bookTitleById.has(unit.sourceBookId)
        ? [bookTitleById.get(unit.sourceBookId)!]
        : unique(parsed.flatMap((section) => Array.isArray(section.sourceTitles) ? section.sourceTitles : [])),
      sourceKnowledgeIds: guideIds,
      pageRefs: refs,
    }
  })
  const researchQuestions = semester === 3
    ? sections.slice(0, 10).map((section) => `ما سؤال البحث الممكن حول «${section.title}» اعتماداً على مراجع الصفحات: ${section.pageRefs?.join('، ') || 'مصادر الوحدة'}؟`)
    : sections.slice(0, 10).map((section) => `راجع ذاتياً: كيف تلخص وحدة «${section.title}» مع الاستناد إلى مراجع صفحاتها؟`)
  return {
    title,
    overview: clean(`يجمع هذا الدليل العام وحدات ${program.titleAr || program.titleEn || 'البرنامج'} المعتمدة في هذا النطاق. بُني الدليل من أدلة الوحدات نفسها، لذلك لا يضيف قوالب عامة ولا مصطلحات خارج الكتب؛ وتظهر مراجع الصفحات ومصادر المعرفة داخل كل قسم.`, 2200),
    objectives: objectives.length ? objectives : ['تلخيص وحدات الفصل اعتماداً على أدلتها ومراجع صفحاتها', 'ربط المصطلحات والتعريفات بمحاور الوحدات', 'استخدام أسئلة المراجعة الذاتية للتحقق من الفهم'],
    keyTerms,
    sections,
    activities: semester === 3
      ? ['اختر محوراً من كل وحدة وحوله إلى سؤال بحثي قابل للمناقشة.', 'اربط كل سؤال بحثي بمصدر معرفة وصفحات محددة.', 'ميّز المنهجية المناسبة لكل محور قبل كتابة خطة البحث.']
      : ['راجع كل وحدة من مراجع صفحاتها قبل الانتقال إلى الوحدة التالية.', 'اكتب بطاقة مراجعة لكل مصطلح أساسي مع رقم الصفحة.', 'أجب عن أسئلة المراجعة الذاتية دون تحويلها إلى أسئلة امتحانية.'],
    discussionQuestions: researchQuestions,
    sourceKnowledgeIds: unique([...sourceKnowledgeIds, ...sections.flatMap((section) => section.sourceKnowledgeIds)]),
    pendingUnitGuides,
  }
}

export async function GET(req: NextRequest) {
  return withTimedResponse(async () => {
  try {
    await withTiming('db_require_admin', () => requireAdmin())
    const programId = clean(req.nextUrl.searchParams.get('programId'), 80)
    if (!programId) return NextResponse.json({ error: 'معرف البرنامج مطلوب' }, { status: 400 })
    const guides = await withTiming('db_study_guides_list', () => db.programStudyGuide.findMany({ where: { programId }, orderBy: [{ semester: 'asc' }, { updatedAt: 'desc' }] }))
    // Read-only health hints for historical guides: never delete or silently hide them.
    const refsByGuide = guides.map((guide) => unique([
      ...parseArray(guide.sourceKnowledgeIds).map((id) => clean(id, 100)),
      ...parseArray(guide.sections).flatMap((section) =>
        parseArray(section?.sourceKnowledgeIds).map((id) => clean(id, 100))),
    ]))
    const allIds = unique(refsByGuide.flat())
    const existingItems = allIds.length ? await db.bookKnowledgeItem.findMany({
      where: { id: { in: allIds }, programId },
      select: { id: true },
    }) : []
    const existingIds = new Set(existingItems.map((item) => item.id))
    return NextResponse.json({ guides: guides.map((guide, index) => {
      const missingReferenceIds = refsByGuide[index].filter((id) => !existingIds.has(id))
      const missingReferenceSections = (parseArray(guide.sections) as GuideSection[])
        .map((section, sectionIndex) => ({
          sectionIndex,
          title: clean(section?.title, 160) || `محور ${sectionIndex + 1}`,
          sourceTitles: parseArray(section?.sourceTitles).map((title) => clean(title, 160)),
          pageRefs: parseArray(section?.pageRefs).map((ref) => clean(ref, 80)),
          missingReferenceIds: unique(parseArray(section?.sourceKnowledgeIds)
            .map((id) => clean(id, 100)).filter((id) => !existingIds.has(id))),
        }))
        .filter((section) => section.missingReferenceIds.length > 0)
      return {
        ...mapGuide(guide),
        referenceCount: refsByGuide[index].length,
        missingReferenceCount: missingReferenceIds.length,
        // Historical missing IDs are diagnostics, not replacement suggestions.
        // Expose their original section/book/page claims to the administrator,
        // never silently substitute an unrelated knowledge item.
        missingReferenceIds,
        missingReferenceSections,
      }
    }) })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    return NextResponse.json({ error: 'تعذر تحميل أدلة الدراسة' }, { status: 500 })
  }
  })
}

export async function POST(req: NextRequest) {
  return withTimedResponse(async () => {
  try {
    const admin = await withTiming('db_require_admin', () => requireAdmin())
    const body = await req.json().catch(() => ({}))
    const programId = clean(body.programId, 80)
    const semester = Math.max(1, Math.min(3, Number(body.semester || 1)))
    const status = ['DRAFT', 'PUBLISHED', 'ARCHIVED'].includes(String(body.status || '').toUpperCase()) ? String(body.status).toUpperCase() : 'DRAFT'
    if (!programId) return NextResponse.json({ error: 'معرف البرنامج مطلوب' }, { status: 400 })
    const generated = await buildSemesterGuide(programId, semester)
    await assertStudyGuideReferences(programId, generated)
    const data = { title: generated.title, overview: generated.overview, objectives: json(generated.objectives), keyTerms: json(generated.keyTerms), sections: json(generated.sections), activities: json(generated.activities), discussionQuestions: json(generated.discussionQuestions), sourceKnowledgeIds: json(generated.sourceKnowledgeIds), status, generatedBy: 'AI' }
    // Persist missing unit drafts AND the semester guide atomically. Retrying
    // a click never makes duplicate unit guides or a duplicate semester guide.
    const guide = await withTiming('db_study_guides_atomic_save', () => db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`study-guide:${programId}:${semester}`}))`
      for (const draft of generated.pendingUnitGuides) {
        const existingUnit = await tx.programStudyGuide.findFirst({
          where: { programId, unitId: draft.unitId, status: { in: ['DRAFT', 'PUBLISHED'] } },
          select: { id: true },
        })
        if (existingUnit) continue
        const entry = draft.guide
        await tx.programStudyGuide.create({
          data: {
            programId, unitId: draft.unitId, semester: draft.semester, status: 'DRAFT',
            generatedBy: 'SOURCE_DERIVED', title: entry.title, overview: entry.overview,
            objectives: json(entry.objectives), keyTerms: json(entry.keyTerms), sections: json(entry.sections),
            activities: json(entry.activities), discussionQuestions: json(entry.discussionQuestions),
            sourceKnowledgeIds: json(entry.sourceKnowledgeIds),
          },
        })
      }
      const existing = await tx.programStudyGuide.findFirst({
        where: { programId, semester, unitId: null }, select: { id: true },
      })
      return existing
        ? tx.programStudyGuide.update({ where: { id: existing.id }, data })
        : tx.programStudyGuide.create({ data: { programId, semester, unitId: null, ...data } })
    }, { maxWait: 20_000, timeout: 30_000 }))
    await withTiming('db_audit_study_guides_generate', () => audit({ id: admin.id, name: admin.name }, 'GENERATE_STUDY_GUIDE', 'Program', programId, `توليد ${generated.title}؛ أدلة وحدات أُنشئت تلقائياً: ${generated.pendingUnitGuides.length}`))
      .catch((auditError) => console.error('Study guide audit failed after commit:', auditError))
    return NextResponse.json({ guide: mapGuide(guide), autoCreatedUnitGuides: generated.pendingUnitGuides.length })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    if (String(e?.message || '').startsWith('STUDY_GUIDE_')) {
      return NextResponse.json({ error: e.message }, { status: 422 })
    }
    console.error('study guide POST error:', e)
    return NextResponse.json({ error: e?.message || 'تعذر توليد دليل الدراسة' }, { status: 500 })
  }
  })
}

export async function PATCH(req: NextRequest) {
  return withTimedResponse(async () => {
  try {
    await withTiming('db_require_admin', () => requireAdmin())
    const body = await req.json().catch(() => ({}))
    const id = clean(body.id, 80)
    if (!id) return NextResponse.json({ error: 'معرف الدليل مطلوب' }, { status: 400 })
    const data: any = {}
    for (const key of ['title', 'overview']) if (body[key] !== undefined) data[key] = clean(body[key], key === 'title' ? 220 : 4000)
    for (const key of ['objectives', 'keyTerms', 'sections', 'activities', 'discussionQuestions', 'sourceKnowledgeIds']) if (body[key] !== undefined) data[key] = JSON.stringify(Array.isArray(body[key]) ? body[key] : [])
    if (body.status !== undefined && ['DRAFT', 'PUBLISHED', 'ARCHIVED'].includes(String(body.status).toUpperCase())) data.status = String(body.status).toUpperCase()
    const existing = await db.programStudyGuide.findUnique({
      where: { id },
      select: { programId: true, status: true, sourceKnowledgeIds: true, sections: true },
    })
    if (!existing) return NextResponse.json({ error: 'دليل الدراسة غير موجود' }, { status: 404 })
    const isPublishingOrRevisingReferences = (data.status === 'PUBLISHED' ||
      (existing.status === 'PUBLISHED' && (data.sourceKnowledgeIds !== undefined || data.sections !== undefined)))
    if (isPublishingOrRevisingReferences) {
      await assertStudyGuideReferences(existing.programId, {
        sourceKnowledgeIds: data.sourceKnowledgeIds ?? existing.sourceKnowledgeIds,
        sections: data.sections ?? existing.sections,
      })
    }
    const guide = await withTiming('db_study_guides_patch_update', () => db.programStudyGuide.update({ where: { id }, data }))
    return NextResponse.json({ guide: mapGuide(guide) })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    if (String(e?.message || '').startsWith('STUDY_GUIDE_')) {
      return NextResponse.json({ error: e.message }, { status: 422 })
    }
    return NextResponse.json({ error: 'تعذر تحديث دليل الدراسة' }, { status: 500 })
  }
  })
}

export async function DELETE(req: NextRequest) {
  return withTimedResponse(async () => {
  try {
    await withTiming('db_require_admin', () => requireAdmin())
    const id = clean(req.nextUrl.searchParams.get('id'), 80)
    if (!id) return NextResponse.json({ error: 'معرف الدليل مطلوب' }, { status: 400 })
    await withTiming('db_study_guides_delete', () => db.programStudyGuide.delete({ where: { id } }))
    return NextResponse.json({ ok: true })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    return NextResponse.json({ error: 'تعذر حذف دليل الدراسة' }, { status: 500 })
  }
  })
}
