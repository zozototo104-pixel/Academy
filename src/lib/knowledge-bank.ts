import { db } from '@/lib/db'
import { getZAI, chatWithRetry } from '@/lib/ai'
import { hydrateBookContentForExam, type RawBookForHydration } from '@/lib/book-content'

export interface KnowledgeItemDraft {
  category: string
  title: string
  summary: string
  excerpt?: string | null
  keywords?: string[]
  importance?: number
  semester?: number | null
  sourceNote?: string | null
}

export interface KnowledgeBuildResult {
  programId: string
  bookId?: string | null
  inserted: number
  deleted: number
  usedAi: boolean
  sourceNote?: string | null
}

const CATEGORY_SET = new Set(['CONCEPT', 'THEORY', 'METHOD', 'CASE', 'DEFINITION', 'QUESTION_SEED', 'SUMMARY'])
const MAX_ITEMS_PER_BOOK = 28

function cleanText(value: unknown, max = 1600) {
  return String(value || '')
    .replace(/\u0000/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max)
}

function norm(value: unknown) {
  return String(value || '')
    .toLowerCase()
    .replace(/[إأآا]/g, 'ا')
    .replace(/[ىي]/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[ًٌٍَُِّْـ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function safeCategory(value: unknown) {
  const c = String(value || '').trim().toUpperCase()
  return CATEGORY_SET.has(c) ? c : 'CONCEPT'
}

function safeImportance(value: unknown, fallback = 55) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(10, Math.min(100, Math.round(n)))
}

function extractJsonArray(raw: string): any[] {
  const body = String(raw || '').trim()
  try {
    const parsed = JSON.parse(body)
    return Array.isArray(parsed) ? parsed : Array.isArray(parsed?.items) ? parsed.items : []
  } catch {}
  const fenced = body.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
  if (fenced) {
    try {
      const parsed = JSON.parse(fenced)
      return Array.isArray(parsed) ? parsed : Array.isArray(parsed?.items) ? parsed.items : []
    } catch {}
  }
  const arr = body.match(/\[[\s\S]*\]/)?.[0]
  if (arr) {
    try {
      const parsed = JSON.parse(arr)
      return Array.isArray(parsed) ? parsed : []
    } catch {}
  }
  return []
}

function tokenizeKeywords(text: string, max = 9) {
  const stop = new Set([
    'هذا', 'هذه', 'ذلك', 'الذي', 'التي', 'على', 'الى', 'إلى', 'في', 'من', 'عن', 'مع', 'كان', 'كانت', 'يكون', 'تكون',
    'كتاب', 'الكتاب', 'الفصل', 'المبحث', 'الصفحة', 'يمكن', 'يجب', 'عند', 'وقد', 'وقد', 'كما', 'غير', 'أكثر', 'اكثر',
  ].map(norm))
  const seen = new Set<string>()
  const out: string[] = []
  for (const token of norm(text).split(' ')) {
    if (token.length < 4 || stop.has(token) || seen.has(token)) continue
    seen.add(token)
    out.push(token)
    if (out.length >= max) break
  }
  return out
}

function splitBookIntoSeeds(text: string, maxItems = MAX_ITEMS_PER_BOOK) {
  const cleaned = cleanText(text, 160000)
  const paragraphs = cleaned
    .split(/\n{2,}|(?<=[.!؟؛])\s+(?=[\p{L}])/gu)
    .map((p) => cleanText(p, 1400))
    .filter((p) => p.length >= 120 && (p.match(/[\p{L}]/gu) || []).length > 70)

  if (paragraphs.length === 0) return []
  const indexes = new Set<number>()
  const take = Math.min(maxItems, paragraphs.length)
  for (let i = 0; i < take; i++) {
    indexes.add(Math.floor((i * paragraphs.length) / take))
  }
  return Array.from(indexes).map((i) => paragraphs[i]).filter(Boolean).slice(0, maxItems)
}

function inferCategory(seed: string, index: number): string {
  const n = norm(seed)
  if (/تعريف|يعرف|يقصد|مصطلح|مفهوم/.test(n)) return 'DEFINITION'
  if (/نموذج|نظريه|اطار|مدخل|منهج/.test(n)) return 'THEORY'
  if (/خطوه|اجراء|منهجيه|طريقه|اسلوب/.test(n)) return 'METHOD'
  if (/حاله|مثال|سيناريو|تطبيق|موقف|شخصيه|حدث|صراع/.test(n)) return 'CASE'
  return index % 5 === 0 ? 'QUESTION_SEED' : 'CONCEPT'
}

function titleFromSeed(seed: string, index: number) {
  const first = cleanText(seed.split(/[.!؟؛\n]/u).find((x) => cleanText(x).length > 20) || seed, 110)
  return first.length > 12 ? first : `محور معرفي رقم ${index + 1}`
}

function deterministicKnowledgeItems(book: RawBookForHydration & { semester?: number | null }, text: string, semester?: number | null): KnowledgeItemDraft[] {
  const seeds = splitBookIntoSeeds(text, MAX_ITEMS_PER_BOOK)
  const seen = new Set<string>()
  const items: KnowledgeItemDraft[] = []
  for (let i = 0; i < seeds.length; i++) {
    const seed = seeds[i]
    const title = titleFromSeed(seed, i)
    const key = norm(title).slice(0, 140)
    if (!key || seen.has(key)) continue
    seen.add(key)
    const category = inferCategory(seed, i)
    items.push({
      category,
      title,
      summary: cleanText(seed, 500),
      excerpt: cleanText(seed, 700),
      keywords: tokenizeKeywords(`${title} ${seed}`),
      importance: category === 'QUESTION_SEED' || category === 'CASE' ? 78 : category === 'THEORY' || category === 'METHOD' ? 72 : 60,
      semester: semester ?? null,
      sourceNote: `مستخرج آلياً من «${book.title}»`,
    })
  }

  if (items.length === 0 && (book.description || book.title)) {
    const seed = cleanText(`${book.title}. ${book.description || ''}`, 700)
    items.push({
      category: 'SUMMARY',
      title: cleanText(book.title, 160),
      summary: seed,
      excerpt: seed,
      keywords: tokenizeKeywords(seed),
      importance: 40,
      semester: semester ?? null,
      sourceNote: 'مبني على بيانات الكتاب لأن النص غير كافٍ',
    })
  }
  return items.slice(0, MAX_ITEMS_PER_BOOK)
}

function normalizeDrafts(rawItems: any[], fallback: KnowledgeItemDraft[], semester?: number | null): KnowledgeItemDraft[] {
  const seen = new Set<string>()
  const out: KnowledgeItemDraft[] = []
  for (const raw of rawItems) {
    const title = cleanText(raw?.title || raw?.name || raw?.concept, 180)
    const summary = cleanText(raw?.summary || raw?.description || raw?.explanation, 900)
    const excerpt = cleanText(raw?.excerpt || raw?.evidence || raw?.sourceEvidence || summary, 900)
    if (!title || !summary || summary.length < 30) continue
    const key = norm(`${title} ${summary}`).slice(0, 180)
    if (!key || seen.has(key)) continue
    seen.add(key)
    const keywords = Array.isArray(raw?.keywords) ? raw.keywords.map((x: any) => cleanText(x, 50)).filter(Boolean).slice(0, 10) : tokenizeKeywords(`${title} ${summary}`)
    out.push({
      category: safeCategory(raw?.category),
      title,
      summary,
      excerpt,
      keywords,
      importance: safeImportance(raw?.importance, 65),
      semester: raw?.semester == null ? (semester ?? null) : Number(raw.semester) || semester || null,
      sourceNote: cleanText(raw?.sourceNote || raw?.source || '', 250) || null,
    })
    if (out.length >= MAX_ITEMS_PER_BOOK) break
  }
  if (out.length >= 8) return out
  for (const fb of fallback) {
    const key = norm(`${fb.title} ${fb.summary}`).slice(0, 180)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(fb)
    if (out.length >= MAX_ITEMS_PER_BOOK) break
  }
  return out
}

async function aiKnowledgeItems(
  program: { titleAr: string; titleEn?: string | null; category?: string | null; description?: string | null },
  book: RawBookForHydration,
  text: string,
  semester?: number | null
): Promise<KnowledgeItemDraft[] | null> {
  if (text.length < 700) return null
  const sample = [
    text.slice(0, 9000),
    text.slice(Math.max(0, Math.floor(text.length / 2) - 4500), Math.floor(text.length / 2) + 4500),
    text.slice(Math.max(0, text.length - 9000)),
  ].join('\n\n--- مقطع من جزء آخر من الكتاب ---\n\n')

  const prompt = `أنت تبني بنك معرفة أكاديمي رسمي لمنصة تعليم مهني. لا نريد ملخصاً عاماً؛ نريد عناصر معرفة قابلة للاستخدام في الامتحانات، الواجبات، والمشرف الذكي.

البرنامج: ${program.titleAr}
الدرجة/التصنيف: ${program.category || '-'}
وصف البرنامج: ${program.description || '-'}
الكتاب: ${book.title}${book.titleEn ? ` / ${book.titleEn}` : ''}
المؤلف: ${book.author || '-'}
الفصل الدراسي: ${semester || book.semester || 'عام'}

مقاطع موزعة من الكتاب:
${sample}

استخرج 12 إلى ${MAX_ITEMS_PER_BOOK} عنصر معرفة. كل عنصر يجب أن يحتوي:
- category واحدة من: CONCEPT, THEORY, METHOD, CASE, DEFINITION, QUESTION_SEED, SUMMARY
- title عنوان قصير واضح
- summary شرح أكاديمي دقيق للفكرة كما ظهرت في الكتاب
- excerpt دليل أو إعادة صياغة أمينة من محتوى الكتاب، لا تخترع اقتباساً حرفياً
- keywords مصفوفة 4-8 كلمات مفتاحية
- importance رقم 10-100 حسب أهمية الفكرة للامتحان
- semester رقم الفصل أو null

إذا كان الكتاب رواية/نص سردي، استخرج الأحداث والشخصيات والصراعات والقرارات كمادة CASE وQUESTION_SEED قابلة للإسقاط على التخصص.

أجب JSON فقط كمصفوفة عناصر.`

  try {
    const zai = await getZAI()
    const raw = await Promise.race([
      chatWithRetry(zai, [
        { role: 'assistant', content: 'أنت محلل مناهج جامعية يرجع JSON صالحاً فقط.' },
        { role: 'user', content: prompt },
      ], 2),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error('KNOWLEDGE_AI_TIMEOUT')), 30000)),
    ])
    const arr = extractJsonArray(raw)
    return arr.length ? normalizeDrafts(arr, [], semester) : null
  } catch (e: any) {
    console.error('aiKnowledgeItems fallback:', String(e?.message || e).slice(0, 300))
    return null
  }
}

async function persistBookTextIfNeeded(bookId: string | undefined, text: string, shouldPersist: boolean) {
  if (!bookId || !shouldPersist || text.length < 160) return
  await db.book.update({ where: { id: bookId }, data: { textContent: text.slice(0, 180000) } }).catch(() => {})
}

async function createKnowledgeRows(programId: string, bookId: string | null, items: KnowledgeItemDraft[]) {
  if (items.length === 0) return 0
  await db.bookKnowledgeItem.createMany({
    data: items.map((item) => ({
      programId,
      bookId,
      semester: item.semester ?? null,
      category: safeCategory(item.category),
      title: cleanText(item.title, 220),
      summary: cleanText(item.summary, 1600),
      excerpt: item.excerpt ? cleanText(item.excerpt, 1800) : null,
      keywords: JSON.stringify((item.keywords || tokenizeKeywords(`${item.title} ${item.summary}`)).slice(0, 10)),
      importance: safeImportance(item.importance),
      sourceNote: item.sourceNote ? cleanText(item.sourceNote, 400) : null,
    })),
  })
  return items.length
}

export async function rebuildKnowledgeForBook(bookId: string): Promise<KnowledgeBuildResult> {
  const book = await db.book.findUnique({
    where: { id: bookId },
    include: { program: { select: { id: true, titleAr: true, titleEn: true, category: true, description: true } } },
  })
  if (!book) throw new Error('الكتاب غير موجود')

  const hydrated = await hydrateBookContentForExam(book)
  await persistBookTextIfNeeded(book.id, hydrated.textContent, hydrated.shouldPersistText)
  const semester = book.semester ?? null
  const fallback = deterministicKnowledgeItems(book, hydrated.textContent || `${book.title}. ${book.description || ''}`, semester)
  const ai = await aiKnowledgeItems(book.program, book, hydrated.textContent, semester)
  const items = normalizeDrafts(ai || [], fallback, semester)

  const deleted = await db.bookKnowledgeItem.deleteMany({ where: { bookId: book.id } })
  const inserted = await createKnowledgeRows(book.programId, book.id, items)
  return { programId: book.programId, bookId: book.id, inserted, deleted: deleted.count, usedAi: !!ai?.length, sourceNote: hydrated.sourceNote }
}

export async function rebuildProgramKnowledge(programId: string, semester?: number | null): Promise<{ programId: string; results: KnowledgeBuildResult[]; totalInserted: number; totalDeleted: number }> {
  const program = await db.program.findUnique({ where: { id: programId }, select: { id: true } })
  if (!program) throw new Error('البرنامج غير موجود')
  const books = await db.book.findMany({
    where: { programId, ...(semester ? { OR: [{ semester: null }, { semester }] } : {}) },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  })
  if (books.length === 0) throw new Error('لا توجد كتب مقررة لبناء بنك المعرفة')

  const results: KnowledgeBuildResult[] = []
  for (const b of books) {
    results.push(await rebuildKnowledgeForBook(b.id))
  }
  return {
    programId,
    results,
    totalInserted: results.reduce((s, r) => s + r.inserted, 0),
    totalDeleted: results.reduce((s, r) => s + r.deleted, 0),
  }
}

export async function ensureProgramKnowledge(programId: string, semester?: number | null, minItems = 10) {
  const where: any = { programId }
  if (semester) where.OR = [{ semester: null }, { semester }]
  const count = await db.bookKnowledgeItem.count({ where })
  if (count >= minItems) return { rebuilt: false, count }
  const rebuilt = await rebuildProgramKnowledge(programId, semester)
  return { rebuilt: true, count: rebuilt.totalInserted }
}

export async function getProgramKnowledgeItems(programId: string, semester?: number | null, limit = 80) {
  const where: any = { programId }
  if (semester) where.OR = [{ semester: null }, { semester }]
  const rows = await db.bookKnowledgeItem.findMany({
    where,
    orderBy: [{ importance: 'desc' }, { createdAt: 'asc' }],
    take: limit,
    include: { book: { select: { title: true, titleEn: true, semester: true } } },
  })
  return rows.map((r) => ({
    id: r.id,
    bookId: r.bookId,
    bookTitle: r.book?.title || null,
    semester: r.semester,
    category: r.category,
    title: r.title,
    summary: r.summary,
    excerpt: r.excerpt,
    keywords: (() => { try { return JSON.parse(r.keywords || '[]') } catch { return [] } })() as string[],
    importance: r.importance,
    sourceNote: r.sourceNote,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }))
}

export async function buildKnowledgeContextForExam(programId: string, semester?: number | null, limit = 48): Promise<string> {
  await ensureProgramKnowledge(programId, semester, 8).catch(() => null)
  const items = await getProgramKnowledgeItems(programId, semester, limit)
  if (!items.length) return ''
  return items
    .map((item, i) => {
      const kw = item.keywords?.length ? ` — كلمات: ${item.keywords.slice(0, 5).join('، ')}` : ''
      const source = item.bookTitle ? ` — المصدر: ${item.bookTitle}` : ''
      return `${i + 1}. [${item.category} | أهمية ${item.importance}] ${item.title}: ${cleanText(item.summary, 420)}${item.excerpt ? ` — دليل: ${cleanText(item.excerpt, 260)}` : ''}${kw}${source}`
    })
    .join('\n')
}
