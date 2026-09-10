import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { audit, notify } from '@/lib/notify'
import { getZAI, chatWithRetry } from '@/lib/ai'
import { ensureProgramKnowledge, getProgramKnowledgeItems } from '@/lib/knowledge-bank'

export const runtime = 'nodejs'
export const maxDuration = 180

type GuideSection = { title: string; summary: string; outcomes?: string[]; sourceTitles?: string[] }

type GeneratedGuide = {
  title: string
  overview: string
  objectives: string[]
  keyTerms: string[]
  sections: GuideSection[]
  activities: string[]
  discussionQuestions: string[]
  sourceKnowledgeIds?: string[]
}

function clean(value: unknown, max = 3000) {
  return String(value || '')
    .replace(/\u0000/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max)
}

function asInt(value: unknown, fallback: number, min: number, max: number) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.round(n)))
}

function asStatus(value: unknown) {
  const v = String(value || '').trim().toUpperCase()
  return ['DRAFT', 'PUBLISHED', 'ARCHIVED'].includes(v) ? v : 'PUBLISHED'
}

function jsonArray(value: unknown, fallback: any[] = []) {
  if (Array.isArray(value)) return value
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed : fallback
    } catch {
      return fallback
    }
  }
  return fallback
}

function parseJsonObject(raw: string): any | null {
  const body = String(raw || '').trim()
  try { return JSON.parse(body) } catch {}
  const fenced = body.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
  if (fenced) {
    try { return JSON.parse(fenced) } catch {}
  }
  const obj = body.match(/\{[\s\S]*\}/)?.[0]
  if (obj) {
    try { return JSON.parse(obj) } catch {}
  }
  return null
}

function normalizeGuide(raw: any, programTitle: string, semester: number, knowledge: any[]): GeneratedGuide {
  const top = knowledge.slice(0, 12)
  const title = clean(raw?.title, 220) || `دليل الدراسة — ${programTitle} — ${semester === 2 ? 'الفصل الثاني' : semester === 3 ? 'البحث/المشروع' : 'الفصل الأول'}`
  const overview = clean(raw?.overview, 5000) || `هذا الدليل يلخص أهم محاور ${programTitle} في هذا الفصل، ويربط محتوى الكتب المقررة بالتطبيق المهني والأسئلة المتوقعة.`
  const objectives = jsonArray(raw?.objectives)
    .map((x) => clean(x, 220))
    .filter(Boolean)
    .slice(0, 10)
  const keyTerms = jsonArray(raw?.keyTerms)
    .map((x) => clean(x, 90))
    .filter(Boolean)
    .slice(0, 18)
  const rawSections = jsonArray(raw?.sections)
  const sections = rawSections.map((s: any, i: number) => ({
    title: clean(s?.title, 180) || top[i]?.title || `محور دراسي ${i + 1}`,
    summary: clean(s?.summary, 1600) || top[i]?.summary || 'محور معرفي مستخرج من الكتب المقررة.',
    outcomes: jsonArray(s?.outcomes).map((x) => clean(x, 180)).filter(Boolean).slice(0, 5),
    sourceTitles: jsonArray(s?.sourceTitles).map((x) => clean(x, 160)).filter(Boolean).slice(0, 5),
  })).filter((s: GuideSection) => s.title && s.summary).slice(0, 8)

  const fallbackSections = top.slice(0, 6).map((k: any) => ({
    title: k.title,
    summary: k.summary,
    outcomes: [`شرح الفكرة وربطها بسياق ${programTitle}`, 'استخدام الفكرة في تحليل حالة مهنية أو سؤال امتحاني'],
    sourceTitles: [k.bookTitle || k.sourceNote || 'بنك المعرفة'].filter(Boolean),
  }))

  const activities = jsonArray(raw?.activities)
    .map((x) => clean(x, 300))
    .filter(Boolean)
    .slice(0, 8)
  const discussionQuestions = jsonArray(raw?.discussionQuestions)
    .map((x) => clean(x, 320))
    .filter(Boolean)
    .slice(0, 10)

  return {
    title,
    overview,
    objectives: objectives.length ? objectives : [`فهم محاور ${programTitle} الأساسية`, 'تحليل المحتوى وربطه بحالات مهنية', 'الاستعداد للواجبات والامتحانات الفصلية'],
    keyTerms: keyTerms.length ? keyTerms : top.map((k: any) => k.title).slice(0, 12),
    sections: sections.length ? sections : fallbackSections,
    activities: activities.length ? activities : ['اقرأ المحاور المحددة ثم اكتب ملخصاً نقدياً من 300 كلمة.', 'حوّل إحدى الأفكار إلى حالة تطبيقية مرتبطة ببيئتك المهنية.', 'استخرج ثلاثة أسئلة نقاشية من كل محور رئيسي.'],
    discussionQuestions: discussionQuestions.length ? discussionQuestions : top.slice(0, 8).map((k: any) => `كيف يمكن تطبيق فكرة «${k.title}» في سياق ${programTitle}؟`),
    sourceKnowledgeIds: Array.isArray(raw?.sourceKnowledgeIds) ? raw.sourceKnowledgeIds.map((x: any) => clean(x, 80)).filter(Boolean).slice(0, 60) : top.map((k: any) => k.id).filter(Boolean),
  }
}

async function generateStudyGuide(programId: string, semester: number): Promise<GeneratedGuide> {
  const program = await db.program.findUnique({ where: { id: programId }, select: { id: true, titleAr: true, titleEn: true, category: true, description: true } })
  if (!program) throw new Error('البرنامج غير موجود')

  const knowledgeSemester = semester === 3 ? null : semester
  await ensureProgramKnowledge(programId, knowledgeSemester, 8).catch(() => null)
  const knowledge = await getProgramKnowledgeItems(programId, knowledgeSemester, 60)
  if (!knowledge.length) throw new Error('لا يوجد بنك معرفة كافٍ لتوليد دليل دراسة. أضف كتباً أو ابنِ بنك المعرفة أولاً.')

  const context = knowledge.slice(0, 36).map((k, i) => {
    const source = k.bookTitle ? ` — من كتاب ${k.bookTitle}` : ''
    return `${i + 1}. ${k.title}: ${k.summary.slice(0, 380)}${k.excerpt ? ` — دليل: ${k.excerpt.slice(0, 220)}` : ''}${source}`
  }).join('\n')

  try {
    const zai = await getZAI()
    const raw = await Promise.race([
      chatWithRetry(zai, [
        { role: 'assistant', content: 'أنت مصمم دليل دراسة جامعي مهني. أعد JSON صالحاً فقط دون Markdown.' },
        { role: 'user', content: `أنشئ دليل دراسة عربي رسمي ومهني من بنك المعرفة التالي.

البرنامج: ${program.titleAr}
التصنيف: ${program.category}
الفصل: ${semester === 2 ? 'الثاني' : semester === 3 ? 'البحث/المشروع' : 'الأول'}
وصف البرنامج: ${program.description || '-'}

بنك المعرفة المستخرج من الكتب:
${context}

المطلوب JSON object فقط بهذه الحقول:
{
  "title": "عنوان الدليل",
  "overview": "مقدمة تعليمية واضحة",
  "objectives": ["هدف تعلم"],
  "keyTerms": ["مصطلح"],
  "sections": [{"title":"محور", "summary":"شرح تفصيلي من محتوى الكتب", "outcomes":["مخرج"], "sourceTitles":["مصدر/كتاب"]}],
  "activities": ["نشاط قراءة أو تطبيق"],
  "discussionQuestions": ["سؤال نقاش للمشرف الذكي أو المحاضر"],
  "sourceKnowledgeIds": ["id إن وجد"]
}

الشروط:
- الدليل يجب أن يكون من محتوى الكتب وبنك المعرفة، لا كلاماً عاماً.
- صِغ المحاور بلغة عربية أكاديمية واضحة.
- اجعل الدليل صالحاً للطالب قبل الامتحان والواجبات.
- لا تستخدم رموزاً تقنية مثل CONCEPT أو QUESTION_SEED.` },
      ], 2),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error('STUDY_GUIDE_TIMEOUT')), 30000)),
    ])
    const parsed = parseJsonObject(raw)
    return normalizeGuide(parsed || {}, program.titleAr, semester, knowledge)
  } catch (e: any) {
    console.error('study guide AI fallback:', String(e?.message || e).slice(0, 300))
    return normalizeGuide({}, program.titleAr, semester, knowledge)
  }
}

function mapGuide(g: any) {
  return {
    id: g.id,
    programId: g.programId,
    semester: g.semester,
    title: g.title,
    overview: g.overview,
    objectives: jsonArray(g.objectives),
    keyTerms: jsonArray(g.keyTerms),
    sections: jsonArray(g.sections),
    activities: jsonArray(g.activities),
    discussionQuestions: jsonArray(g.discussionQuestions),
    sourceKnowledgeIds: jsonArray(g.sourceKnowledgeIds),
    status: g.status,
    generatedBy: g.generatedBy,
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
  }
}

export async function GET(req: NextRequest) {
  try {
    await requireAdmin()
    const programId = req.nextUrl.searchParams.get('programId') || ''
    if (!programId) return NextResponse.json({ error: 'معرف البرنامج مطلوب' }, { status: 400 })
    const guides = await db.programStudyGuide.findMany({ where: { programId }, orderBy: [{ semester: 'asc' }, { updatedAt: 'desc' }] })
    return NextResponse.json({ guides: guides.map(mapGuide) })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('admin study guides GET error:', e)
    return NextResponse.json({ error: 'تعذر تحميل أدلة الدراسة' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const body = await req.json().catch(() => ({}))
    const programId = clean(body.programId, 80)
    const semester = asInt(body.semester, 1, 1, 3)
    const status = asStatus(body.status)
    if (!programId) return NextResponse.json({ error: 'معرف البرنامج مطلوب' }, { status: 400 })

    const generated = await generateStudyGuide(programId, semester)
    const guide = await db.programStudyGuide.upsert({
      where: { programId_semester: { programId, semester } },
      update: {
        title: generated.title,
        overview: generated.overview,
        objectives: JSON.stringify(generated.objectives),
        keyTerms: JSON.stringify(generated.keyTerms),
        sections: JSON.stringify(generated.sections),
        activities: JSON.stringify(generated.activities),
        discussionQuestions: JSON.stringify(generated.discussionQuestions),
        sourceKnowledgeIds: JSON.stringify(generated.sourceKnowledgeIds || []),
        status,
        generatedBy: 'AI',
      },
      create: {
        programId,
        semester,
        title: generated.title,
        overview: generated.overview,
        objectives: JSON.stringify(generated.objectives),
        keyTerms: JSON.stringify(generated.keyTerms),
        sections: JSON.stringify(generated.sections),
        activities: JSON.stringify(generated.activities),
        discussionQuestions: JSON.stringify(generated.discussionQuestions),
        sourceKnowledgeIds: JSON.stringify(generated.sourceKnowledgeIds || []),
        status,
        generatedBy: 'AI',
      },
    })

    await audit(admin, 'GENERATE_STUDY_GUIDE', 'ProgramStudyGuide', guide.id, `توليد دليل دراسة للفصل ${semester}: ${guide.title}`)
    if (status === 'PUBLISHED') {
      const enrollments = await db.enrollment.findMany({ where: { programId, status: 'ACTIVE' }, select: { userId: true } })
      await Promise.all(enrollments.map((e) => notify(e.userId, 'GENERAL', 'دليل دراسة جديد', `تم نشر دليل دراسة جديد: ${guide.title}`, 'dashboard')))
    }

    return NextResponse.json({ guide: mapGuide(guide) })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('admin study guides POST error:', e)
    return NextResponse.json({ error: e?.message || 'تعذر توليد دليل الدراسة' }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const body = await req.json().catch(() => ({}))
    const id = clean(body.id, 80)
    if (!id) return NextResponse.json({ error: 'معرف الدليل مطلوب' }, { status: 400 })
    const data: any = {}
    if (body.title != null) data.title = clean(body.title, 220)
    if (body.overview != null) data.overview = clean(body.overview, 7000)
    if (body.status != null) data.status = asStatus(body.status)
    if (body.objectives != null) data.objectives = JSON.stringify(jsonArray(body.objectives).map((x) => clean(x, 220)).filter(Boolean))
    if (body.keyTerms != null) data.keyTerms = JSON.stringify(jsonArray(body.keyTerms).map((x) => clean(x, 90)).filter(Boolean))
    if (body.activities != null) data.activities = JSON.stringify(jsonArray(body.activities).map((x) => clean(x, 300)).filter(Boolean))
    if (body.discussionQuestions != null) data.discussionQuestions = JSON.stringify(jsonArray(body.discussionQuestions).map((x) => clean(x, 320)).filter(Boolean))

    const guide = await db.programStudyGuide.update({ where: { id }, data })
    await audit(admin, 'UPDATE_STUDY_GUIDE', 'ProgramStudyGuide', guide.id, `تعديل دليل دراسة: ${guide.title}`)
    return NextResponse.json({ guide: mapGuide(guide) })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('admin study guides PATCH error:', e)
    return NextResponse.json({ error: 'تعذر تحديث دليل الدراسة' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const id = req.nextUrl.searchParams.get('id') || ''
    if (!id) return NextResponse.json({ error: 'معرف الدليل مطلوب' }, { status: 400 })
    const existing = await db.programStudyGuide.findUnique({ where: { id }, select: { title: true } })
    await db.programStudyGuide.delete({ where: { id } })
    await audit(admin, 'DELETE_STUDY_GUIDE', 'ProgramStudyGuide', id, `حذف دليل دراسة: ${existing?.title || id}`)
    return NextResponse.json({ ok: true })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('admin study guides DELETE error:', e)
    return NextResponse.json({ error: 'تعذر حذف دليل الدراسة' }, { status: 500 })
  }
}
