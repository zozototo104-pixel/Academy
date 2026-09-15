import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { audit, notify } from '@/lib/notify'
import { getZAI, chatWithRetry } from '@/lib/ai'
import { geminiCompleteJson } from '@/lib/gemini'
import { ensureProgramKnowledge, getProgramKnowledgeItems, cleanAcademicGeneratedText, looksLikeBrokenAcademicOutput, KNOWLEDGE_BANK_LIMITS } from '@/lib/knowledge-bank'
import { conciseAcademicLabel, sanitizeAcademicLabelList, normalizeAcademic } from '@/lib/academic-output-quality'

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

function cleanGuideText(value: unknown, fallback: string, max = 3000, allowShort = false) {
  const cleaned = cleanAcademicGeneratedText(value, max)
  return cleaned && !looksLikeBrokenAcademicOutput(cleaned, { allowShort }) ? cleaned : fallback
}

function cleanGuideList(values: unknown, fallback: string[], maxItems: number, maxChars: number) {
  const seen = new Set<string>()
  const out: string[] = []
  const raw = Array.isArray(values) ? values : []
  for (const item of [...raw, ...fallback]) {
    const cleaned = cleanAcademicGeneratedText(item, maxChars)
    const key = cleaned.toLowerCase().replace(/\s+/g, ' ')
    if (!key || seen.has(key) || looksLikeBrokenAcademicOutput(cleaned, { allowShort: true })) continue
    seen.add(key)
    out.push(cleaned)
    if (out.length >= maxItems) break
  }
  return out
}

function guideCategoryLabel(category: string) {
  const labels: Record<string, string> = {
    SUMMARY: 'الخلاصة الدراسية',
    CONCEPT: 'المفاهيم المركزية',
    DEFINITION: 'المصطلحات والتعريفات',
    THEORY: 'النظريات والأطر',
    METHOD: 'منهجيات التطبيق',
    CASE: 'الحالات العملية',
    QUESTION_SEED: 'أسئلة المراجعة',
  }
  return labels[String(category || '').toUpperCase()] || 'محور دراسي'
}

function levelLabel(category?: string | null) {
  const c = String(category || '').toUpperCase()
  if (c.includes('DIPLOMA')) return 'الدبلوم المهني'
  if (c.includes('MASTER')) return 'الماجستير المهني'
  if (c.includes('DOCTOR')) return 'الدكتوراه المهنية'
  return 'الدراسات المهنية'
}

function labelIsDisplayable(value: string) {
  const n = normalizeAcademic(value)
  if (!n) return false
  if (/\b(?:concept|theory|method|case|definition|question_seed|summary)\b/i.test(value)) return false
  if (/(?:من النص|من الكتاب|مستخرجه من النص|مستخرجة من النص|بذره سؤال|بذرة سؤال|حاله تطبيقيه من|حالة تطبيقية من)/u.test(n)) return false
  const words = value.split(/\s+/).filter(Boolean)
  return words.length >= 2 && words.length <= 8 && value.length <= 90 && !looksLikeBrokenAcademicOutput(value, { allowShort: true })
}

function deriveGuideTerms(knowledge: any[], programTitle: string) {
  const raw: string[] = []
  for (const k of knowledge) {
    const title = conciseAcademicLabel(k?.title, '', 80)
    if (title) raw.push(title)
    const kws = Array.isArray(k?.keywords) ? k.keywords.map((x: any) => cleanAcademicGeneratedText(x, 40)).filter(Boolean) : []
    for (let i = 0; i < Math.min(kws.length - 1, 6); i += 2) raw.push(`${kws[i]} و${kws[i + 1]}`)
  }
  const fallback = [
    `محاور ${programTitle}`,
    'التطبيق المهني',
    'تحليل الحالات',
    'مؤشرات الأداء',
    'أسئلة الامتحان',
    'التقييم النقدي',
  ]
  return sanitizeAcademicLabelList(raw, fallback, 14, 72).filter(labelIsDisplayable)
}

function fallbackGuideSections(programTitle: string, semester: number, knowledge: any[]): GuideSection[] {
  const cleanKnowledge = knowledge
    .map((k, i) => ({
      ...k,
      category: String(k?.category || 'CONCEPT').toUpperCase(),
      title: conciseAcademicLabel(k?.title, `محور دراسي ${i + 1}`, 92),
      summary: cleanGuideText(k?.summary, `محور معرفي منظم من الكتب المقررة في ${programTitle}.`, 1800),
    }))
    .filter((k) => labelIsDisplayable(k.title) && k.summary && !looksLikeBrokenAcademicOutput(k.summary))

  const picked: any[] = []
  for (const cat of ['SUMMARY', 'CONCEPT', 'DEFINITION', 'THEORY', 'METHOD', 'CASE', 'QUESTION_SEED']) {
    const found = cleanKnowledge.find((k) => k.category === cat && !picked.some((p) => p.id === k.id))
    if (found) picked.push(found)
  }
  for (const item of cleanKnowledge) {
    if (picked.length >= 8) break
    if (!picked.some((p) => p.id === item.id || normalizeAcademic(p.title) === normalizeAcademic(item.title))) picked.push(item)
  }

  return picked.slice(0, 8).map((k, i) => ({
    title: k.category === 'SUMMARY' ? k.title : `${guideCategoryLabel(k.category)}: ${k.title}`,
    summary: cleanGuideText(
      `${k.summary} يدرس الطالب هذا المحور بوصفه جزءاً من ${programTitle} في الفصل ${semester}، مع التركيز على المعنى، شروط التطبيق، حدود التعميم، ومؤشرات التحقق في الواجب أو الامتحان.`,
      `محور دراسي تطبيقي في ${programTitle}.`,
      1700
    ),
    outcomes: cleanGuideList([], [
      `شرح ${k.title} بلغة أكاديمية واضحة`,
      `ربط ${k.title} بحالة مهنية في ${programTitle}`,
      'تمييز شروط التطبيق وحدود التعميم',
    ], 4, 180),
    sourceTitles: cleanGuideList([], [k.bookTitle || 'بنك المعرفة الأكاديمي'], 4, 160),
  }))
}

function guideLooksStrong(guide: GeneratedGuide) {
  const deepSections = guide.sections.filter((s) => s.summary.length >= 140 && !looksLikeBrokenAcademicOutput(`${s.title}. ${s.summary}`))
  return guide.objectives.length >= 3 && guide.keyTerms.length >= 6 && deepSections.length >= 5 && guide.discussionQuestions.length >= 3
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

function normalizeGuide(
  raw: any,
  program: { titleAr: string; titleEn?: string | null; category?: string | null; description?: string | null },
  semester: number,
  knowledge: any[]
): GeneratedGuide {
  const programTitle = cleanGuideText(program.titleAr || program.titleEn, 'البرنامج الأكاديمي', 220, true)
  const level = levelLabel(program.category)
  const top = knowledge.slice(0, 28)
  const fallbackSections = fallbackGuideSections(programTitle, semester, top)
  const fallbackTerms = deriveGuideTerms(top, programTitle)
  const semLabel = semester === 2 ? 'الفصل الثاني' : semester === 3 ? 'البحث/المشروع' : 'الفصل الأول'
  const fallbackTitle = `دليل الدراسة التحليلي — ${programTitle} — ${semLabel}`
  const title = cleanGuideText(raw?.title, fallbackTitle, 220, true)
  const overview = cleanGuideText(
    raw?.overview,
    `هذا الدليل يحوّل بنك المعرفة المستخرج من الكتب المقررة في ${programTitle} إلى خطة مذاكرة عملية بمستوى ${level}: مفاهيم مركزية، أطر تفسير، منهجيات تطبيق، حالات مهنية، وأسئلة مراجعة مرتبطة بالواجبات والامتحانات.`,
    5000
  )
  const objectives = cleanGuideList(raw?.objectives, [
    `تحليل محاور ${programTitle} كما ظهرت في الكتب المقررة`,
    'تمييز المفاهيم والتعريفات عن الحالات والأسئلة التطبيقية',
    `ربط المعرفة بمستوى ${level} من حيث العمق والتحليل والنقد`,
    'تحويل القراءة إلى إجابات امتحانية وواجبات قابلة للقياس',
  ], 10, 260)
  const keyTerms = sanitizeAcademicLabelList(jsonArray(raw?.keyTerms), fallbackTerms, 14, 72).filter(labelIsDisplayable)
  const rawSections = jsonArray(raw?.sections)
  const sections = rawSections.map((s: any, i: number) => {
    const fb = fallbackSections[i] || fallbackSections[0] || {
      title: `محور دراسي ${i + 1}`,
      summary: `محور معرفي منظم من الكتب المقررة في ${programTitle}.`,
      outcomes: [`شرح المحور وربطه بسياق ${programTitle}`],
      sourceTitles: ['بنك المعرفة الأكاديمي'],
    }
    return {
      title: conciseAcademicLabel(s?.title, fb.title, 120),
      summary: cleanGuideText(s?.summary, fb.summary, 1800),
      outcomes: cleanGuideList(s?.outcomes, fb.outcomes || [`شرح المحور وربطه بسياق ${programTitle}`], 5, 200),
      sourceTitles: cleanGuideList(s?.sourceTitles, fb.sourceTitles || ['بنك المعرفة الأكاديمي'], 5, 160),
    }
  }).filter((s: GuideSection) => s.title && s.summary && labelIsDisplayable(s.title) && !looksLikeBrokenAcademicOutput(`${s.title}. ${s.summary}`)).slice(0, 8)

  const activities = cleanGuideList(raw?.activities, [
    'اختر ثلاثة محاور من الدليل واكتب لكل محور معنى الفكرة، دليلها من الكتاب، وتطبيقها المهني.',
    'حوّل إحدى الحالات أو الأفكار إلى سيناريو مهني مع قرار، بدائل، ومؤشر نجاح.',
    'صمّم بطاقة مراجعة لكل محور: مصطلح، إطار، مثال، سؤال محتمل، ومعيار إجابة.',
  ], 8, 340)
  const discussionQuestions = cleanGuideList(raw?.discussionQuestions, fallbackSections.slice(0, 8).map((s) => `كيف يغيّر محور «${conciseAcademicLabel(s.title, 'هذا المحور', 80)}» طريقة تحليل حالة مهنية في ${programTitle}؟`), 10, 340)

  const guide: GeneratedGuide = {
    title,
    overview,
    objectives,
    keyTerms: keyTerms.length >= 6 ? keyTerms : fallbackTerms,
    sections: sections.length >= 5 ? sections : fallbackSections,
    activities,
    discussionQuestions,
    sourceKnowledgeIds: Array.isArray(raw?.sourceKnowledgeIds) ? raw.sourceKnowledgeIds.map((x: any) => clean(x, 80)).filter(Boolean).slice(0, 60) : top.map((k: any) => k.id).filter(Boolean),
  }

  if (guideLooksStrong(guide)) return guide
  return {
    ...guide,
    keyTerms: fallbackTerms,
    sections: fallbackSections.length ? fallbackSections : guide.sections,
    discussionQuestions: guide.discussionQuestions.length >= 3 ? guide.discussionQuestions : cleanGuideList([], fallbackSections.slice(0, 6).map((s) => `ما شروط تطبيق محور «${conciseAcademicLabel(s.title, 'هذا المحور', 80)}» وما حدوده في ${programTitle}؟`), 8, 340),
  }
}

async function generateStudyGuide(programId: string, semester: number): Promise<GeneratedGuide> {
  const program = await db.program.findUnique({ where: { id: programId }, select: { id: true, titleAr: true, titleEn: true, category: true, description: true } })
  if (!program) throw new Error('البرنامج غير موجود')

  const knowledgeSemester = semester === 3 ? null : semester
  await ensureProgramKnowledge(programId, knowledgeSemester, KNOWLEDGE_BANK_LIMITS.minContextItems).catch(() => null)
  const knowledge = await getProgramKnowledgeItems(programId, knowledgeSemester, 80)
  if (!knowledge.length) throw new Error('لا يوجد بنك معرفة كافٍ لتوليد دليل دراسة. أضف كتباً أو ابنِ بنك المعرفة أولاً.')

  const context = knowledge.slice(0, 56).map((k, i) => {
    const title = conciseAcademicLabel(k.title, `محور ${i + 1}`, 90)
    const source = k.bookTitle ? ` — من كتاب ${cleanGuideText(k.bookTitle, 'الكتاب المقرر', 120, true)}` : ''
    const evidence = k.excerpt ? ` — دليل/إشارة: ${cleanGuideText(k.excerpt, '', 240)}` : ''
    return `${i + 1}. [${guideCategoryLabel(k.category)}] ${title}. ${cleanGuideText(k.summary, '', 460)}${evidence}${source}`
  }).join('\n')

  const guidePrompt = `أنشئ دليل دراسة عربي رسمي ومهني من بنك المعرفة التالي.

البرنامج: ${program.titleAr}
التصنيف: ${program.category}
الفصل: ${semester === 2 ? 'الثاني' : semester === 3 ? 'البحث/المشروع' : 'الأول'}
وصف البرنامج: ${program.description || '-'}

محتوى منظم من الكتب المقررة:
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
- الدليل يجب أن يكون من محتوى الكتب وبنك المعرفة، لا كلاماً عاماً ولا شعارات.
- اجعل البنية مناسبة للتخصص الحقيقي والدرجة: الدبلوم عملي، الماجستير تحليلي تطبيقي، الدكتوراه نقدي بحثي.
- keyTerms يجب أن تكون 8-14 مصطلحاً/محوراً قصيراً من كلمتين إلى أربع كلمات مثل «تحليل المخاطر» أو «القرار الاستراتيجي»، وليست جملاً طويلة ولا عناوين تبدأ بـ «حالة تطبيقية» أو «منهجية».
- sections يجب أن تكون 6-8 محاور دراسية مرتبة: مفهوم/تعريف، إطار أو نظرية، منهجية، حالة تطبيقية، سؤال مراجعة، وخلاصة امتحانية عند توفرها.
- كل section.summary يجب أن يشرح: معنى المحور، لماذا هو مهم للدرجة، كيف يطبّق في التخصص، وما الخطأ الشائع في فهمه.
- لا تستخدم رموزاً تقنية مثل CONCEPT أو QUESTION_SEED أو عبارات داخلية مثل «من النص» و«مستخرجة من النص».
- لا تستخدم Markdown أو ** داخل أي حقل.
- لا تنقل أي جملة تبدو OCR مشوهة أو مختلطة اللغات، مثل أسماء كتب أجنبية داخل جملة عربية أو سنوات غير منطقية 8121/8115/8518.
- إذا كان المصدر مشوشاً، أعد صياغة المعنى الأكاديمي المفهوم فقط أو تجاهل المقطع.
- لا تكتفِ بعناوين عامة؛ كل محور يجب أن يستند إلى عنصر معرفة محدد ظاهر في السياق ويُصاغ كدليل دراسة مفهوم للطالب.`

  try {
    const raw = await Promise.race([
      geminiCompleteJson({
        system: 'أنت مصمم دليل دراسة جامعي مهني. أعد JSON object صالحاً فقط دون Markdown.',
        history: [{ role: 'user', text: guidePrompt }],
        temperature: 0.12,
        maxOutputTokens: 8192,
      }),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error('STUDY_GUIDE_GEMINI_TIMEOUT')), 38000)),
    ])
    const parsed = parseJsonObject(raw)
    return normalizeGuide(parsed || {}, program.titleAr, semester, knowledge)
  } catch (e: any) {
    console.error('study guide Gemini fallback:', String(e?.message || e).slice(0, 300))
  }

  try {
    const zai = await getZAI()
    const raw = await Promise.race([
      chatWithRetry(zai, [
        { role: 'assistant', content: 'أنت مصمم دليل دراسة جامعي مهني. أعد JSON صالحاً فقط دون Markdown.' },
        { role: 'user', content: guidePrompt },
      ], 2),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error('STUDY_GUIDE_ZAI_TIMEOUT')), 30000)),
    ])
    const parsed = parseJsonObject(raw)
    return normalizeGuide(parsed || {}, program.titleAr, semester, knowledge)
  } catch (e: any) {
    console.error('study guide AI fallback:', String(e?.message || e).slice(0, 300))
    return normalizeGuide({}, program.titleAr, semester, knowledge)
  }
}

function mapGuide(g: any) {
  const sections = jsonArray(g.sections).map((s: any, i: number) => ({
    title: cleanGuideText(s?.title, `محور دراسي ${i + 1}`, 180, true),
    summary: cleanGuideText(s?.summary, 'محور دراسي منظم من الكتب المقررة.', 1600),
    outcomes: cleanGuideList(s?.outcomes, ['فهم المحور وربطه بالتطبيق المهني'], 5, 180),
    sourceTitles: cleanGuideList(s?.sourceTitles, ['بنك المعرفة'], 5, 160),
  })).filter((s: GuideSection) => s.title && s.summary && !looksLikeBrokenAcademicOutput(`${s.title}. ${s.summary}`))
  return {
    id: g.id,
    programId: g.programId,
    semester: g.semester,
    title: cleanGuideText(g.title, 'دليل الدراسة', 220, true),
    overview: cleanGuideText(g.overview, 'دليل دراسة منظم يربط الكتب المقررة بالتطبيق المهني والاختبارات.', 7000),
    objectives: cleanGuideList(jsonArray(g.objectives), ['فهم محاور الدليل', 'ربط المعرفة بالتطبيق المهني'], 10, 220),
    keyTerms: cleanGuideList(jsonArray(g.keyTerms), [], 18, 90),
    sections,
    activities: cleanGuideList(jsonArray(g.activities), ['قراءة المحاور ثم كتابة ملخص تطبيقي قصير.'], 8, 300),
    discussionQuestions: cleanGuideList(jsonArray(g.discussionQuestions), ['كيف تربط محتوى الدليل بحالة مهنية واقعية؟'], 10, 320),
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
