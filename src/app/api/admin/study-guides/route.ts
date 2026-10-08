import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { audit } from '@/lib/notify'

export const runtime = 'nodejs'
export const maxDuration = 180

type GuideSection = { title: string; summary: string; outcomes?: string[]; sourceTitles?: string[]; sourceKnowledgeIds?: string[]; pageRefs?: string[] }

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

async function unitGuidesForProgram(programId: string, semester: number) {
  const units = await db.unit.findMany({
    where: { programId, ...(semester === 3 ? {} : { semester }) },
    orderBy: [{ semester: 'asc' }, { order: 'asc' }],
    select: { id: true, title: true, semester: true, objectives: true, summary: true, sourceBookId: true, outlineSectionId: true },
  })
  const guides = units.length ? await db.programStudyGuide.findMany({ where: { unitId: { in: units.map((unit) => unit.id) }, status: { in: ['DRAFT', 'PUBLISHED'] } } }) : []
  const guideByUnit = new Map(guides.map((guide) => [guide.unitId, guide]))
  const missing = units.filter((unit) => !guideByUnit.has(unit.id))
  return { units, guides, guideByUnit, missing }
}

async function buildSemesterGuide(programId: string, semester: number) {
  const program = await db.program.findUnique({ where: { id: programId }, select: { id: true, titleAr: true, titleEn: true } })
  if (!program) throw new Error('PROGRAM_NOT_FOUND')
  const { units, guideByUnit, missing } = await unitGuidesForProgram(programId, semester)
  if (!units.length) throw new Error('لا توجد وحدات لهذا النطاق. ولّد الوحدات ومحتواها أولاً.')
  if (missing.length) throw new Error(`ولّد محتوى الوحدة ${missing[0].title} أولاً`)

  const unitGuides = units.map((unit) => ({ unit, guide: guideByUnit.get(unit.id)! })).filter((entry) => entry.guide)
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
      sourceTitles: [unit.title],
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
    sourceKnowledgeIds,
  }
}

export async function GET(req: NextRequest) {
  try {
    await requireAdmin()
    const programId = clean(req.nextUrl.searchParams.get('programId'), 80)
    if (!programId) return NextResponse.json({ error: 'معرف البرنامج مطلوب' }, { status: 400 })
    const guides = await db.programStudyGuide.findMany({ where: { programId }, orderBy: [{ semester: 'asc' }, { updatedAt: 'desc' }] })
    return NextResponse.json({ guides: guides.map(mapGuide) })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    return NextResponse.json({ error: 'تعذر تحميل أدلة الدراسة' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const body = await req.json().catch(() => ({}))
    const programId = clean(body.programId, 80)
    const semester = Math.max(1, Math.min(3, Number(body.semester || 1)))
    const status = ['DRAFT', 'PUBLISHED', 'ARCHIVED'].includes(String(body.status || '').toUpperCase()) ? String(body.status).toUpperCase() : 'DRAFT'
    if (!programId) return NextResponse.json({ error: 'معرف البرنامج مطلوب' }, { status: 400 })
    const generated = await buildSemesterGuide(programId, semester)
    const existing = await db.programStudyGuide.findFirst({ where: { programId, semester, unitId: null }, select: { id: true } })
    const data = { title: generated.title, overview: generated.overview, objectives: json(generated.objectives), keyTerms: json(generated.keyTerms), sections: json(generated.sections), activities: json(generated.activities), discussionQuestions: json(generated.discussionQuestions), sourceKnowledgeIds: json(generated.sourceKnowledgeIds), status, generatedBy: 'AI' }
    const guide = existing ? await db.programStudyGuide.update({ where: { id: existing.id }, data }) : await db.programStudyGuide.create({ data: { programId, semester, unitId: null, ...data } })
    await audit({ id: admin.id, name: admin.name }, 'GENERATE_STUDY_GUIDE', 'Program', programId, `توليد ${generated.title} من أدلة الوحدات`)
    if (status === 'PUBLISHED') await notify({ title: 'تم نشر دليل دراسة عام', message: generated.title, audience: 'STUDENTS' }).catch(() => null)
    return NextResponse.json({ guide: mapGuide(guide) })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('study guide POST error:', e)
    return NextResponse.json({ error: e?.message || 'تعذر توليد دليل الدراسة' }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  try {
    await requireAdmin()
    const body = await req.json().catch(() => ({}))
    const id = clean(body.id, 80)
    if (!id) return NextResponse.json({ error: 'معرف الدليل مطلوب' }, { status: 400 })
    const data: any = {}
    for (const key of ['title', 'overview']) if (body[key] !== undefined) data[key] = clean(body[key], key === 'title' ? 220 : 4000)
    for (const key of ['objectives', 'keyTerms', 'sections', 'activities', 'discussionQuestions', 'sourceKnowledgeIds']) if (body[key] !== undefined) data[key] = JSON.stringify(Array.isArray(body[key]) ? body[key] : [])
    if (body.status !== undefined && ['DRAFT', 'PUBLISHED', 'ARCHIVED'].includes(String(body.status).toUpperCase())) data.status = String(body.status).toUpperCase()
    const guide = await db.programStudyGuide.update({ where: { id }, data })
    return NextResponse.json({ guide: mapGuide(guide) })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    return NextResponse.json({ error: 'تعذر تحديث دليل الدراسة' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  try {
    await requireAdmin()
    const id = clean(req.nextUrl.searchParams.get('id'), 80)
    if (!id) return NextResponse.json({ error: 'معرف الدليل مطلوب' }, { status: 400 })
    await db.programStudyGuide.delete({ where: { id } })
    return NextResponse.json({ ok: true })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    return NextResponse.json({ error: 'تعذر حذف دليل الدراسة' }, { status: 500 })
  }
}
