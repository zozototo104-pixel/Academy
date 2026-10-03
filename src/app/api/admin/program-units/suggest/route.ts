import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { geminiActiveTextModel, geminiCompleteJson } from '@/lib/gemini'
import { audit } from '@/lib/notify'
import { textAiDiagnostics } from '@/lib/text-ai'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

function cleanText(value: unknown, max = 1200) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function parseJsonObject(raw: string) {
  const text = String(raw || '').trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim()
  try { return JSON.parse(text) } catch {}
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1))
  throw new Error('INVALID_JSON')
}

function parseJsonArray(raw: string) {
  const text = String(raw || '').trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim()
  try { return JSON.parse(text) } catch {}
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1))
  throw new Error('INVALID_JSON_ARRAY')
}

function safeObjectives(value: unknown) {
  const arr = Array.isArray(value) ? value : []
  return arr.map((x) => cleanText(x, 260)).filter((x) => x.length > 10).slice(0, 6)
}

function safeContent(value: unknown) {
  const arr = Array.isArray(value) ? value : []
  return arr.map((x: any) => ({
    heading: cleanText(x?.heading, 160),
    body: cleanText(x?.body, 1200),
  })).filter((x) => x.heading.length > 3 && x.body.length > 20).slice(0, 8)
}

function textWindows(text: string, maxChars = 52000) {
  const source = String(text || '').replace(/\s+/g, ' ').trim()
  if (!source) return []
  if (source.length <= maxChars) return [{ locator: 'النص الكامل المتاح', text: source }]
  const windowSize = Math.floor(maxChars / 5)
  const points = [0, Math.floor(source.length * 0.2), Math.floor(source.length * 0.4), Math.floor(source.length * 0.65), Math.max(0, source.length - windowSize)]
  const seen = new Set<number>()
  return points.map((start, index) => {
    const safeStart = Math.max(0, Math.min(start, Math.max(0, source.length - windowSize)))
    if (seen.has(safeStart)) return null
    seen.add(safeStart)
    const end = Math.min(source.length, safeStart + windowSize)
    return { locator: `مقطع ${index + 1} من النص المستخرج (${safeStart}-${end})`, text: source.slice(safeStart, end) }
  }).filter(Boolean) as { locator: string; text: string }[]
}

function knowledgeKeywords(value: unknown) {
  const text = String(value || '').trim()
  if (!text) return []
  try {
    const parsed = JSON.parse(text)
    return Array.isArray(parsed) ? parsed.map((x) => cleanText(x, 60)).filter(Boolean).slice(0, 8) : []
  } catch {
    return text.split(/[،,]/).map((x) => cleanText(x, 60)).filter(Boolean).slice(0, 8)
  }
}

function evidenceItemsForBook(bookId: string, knowledgeItems: any[]) {
  return knowledgeItems
    .filter((item) => !item.bookId || item.bookId === bookId)
    .sort((a, b) => Number(b.importance || 0) - Number(a.importance || 0))
}

function buildKnowledgeLines(items: any[], maxItems = 80) {
  return items.slice(0, maxItems).map((item, index) => {
    const keywords = knowledgeKeywords(item.keywords)
    return [
      `${index + 1}. [${item.category || 'KNOWLEDGE'}] ${cleanText(item.title, 180)}`,
      `   ملخص: ${cleanText(item.summary, 500)}`,
      item.excerpt ? `   اقتباس/دليل: ${cleanText(item.excerpt, 380)}` : '',
      keywords.length ? `   كلمات مفتاحية: ${keywords.join('، ')}` : '',
      item.sourceNote ? `   ملاحظة مصدر: ${cleanText(item.sourceNote, 220)}` : '',
    ].filter(Boolean).join('\n')
  }).join('\n')
}

function hasReadableBookEvidence(book: any, items: any[]) {
  return cleanText(book.textContent, 1000).length >= 800 || items.some((item) => cleanText(item.summary || item.excerpt, 300).length >= 80)
}

async function analyzeBookForCurriculum(program: any, book: any, allKnowledgeItems: any[]) {
  const bookKnowledge = evidenceItemsForBook(book.id, allKnowledgeItems)
  const windows = textWindows(book.textContent || '', 52000)
  const hasBookText = windows.length > 0
  if (!hasBookText && !bookKnowledge.length) return null

  const textEvidence = windows.map((w) => `### ${w.locator}\n${w.text}`).join('\n\n')
  const knowledgeEvidence = buildKnowledgeLines(bookKnowledge, 120) || 'لا توجد عناصر بنك معرفة مرتبطة بهذا الكتاب.'

  const prompt = `
اقرأ وحلل هذا الكتاب لبناء وحدات منهجية مبنية على المصدر، وليس وحدات عامة.

البرنامج: ${program.titleAr}
تصنيف البرنامج: ${program.category}
وصف البرنامج: ${program.description || 'غير محدد'}
الكتاب: ${book.title}${book.author ? ` — ${book.author}` : ''}
الفصل المرتبط بالكتاب: ${book.semester || 'عام'}
وصف الكتاب في المنصة: ${book.description || 'غير محدد'}
سياسة القراءة: ${book.readingDepth || 'غير محددة'}
سياسة المستوى: ${book.levelPolicy || 'غير محددة'}
توجه التقييم: ${book.assessmentOrientation || 'غير محدد'}
حالة قراءة الرابط/الملف: ${book.linkReadStatus || 'غير محددة'}

بنك المعرفة المرتبط بالكتاب/البرنامج:
${knowledgeEvidence}

محتوى الكتاب المستخرج للقراءة والتحليل:
${textEvidence || 'لا يوجد textContent مستخرج؛ اعتمد فقط على بنك المعرفة المرتبط ولا تدّعِ قراءة نص غير موجود.'}

أخرج JSON صالح فقط بالشكل التالي:
{
  "bookTitle": "...",
  "coverageNote": "ما الذي اعتمدت عليه من نص الكتاب وبنك المعرفة، وما حدود التغطية",
  "themes": [
    {
      "title": "محور معرفي مستخرج من الكتاب",
      "summary": "تحليل موجز للمحور كما يظهر في النص/بنك المعرفة",
      "evidence": "عبارة أو وصف دليل من النص أو بنك المعرفة",
      "knowledgeTitles": ["عناوين عناصر معرفة داعمة"]
    }
  ],
  "suggestedUnits": [
    {
      "semester": 1,
      "title": "عنوان وحدة محدد من محتوى الكتاب",
      "summary": "ملخص خاص بالوحدة مستند إلى تحليل الكتاب",
      "objectives": ["هدف قابل للقياس ومخصص", "هدف قابل للقياس ومخصص", "هدف قابل للقياس ومخصص"],
      "content": [{"heading":"محور من الكتاب", "body":"شرح مرتبط بالدليل"}],
      "assessmentCriteria": ["معيار تقييم مرتبط بالمصدر"],
      "evidenceRefs": ["اسم الكتاب/عنوان المعرفة/المقطع المستخدم"]
    }
  ]
}

قواعد صارمة:
- لا تستخدم عبارات عامة مثل: فهم المفاهيم الأساسية، تحليل التطبيقات العملية، ربط المعرفة بالواقع المهني.
- كل وحدة يجب أن تستند إلى محور أو دليل من الكتاب أو بنك المعرفة.
- لا تكرر نفس الأهداف أو نفس الملخص بين الوحدات.
- إذا كان النص محدوداً، اذكر ذلك في coverageNote وقلل عدد الوحدات بدلاً من الاختراع.
- لا تكتب Markdown ولا أي نص خارج JSON.`

  try {
    const raw = await geminiCompleteJson({
      system: 'أنت محلل كتب ومصمم مناهج. اقرأ النص وبنك المعرفة أولاً، ثم استخرج وحدات مبررة بالأدلة. لا تولد وحدات عامة.',
      history: [{ role: 'user', text: prompt }],
      temperature: 0.2,
      thinkingBudget: 768,
      maxOutputTokens: 9000,
    })
    const parsed = parseJsonObject(raw)
    return {
      bookId: book.id,
      bookTitle: cleanText(parsed.bookTitle || book.title, 220),
      semester: Number(book.semester || 1),
      coverageNote: cleanText(parsed.coverageNote, 1200),
      themes: Array.isArray(parsed.themes) ? parsed.themes : [],
      suggestedUnits: Array.isArray(parsed.suggestedUnits) ? parsed.suggestedUnits : [],
      knowledgeCount: bookKnowledge.length,
      hasTextContent: hasBookText,
    }
  } catch (error) {
    console.error('book curriculum analysis failed:', book.id, error)
    return null
  }
}

function unitLooksGeneric(unit: any) {
  const haystack = [
    unit.title,
    unit.summary,
    ...(Array.isArray(unit.objectives) ? unit.objectives : []),
    ...(Array.isArray(unit.content) ? unit.content.map((x: any) => `${x?.heading || ''} ${x?.body || ''}`) : []),
  ].map((x) => cleanText(x, 800)).join(' | ')
  return /فهم المفاهيم الأساسية|تحليل التطبيقات العملية|ربط المعرفة بالواقع المهني|محتوى الوحدة|تعالج هذه الوحدة جانباً أساسياً|وحدة مقترحة لتنظيم دراسة/.test(haystack)
}

function normalizeEvidenceUnit(unit: any, fallbackSemester: number, index: number) {
  const title = cleanText(unit.title, 180)
  const summary = cleanText(unit.summary, 1000)
  const objectives = safeObjectives(unit.objectives)
  const content = safeContent(unit.content)
  const assessmentCriteria = safeObjectives(unit.assessmentCriteria)
  const evidenceRefs = Array.isArray(unit.evidenceRefs) ? unit.evidenceRefs.map((x: any) => cleanText(x, 220)).filter(Boolean).slice(0, 8) : []
  if (!title || !summary || objectives.length < 2 || content.length < 1 || unitLooksGeneric(unit)) return null
  return {
    semester: Math.max(1, Math.min(8, Number(unit.semester || fallbackSemester || Math.floor(index / 4) + 1))),
    title,
    summary,
    objectives,
    content,
    assessmentCriteria,
    bookTitles: Array.isArray(unit.bookTitles) ? unit.bookTitles.map((x: any) => cleanText(x, 180)).filter(Boolean).slice(0, 4) : [],
    evidenceRefs,
  }
}

async function generateUnitPlan(programId: string) {
  const program = await db.program.findUnique({
    where: { id: programId },
    include: {
      books: {
        select: {
          id: true,
          title: true,
          author: true,
          semester: true,
          description: true,
          textContent: true,
          linkReadStatus: true,
          linkReadNote: true,
          levelPolicy: true,
          readingDepth: true,
          assessmentOrientation: true,
        },
        orderBy: [{ semester: 'asc' }, { createdAt: 'asc' }],
      },
      knowledgeItems: {
        select: {
          id: true,
          bookId: true,
          semester: true,
          category: true,
          title: true,
          summary: true,
          excerpt: true,
          keywords: true,
          importance: true,
          sourceNote: true,
        },
        orderBy: [{ bookId: 'asc' }, { importance: 'desc' }, { createdAt: 'asc' }],
      },
    },
  })
  if (!program) return null
  const semestersCount = Math.max(1, Math.min(8, Number(program.semestersCount || 2)))

  const evidenceBooks = program.books.filter((book) => hasReadableBookEvidence(book, program.knowledgeItems))
  if (!evidenceBooks.length) {
    return {
      program,
      semestersCount,
      units: [],
      evidenceError: 'لا يمكن توليد وحدات موثوقة لأن كتب البرنامج لا تحتوي نصاً مستخرجاً ولا توجد عناصر كافية في بنك المعرفة. اقرأ/حلّل الكتب أولاً ثم أعد التوليد.',
    }
  }

  const analyses = (await Promise.all(evidenceBooks.map((book) => analyzeBookForCurriculum(program, book, program.knowledgeItems))))
    .filter(Boolean) as any[]

  const evidenceUnits = analyses.flatMap((analysis, analysisIndex) => {
    const bookTitle = cleanText(analysis.bookTitle, 180)
    return (Array.isArray(analysis.suggestedUnits) ? analysis.suggestedUnits : [])
      .map((unit: any, unitIndex: number) => normalizeEvidenceUnit({
        ...unit,
        bookTitles: Array.isArray(unit.bookTitles) && unit.bookTitles.length ? unit.bookTitles : [bookTitle],
        evidenceRefs: Array.isArray(unit.evidenceRefs) && unit.evidenceRefs.length
          ? unit.evidenceRefs
          : [bookTitle, cleanText(analysis.coverageNote, 220)].filter(Boolean),
      }, Number(unit.semester || analysis.semester || 1), analysisIndex * 10 + unitIndex))
      .filter(Boolean)
  }) as any[]

  if (!evidenceUnits.length) {
    return {
      program,
      semestersCount,
      units: [],
      evidenceError: 'تم العثور على كتب/معرفة، لكن تحليلها لم ينتج وحدات محددة بالأدلة. راجع جودة النص المستخرج وبنك المعرفة ثم أعد المحاولة.',
    }
  }

  const analysisManifest = analyses.map((analysis, index) => [
    `كتاب ${index + 1}: ${analysis.bookTitle}`,
    `الفصل: ${analysis.semester || 'عام'}`,
    `نص مستخرج: ${analysis.hasTextContent ? 'نعم' : 'لا'}`,
    `عدد عناصر بنك المعرفة: ${analysis.knowledgeCount}`,
    `حدود التغطية: ${analysis.coverageNote || 'غير محددة'}`,
    `محاور: ${(Array.isArray(analysis.themes) ? analysis.themes : []).slice(0, 10).map((theme: any) => cleanText(theme?.title, 120)).filter(Boolean).join('، ')}`,
  ].join('\n')).join('\n\n')

  const sourceUnitDrafts = evidenceUnits.map((unit, index) => [
    `# وحدة مصدرية ${index + 1}`,
    `الفصل: ${unit.semester}`,
    `العنوان: ${unit.title}`,
    `الملخص: ${unit.summary}`,
    `الأهداف: ${unit.objectives.join(' | ')}`,
    `المحاور: ${unit.content.map((c: any) => `${c.heading}: ${c.body}`).join(' | ')}`,
    `التقييم: ${unit.assessmentCriteria.join(' | ')}`,
    `الأدلة: ${[...unit.bookTitles, ...unit.evidenceRefs].filter(Boolean).join(' | ')}`,
  ].join('\n')).join('\n\n')

  const synthesisPrompt = `
ابنِ خطة وحدات نهائية لبرنامج ${program.titleAr} من التحليلات المصدرية التالية فقط.

عدد الفصول: ${semestersCount}
لا تستخدم معرفة عامة خارج هذه التحليلات.
لا تولد وحدة لا تملك دليلاً من كتاب أو بنك معرفة.

ملخص تحليل الكتب والتغطية:
${analysisManifest}

مسودات الوحدات المستخرجة من قراءة الكتب وبنك المعرفة:
${sourceUnitDrafts}

أخرج JSON array فقط، كل عنصر بالشكل:
[
  {
    "semester": 1,
    "title": "عنوان وحدة نهائي ومحدد",
    "summary": "ملخص خاص بالوحدة مبني على الأدلة",
    "objectives": ["هدف قابل للقياس", "هدف قابل للقياس", "هدف قابل للقياس"],
    "content": [{"heading":"محور مصدره الكتاب", "body":"شرح مرتبط بالدليل"}],
    "bookTitles": ["كتاب مستخدم"],
    "assessmentCriteria": ["معيار تقييم خاص"],
    "evidenceRefs": ["إشارة للكتاب أو عنوان معرفة أو مقطع"]
  }
]

قواعد جودة إلزامية:
- لا تكرر الملخص أو الأهداف بين الوحدات.
- لا تستخدم عبارات عامة مثل فهم المفاهيم الأساسية أو تحليل التطبيقات العملية أو ربط المعرفة بالواقع المهني.
- اجعل توزيع الفصول قريباً من semester الموجود في الأدلة.
- العدد المسموح 4 إلى ${Math.max(6, semestersCount * 5)} وحدة حسب قوة الأدلة، وليس حسب رغبة ثابتة.`

  let finalUnits = evidenceUnits
  try {
    const raw = await geminiCompleteJson({
      system: 'أنت محرر منهج أكاديمي. رتب وحدات مستخرجة من أدلة فقط، ولا تخترع محتوى عاماً.',
      history: [{ role: 'user', text: synthesisPrompt }],
      temperature: 0.18,
      thinkingBudget: 512,
      maxOutputTokens: 9000,
    })
    const parsed = parseJsonArray(raw)
    const normalized = Array.isArray(parsed)
      ? parsed.map((unit: any, index: number) => normalizeEvidenceUnit(unit, Number(unit?.semester || Math.floor(index / 4) + 1), index)).filter(Boolean)
      : []
    if (normalized.length) finalUnits = normalized as any[]
  } catch (error) {
    console.error('unit plan synthesis failed; using evidence units:', error)
  }

  const seen = new Set<string>()
  const cleaned = finalUnits.filter((unit) => {
    const signature = `${unit.title}|${unit.summary}|${unit.objectives.join('|')}`.toLowerCase()
    if (seen.has(signature)) return false
    seen.add(signature)
    return true
  }).slice(0, Math.max(semestersCount * 5, 6))

  return { program, semestersCount, units: cleaned, analyses }
}

// POST /api/admin/program-units/suggest — يقترح ويحفظ وحدات قابلة للمراجعة البشرية من نصوص الكتب وبنك المعرفة
export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const body = await req.json()
    const programId = cleanText(body?.programId, 80)
    const replace = body?.replace === true
    const append = body?.append === true
    if (!programId) return NextResponse.json({ error: 'معرف البرنامج مطلوب' }, { status: 400 })
    if (replace && append) return NextResponse.json({ error: 'اختر إما الإضافة إلى الموجود أو الاستبدال، وليس الخيارين معاً.' }, { status: 400 })

    const [currentCount, existingOrder] = await Promise.all([
      db.unit.count({ where: { programId } }),
      db.unit.aggregate({ where: { programId }, _max: { order: true } }),
    ])
    if (currentCount > 0 && !replace && !append) {
      return NextResponse.json({
        error: 'توجد وحدات حالية لهذا البرنامج. اختر الإضافة إلى الموجود أو الاستبدال.',
        existingUnits: currentCount,
      }, { status: 409 })
    }

    const plan = await generateUnitPlan(programId)
    if (!plan) return NextResponse.json({ error: 'البرنامج غير موجود' }, { status: 404 })
    if ((plan as any).evidenceError) return NextResponse.json({ error: (plan as any).evidenceError }, { status: 422 })
    if (!plan.units.length) return NextResponse.json({ error: 'لم ينتج تحليل الكتب وبنك المعرفة أي وحدات قابلة للحفظ.' }, { status: 422 })

    if (replace) await db.unit.deleteMany({ where: { programId } })
    const orderOffset = replace ? 0 : Number(existingOrder._max.order || currentCount)

    const created = await Promise.all(plan.units.map((u: any, idx: number) => db.unit.create({
      data: {
        programId,
        order: orderOffset + idx + 1,
        semester: Math.max(1, Math.min(plan.semestersCount, Number(u.semester || 1))),
        status: 'DRAFT',
        title: u.title,
        summary: `${u.summary}${u.bookTitles.length ? `\n\nالكتب المرتبطة: ${u.bookTitles.join('، ')}` : ''}${u.evidenceRefs.length ? `\n\nأدلة المصدر: ${u.evidenceRefs.join('، ')}` : ''}${u.assessmentCriteria.length ? `\n\nمعايير التقييم: ${u.assessmentCriteria.join('، ')}` : ''}`.slice(0, 3000),
        objectives: JSON.stringify(u.objectives),
        content: JSON.stringify(u.content),
      },
    })))

    await db.program.update({
      where: { id: programId },
      data: {
        semestersCount: plan.semestersCount,
        academicReadinessStatus: 'READY_FOR_REVIEW',
        academicApproved: false,
        academicApprovedAt: null,
        academicApprovedById: null,
      },
    })

    await audit({ id: admin.id, name: admin.name }, 'GENERATE_CURRICULUM_UNITS', 'Program', programId, `اقتراح ${created.length} وحدة منهجية مبنية على قراءة الكتب وبنك المعرفة لبرنامج ${plan.program.titleAr}${replace ? ' مع استبدال الوحدات السابقة' : append ? ' مع إضافتها إلى الوحدات الحالية' : ''}`)

    return NextResponse.json({ ok: true, count: created.length, mode: replace ? 'replace' : append ? 'append' : 'create', units: created })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('suggest program units error:', e)
    return NextResponse.json({ error: 'تعذر اقتراح وحدات البرنامج من الكتب وبنك المعرفة' }, { status: 500 })
  }
}
