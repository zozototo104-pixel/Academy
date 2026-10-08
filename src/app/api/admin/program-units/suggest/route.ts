import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { geminiCompleteJson, geminiLastTextResult } from '@/lib/gemini'
import { audit } from '@/lib/notify'
import { textAiDiagnostics } from '@/lib/text-ai'
import { planOutlineUnitsFromSections, safeReplaceDraftUnitWhere, summarizeReplaceUnitProtection } from '@/lib/outline-units'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

function cleanText(value: unknown, max = 1200) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function parseJsonObject(raw: string) {
  const text = String(raw || '').trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim()
  try { return JSON.parse(text) } catch (error) { console.warn('Failed to parse curriculum AI object JSON directly; trying fenced extraction.', error) }
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1))
  throw new Error('INVALID_JSON')
}

function parseJsonArray(raw: string) {
  const text = String(raw || '').trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim()
  try { return JSON.parse(text) } catch (error) { console.warn('Failed to parse curriculum AI array JSON directly; trying fenced extraction.', error) }
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1))
  throw new Error('INVALID_JSON_ARRAY')
}

type CurriculumAiTrace = {
  stage: 'BOOK_ANALYSIS' | 'SYNTHESIS'
  ok: boolean
  provider?: string
  model?: string
  at: string
  ms: number
  bookTitle?: string
  error?: string
}

async function geminiCompleteJsonWithTrace(
  opts: Parameters<typeof geminiCompleteJson>[0],
  trace: CurriculumAiTrace[],
  meta: { stage: CurriculumAiTrace['stage']; bookTitle?: string },
) {
  const started = Date.now()
  try {
    const text = await geminiCompleteJson(opts)
    const at = new Date().toISOString()
    const diag = await textAiDiagnostics().catch(() => null)
    const external = diag?.lastResult?.ok && Date.parse(diag.lastResult.at) >= started - 1000 ? diag.lastResult : null
    const direct = geminiLastTextResult()
    const directFresh = direct?.ok && Date.parse(direct.at) >= started - 1000 ? direct : null
    const actual = external || directFresh
    trace.push({
      stage: meta.stage,
      ok: true,
      provider: actual?.provider || (directFresh ? 'GEMINI' : undefined),
      model: actual?.model,
      at: actual?.at || at,
      ms: Date.now() - started,
      bookTitle: meta.bookTitle,
    })
    return text
  } catch (error: any) {
    trace.push({
      stage: meta.stage,
      ok: false,
      at: new Date().toISOString(),
      ms: Date.now() - started,
      bookTitle: meta.bookTitle,
      error: String(error?.message || error).slice(0, 500),
    })
    throw error
  }
}

function latestSuccessfulTrace(trace: CurriculumAiTrace[]) {
  return [...trace].reverse().find((item) => item.ok && item.provider && item.model) || null
}

function safeJson(value: unknown) {
  try { return JSON.stringify(value) } catch { return 'null' }
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

async function analyzeBookForCurriculum(program: any, book: any, allKnowledgeItems: any[], trace: CurriculumAiTrace[]) {
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
    const raw = await geminiCompleteJsonWithTrace({
      system: 'أنت محلل كتب ومصمم مناهج. اقرأ النص وبنك المعرفة أولاً، ثم استخرج وحدات مبررة بالأدلة. لا تولد وحدات عامة.',
      history: [{ role: 'user', text: prompt }],
      temperature: 0.2,
      thinkingBudget: 768,
      maxOutputTokens: 9000,
    }, trace, { stage: 'BOOK_ANALYSIS', bookTitle: book.title })
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

  const trace: CurriculumAiTrace[] = []
  const evidenceBooks = program.books.filter((book) => hasReadableBookEvidence(book, program.knowledgeItems))
  if (!evidenceBooks.length) {
    return {
      program,
      semestersCount,
      units: [],
      evidenceError: 'لا يمكن توليد وحدات موثوقة لأن كتب البرنامج لا تحتوي نصاً مستخرجاً ولا توجد عناصر كافية في بنك المعرفة. اقرأ/حلّل الكتب أولاً ثم أعد التوليد.',
    }
  }

  const analyses = (await Promise.all(evidenceBooks.map((book) => analyzeBookForCurriculum(program, book, program.knowledgeItems, trace))))
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
    const raw = await geminiCompleteJsonWithTrace({
      system: 'أنت محرر منهج أكاديمي. رتب وحدات مستخرجة من أدلة فقط، ولا تخترع محتوى عاماً.',
      history: [{ role: 'user', text: synthesisPrompt }],
      temperature: 0.18,
      thinkingBudget: 512,
      maxOutputTokens: 9000,
    }, trace, { stage: 'SYNTHESIS' })
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

  return { program, semestersCount, units: cleaned, analyses, executionTrace: trace, actualAi: latestSuccessfulTrace(trace) }
}

async function createUnitsFromApprovedOutlines(programId: string, regenerateDrafts: boolean) {
  const program = await db.program.findUnique({ where: { id: programId }, select: { id: true, titleAr: true, semestersCount: true } })
  if (!program) return null
  const books = await db.book.findMany({
    where: { programId },
    orderBy: [{ semester: 'asc' }, { createdAt: 'asc' }],
    select: {
      id: true,
      title: true,
      semester: true,
      outlines: {
        where: { status: 'APPROVED' },
        orderBy: { version: 'desc' },
        take: 1,
        include: { sections: { orderBy: { order: 'asc' } } },
      },
    },
  })
  const approvedBooks = books.filter((book) => book.outlines.length > 0)
  const skippedBooks = books.filter((book) => book.outlines.length === 0).map((book) => ({ id: book.id, title: book.title, reason: `الكتاب ${book.title} ليس له فهرس معتمد؛ اعتمد الفهرس من صفحة الكتب` }))
  if (!approvedBooks.length) {
    return { program, usedApprovedOutlines: false as const, skippedBooks, created: [], updated: [], summary: { created: 0, updatedDrafts: 0, skippedApproved: 0, skippedDrafts: 0, skippedIntro: 0 } }
  }

  const allSectionIds = approvedBooks.flatMap((book) => book.outlines[0].sections.map((section) => section.id))
  const [existingUnits, allUnits] = await Promise.all([
    db.unit.findMany({
      where: { programId, outlineSectionId: { in: allSectionIds } },
      select: { id: true, outlineSectionId: true, status: true, order: true, semester: true, generationVersion: true },
    }),
    db.unit.findMany({ where: { programId }, select: { semester: true, order: true } }),
  ])
  const currentMaxOrderBySemester = allUnits.reduce<Record<number, number>>((acc, unit) => {
    const semester = Number(unit.semester || 1)
    acc[semester] = Math.max(acc[semester] || 0, Number(unit.order || 0))
    return acc
  }, {})
  const summary = { created: 0, updatedDrafts: 0, skippedApproved: 0, skippedDrafts: 0, skippedIntro: 0 }
  const created: any[] = []
  const updated: string[] = []

  for (const book of approvedBooks) {
    const outline = book.outlines[0]
    const actions = planOutlineUnitsFromSections({
      sections: outline.sections.map((section) => ({
        id: section.id,
        title: section.title,
        level: section.level,
        semester: section.semester,
        chunkStartIndex: section.chunkStartIndex,
        chunkEndIndex: section.chunkEndIndex,
        pageStart: section.pageStart,
        pageEnd: section.pageEnd,
      })),
      existingUnits,
      currentMaxOrderBySemester,
      bookSemester: book.semester,
      regenerateDrafts,
    })
    for (const action of actions) {
      if (action.action === 'create') {
        const unit = await db.unit.create({
          data: {
            programId,
            order: action.order,
            semester: action.semester,
            status: 'DRAFT',
            title: cleanText(action.section.title, 220) || 'وحدة من فهرس الكتاب',
            summary: `مسودة وحدة مولدة من فهرس كتاب «${book.title}» في نطاق الصفحات ${action.section.pageStart ?? '؟'}–${action.section.pageEnd ?? '؟'}.`,
            objectives: JSON.stringify([]),
            content: JSON.stringify([]),
            sourceBookId: book.id,
            outlineSectionId: action.section.id,
            chunkStartIndex: action.section.chunkStartIndex,
            chunkEndIndex: action.section.chunkEndIndex,
            generationVersion: 1,
          },
        })
        created.push(unit)
        summary.created++
        currentMaxOrderBySemester[action.semester] = Math.max(currentMaxOrderBySemester[action.semester] || 0, action.order)
      } else if (action.action === 'update-draft') {
        await db.unit.updateMany({
          where: { id: action.unitId, programId, status: { not: 'APPROVED' } },
          data: {
            title: cleanText(action.section.title, 220) || 'وحدة من فهرس الكتاب',
            summary: `مسودة وحدة معاد ربطها بفهرس كتاب «${book.title}» في نطاق الصفحات ${action.section.pageStart ?? '؟'}–${action.section.pageEnd ?? '؟'}.`,
            semester: action.semester,
            sourceBookId: book.id,
            outlineSectionId: action.section.id,
            chunkStartIndex: action.section.chunkStartIndex,
            chunkEndIndex: action.section.chunkEndIndex,
            generationVersion: action.generationVersion,
          },
        })
        updated.push(action.unitId)
        summary.updatedDrafts++
      } else if (action.action === 'skip-approved') summary.skippedApproved++
      else if (action.action === 'skip-draft') summary.skippedDrafts++
      else if (action.action === 'skip-intro') summary.skippedIntro++
    }
  }

  if (summary.created || summary.updatedDrafts) {
    await db.program.update({ where: { id: programId }, data: { academicReadinessStatus: 'READY_FOR_REVIEW', academicApproved: false, academicApprovedAt: null, academicApprovedById: null } })
  }
  return { program, usedApprovedOutlines: true as const, skippedBooks, created, updated, summary }
}

// POST /api/admin/program-units/suggest — يقترح ويحفظ وحدات قابلة للمراجعة البشرية من الفهارس المعتمدة أولاً، ثم من نصوص الكتب وبنك المعرفة بعد تأكيد صريح
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

    let replaceProtection = { deleted: 0, keptApproved: 0, keptOutline: 0, keptWithAttempts: 0 }
    let orderOffset = Number(existingOrder._max.order || currentCount)
    if (replace) {
      const unitsBeforeReplace = await db.unit.findMany({
        where: { programId },
        select: {
          status: true,
          outlineSectionId: true,
          exam: { select: { _count: { select: { attempts: true } } } },
        },
      })
      replaceProtection = summarizeReplaceUnitProtection(unitsBeforeReplace)
      const deleted = await db.unit.deleteMany({ where: safeReplaceDraftUnitWhere(programId) })
      replaceProtection.deleted = deleted.count
      const remainingOrder = await db.unit.aggregate({ where: { programId }, _max: { order: true } })
      orderOffset = Number(remainingOrder._max.order || 0)
    }

    const generationAudit = {
      kind: 'CURRICULUM_GENERATION_AUDIT',
      generatedAt: new Date().toISOString(),
      mode: replace ? 'replace' : append ? 'append' : 'create',
      source: 'BOOK_TEXT_AND_KNOWLEDGE_BANK',
      unitsCount: plan.units.length,
      replaceProtection,
      actualAi: (plan as any).actualAi || null,
      executionTrace: ((plan as any).executionTrace || []).slice(-20),
      sourceBooks: ((plan as any).analyses || []).map((analysis: any) => ({
        bookTitle: analysis.bookTitle,
        semester: analysis.semester,
        hasTextContent: analysis.hasTextContent,
        knowledgeCount: analysis.knowledgeCount,
        coverageNote: analysis.coverageNote,
      })),
      previousNote: cleanText((plan.program as any).curriculumPreparationNote, 1200) || undefined,
    }

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
        curriculumPreparationNote: safeJson(generationAudit),
      },
    })

    await audit({ id: admin.id, name: admin.name }, 'GENERATE_CURRICULUM_UNITS', 'Program', programId, `اقتراح ${created.length} وحدة منهجية مبنية على قراءة الكتب وبنك المعرفة لبرنامج ${plan.program.titleAr}${replace ? ' مع استبدال الوحدات السابقة' : append ? ' مع إضافتها إلى الوحدات الحالية' : ''}`)

    return NextResponse.json({
      ok: true,
      count: created.length,
      mode: replace ? 'replace' : append ? 'append' : 'create',
      deleted: replaceProtection.deleted,
      keptApproved: replaceProtection.keptApproved,
      keptOutline: replaceProtection.keptOutline,
      keptWithAttempts: replaceProtection.keptWithAttempts,
      actualAi: generationAudit.actualAi,
      generationAudit: {
        generatedAt: generationAudit.generatedAt,
        mode: generationAudit.mode,
        source: generationAudit.source,
        unitsCount: generationAudit.unitsCount,
        actualAi: generationAudit.actualAi,
        executionTrace: generationAudit.executionTrace,
        sourceBooks: generationAudit.sourceBooks,
      },
      units: created,
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('suggest program units error:', e)
    return NextResponse.json({ error: 'تعذر اقتراح وحدات البرنامج من الكتب وبنك المعرفة' }, { status: 500 })
  }
}
