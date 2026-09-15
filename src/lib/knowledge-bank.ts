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

export function cleanAcademicGeneratedText(value: unknown, max = 1600) {
  return String(value || '')
    .replace(/\u0000/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/\b\d{1,5}\s+of\s+\d{1,5}\b/gi, ' ')
    .replace(/\bpage\s+\d{1,5}\s+(?:of|\/|من)\s+\d{1,5}\b/gi, ' ')
    .replace(/\bصفحة\s+\d{1,5}\s+(?:من|\/|of)\s+\d{1,5}\b/gi, ' ')
    .replace(/\[?\s*(?:CONCEPT|THEORY|METHOD|CASE|DEFINITION|QUESTION_SEED|SUMMARY)\s*(?:\|[^\]\n]*)?\]?/gi, ' ')
    .replace(/(?:محور\s+معرفي\s+مهم|دليل\s+من\s+المحتوى|دليل\s+من\s+المحتوي|خلاصة\s+أكاديمية|خلاصة\s+اكاديمية|مقتطف\s+داعم|مصطلحات\s+مرتبطة|كلمات\s+مفتاحية|مصدر\s+القراءة)\s*[:：]?/giu, ' ')
    .replace(/\s+([،؛؟.!])/g, '$1')
    .replace(/([،؛؟.!]){2,}/g, '$1')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max)
}

function cleanText(value: unknown, max = 1600) {
  return cleanAcademicGeneratedText(value, max)
}

export function normalizeAcademicGeneratedText(value: unknown) {
  return String(value || '')
    .toLowerCase()
    .replace(/[إأآا]/g, 'ا')
    .replace(/[ىي]/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/[ًٌٍَُِّْـ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function norm(value: unknown) {
  return normalizeAcademicGeneratedText(value)
}

function countMatches(value: string, re: RegExp) {
  return (String(value || '').match(re) || []).length
}

export function looksLikeBrokenAcademicOutput(value: unknown, opts: { allowShort?: boolean } = {}) {
  const raw = cleanAcademicGeneratedText(value, 5000)
  if (!raw) return true
  const n = norm(raw)
  const chars = raw.replace(/\s/g, '')
  const letters = countMatches(raw, /[\p{L}]/gu)
  const digits = countMatches(raw, /\d/g)
  const arabicLetters = countMatches(raw, /[\u0600-\u06FF]/g)
  const latinLetters = countMatches(raw, /[A-Za-zÀ-ÖØ-öø-ÿ]/g)
  const tokens = raw.split(/\s+/).filter(Boolean)
  const arabicWords = tokens.filter((w) => /[\u0600-\u06FF]/.test(w)).length
  const latinWords = tokens.filter((w) => /[A-Za-zÀ-ÖØ-öø-ÿ]/.test(w)).length

  if (!opts.allowShort && letters < 18) return true
  if (chars.length > 30 && letters / Math.max(1, chars.length) < 0.46) return true
  if (digits >= 6 && letters < 55) return true
  // مخرجات المنصة للطالب يجب أن تكون عربية. نسمح بالعناوين الأجنبية القصيرة،
  // لكن لا نقبل فقرة معرفة/دليل/سؤال طويلة بلغة أجنبية دون صياغة عربية.
  if (!opts.allowShort && arabicLetters < 10 && latinLetters > 35) return true

  const forbidden = [
    'محور معرفي مهم', 'دليل من المحتوي', 'دليل من المحتوى', 'خلاصه اكاديميه', 'خلاصة اكاديمية',
    'مقتطف داعم', 'مصطلحات مرتبطه', 'كلمات مفتاحيه', 'مصدر القراءه', 'بنك المعرفه الاكاديمي المستخرج',
    'اي عباره تفسر بصوره ادق دلاله', 'كيف يمكن فهم فكره', 'لا تستخدم رموزا تقنيه',
    'google books', 'books google', 'goodreads', 'worldcat', 'tbm bks',
    'libro de la guerra', 'tratado de la perfeccion', 'tratado de la perfección', 'lehrsätze', 'lehrs atze',
    'vellena', 'bonapert', 'بونابرت رجاء الكتاب', 'كتاب الثاين', 'الكتاب ويف', 'كتاب احرب',
    'يفترض اجتزال', 'هو يفتترض', 'حوالي عام 8121', 'عام 8115', 'عام 8518',
  ]
  if (forbidden.some((x) => n.includes(norm(x)))) return true

  // سنوات أو أرقام مستحيلة تظهر غالباً من OCR مقلوب: 8121، 8115، 8518...
  if (/(?:عام|سنة|سنه|حوالي|around|year)\s*(?:[3-9]\d{3}|\d{5,})/iu.test(raw)) return true
  if (/\b(?:8[0-9]{3}|9[0-9]{3})\b/.test(raw) && /(كتاب|الفكر|استراتيجي|الحرب|العسكري|منهج)/u.test(raw)) return true

  const noisyLatin = /(libro\s+de\s+la|tratado\s+de|perfecci[oó]n|vellena|lehrs[aä]tze|krieg(?:es)?|guerra|alfonso\s+hernandez)/i
  if (noisyLatin.test(raw) && arabicWords >= 3) return true
  if (arabicLetters >= 20 && latinLetters / Math.max(1, latinLetters + arabicLetters) > 0.38 && latinWords >= 4) return true

  const brokenFragments = [
    'كتاب اطلب', 'كتاب احرب', 'يف اسبانيا', 'في اسبانيا مع كتاب', 'هو يفتترض', 'يفترض اجتزال ان الاول',
    'وان الثانيه ال', 'هذا المنهج منذ زمن بعيد حيث ظهر', 'استخدم هذا المنهج منذ زمن بعيد حيث ظهر',
    'بدات الاعلان عن نفسه', 'السيما عند موسسي الفكر', 'الاستراتيجي ال عسكري', 'بشكل واضح يف اسبانيا',
    'مع كتاب اطلب', 'مع كتاب احرب', 'كتاب حرب هو', 'ويف', 'الثاين', 'وضع الكتاب يف عام',
  ]
  if (brokenFragments.some((x) => n.includes(norm(x)))) return true

  const shortTokens = tokens.filter((w) => w.length <= 2).length
  if (tokens.length >= 18 && shortTokens / tokens.length > 0.45) return true

  return false
}

function safeGeneratedOrFallback(value: unknown, fallback: string, max = 1600, allowShort = false) {
  const cleaned = cleanAcademicGeneratedText(value, max)
  return cleaned && !looksLikeBrokenAcademicOutput(cleaned, { allowShort }) ? cleaned : cleanAcademicGeneratedText(fallback, max)
}

function safeGeneratedList(values: unknown, fallback: string[] = [], maxItems = 10, maxChars = 90) {
  const raw = Array.isArray(values) ? values : []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of [...raw, ...fallback]) {
    const cleaned = cleanAcademicGeneratedText(item, maxChars)
    const key = norm(cleaned)
    if (!key || seen.has(key) || looksLikeBrokenAcademicOutput(cleaned, { allowShort: true })) continue
    seen.add(key)
    out.push(cleaned)
    if (out.length >= maxItems) break
  }
  return out
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
    .filter((p) => p.length >= 120 && (p.match(/[\p{L}]/gu) || []).length > 70 && !looksLikeBrokenAcademicOutput(p))

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
  return first.length > 12 && !looksLikeBrokenAcademicOutput(first, { allowShort: true }) ? first : `محور معرفي رقم ${index + 1}`
}

function fallbackKnowledgeTitle(bookTitle: string, category: string, index: number) {
  const labels: Record<string, string> = {
    CONCEPT: 'مفهوم تطبيقي',
    THEORY: 'إطار نظري',
    METHOD: 'منهجية عمل',
    CASE: 'حالة تطبيقية',
    DEFINITION: 'تعريف مهني',
    QUESTION_SEED: 'بذرة سؤال',
    SUMMARY: 'خلاصة دراسية',
  }
  return `${labels[category] || 'محور معرفي'} من كتاب «${cleanText(bookTitle, 90)}» (${index + 1})`
}

function fallbackKnowledgeSummary(bookTitle: string, category: string) {
  const bookName = cleanText(bookTitle, 120) || 'الكتاب المقرر'
  if (category === 'CASE' || category === 'QUESTION_SEED') {
    return `يعالج هذا المحور موقفاً أو فكرة قابلة للتحويل إلى حالة مهنية من كتاب «${bookName}». يستخدمه المشرف والامتحان لربط المحتوى بالتخصص عبر تحليل القرار، الأطراف المؤثرة، المخاطر، والنتائج المتوقعة.`
  }
  if (category === 'METHOD') {
    return `يعرض هذا المحور طريقة عمل أو تسلسل إجراءات من كتاب «${bookName}». يركز الاستخدام الأكاديمي له على فهم الخطوات، شروط التطبيق، مؤشرات النجاح، والأخطاء الشائعة عند نقلها إلى بيئة مهنية.`
  }
  if (category === 'THEORY') {
    return `يلخص هذا المحور إطاراً أو نموذجاً نظرياً من كتاب «${bookName}». يتم توظيفه في الدراسة للمقارنة والتحليل وبناء تفسير مهني مدعوم بدليل بدلاً من الحفظ العام.`
  }
  return `يلخص هذا المحور فكرة أساسية من كتاب «${bookName}» بطريقة صالحة للدراسة والامتحان. يركز على المعنى المهني للفكرة، علاقتها بالتخصص، وكيف يمكن استخدامها في سؤال تطبيقي أو واجب تحليلي.`
}

function deterministicKnowledgeItems(book: RawBookForHydration & { semester?: number | null }, text: string, semester?: number | null): KnowledgeItemDraft[] {
  const seeds = splitBookIntoSeeds(text, MAX_ITEMS_PER_BOOK)
  const seen = new Set<string>()
  const items: KnowledgeItemDraft[] = []
  for (let i = 0; i < seeds.length; i++) {
    const seed = seeds[i]
    const category = inferCategory(seed, i)
    const rawTitle = titleFromSeed(seed, i)
    const rawSummary = cleanText(seed, 500)
    const rawExcerpt = cleanText(seed, 700)
    const broken = looksLikeBrokenAcademicOutput(`${rawTitle}. ${rawSummary}`)
    const title = broken ? fallbackKnowledgeTitle(book.title, category, i) : rawTitle
    const summary = broken ? fallbackKnowledgeSummary(book.title, category) : rawSummary
    const excerpt = broken || looksLikeBrokenAcademicOutput(rawExcerpt) ? null : rawExcerpt
    const key = norm(title).slice(0, 140)
    if (!key || seen.has(key)) continue
    seen.add(key)
    items.push({
      category,
      title,
      summary,
      excerpt,
      keywords: tokenizeKeywords(`${title} ${summary}`),
      importance: category === 'QUESTION_SEED' || category === 'CASE' ? 78 : category === 'THEORY' || category === 'METHOD' ? 72 : 60,
      semester: semester ?? null,
      sourceNote: `مستخرج آلياً من «${book.title}» بعد تنظيف جودة النص`,
    })
  }

  if (items.length === 0 && (book.description || book.title)) {
    const seed = cleanText(`${book.title}. ${book.description || ''}`, 700)
    const summary = looksLikeBrokenAcademicOutput(seed) ? fallbackKnowledgeSummary(book.title, 'SUMMARY') : seed
    items.push({
      category: 'SUMMARY',
      title: fallbackKnowledgeTitle(book.title, 'SUMMARY', 0),
      summary,
      excerpt: looksLikeBrokenAcademicOutput(seed) ? null : seed,
      keywords: tokenizeKeywords(summary),
      importance: 40,
      semester: semester ?? null,
      sourceNote: 'مبني على بيانات الكتاب بعد تعذر استخراج نص أكاديمي نظيف',
    })
  }
  return items.slice(0, MAX_ITEMS_PER_BOOK)
}

function normalizeDrafts(rawItems: any[], fallback: KnowledgeItemDraft[], semester?: number | null): KnowledgeItemDraft[] {
  const seen = new Set<string>()
  const out: KnowledgeItemDraft[] = []
  for (const raw of rawItems) {
    const category = safeCategory(raw?.category)
    const title = cleanText(raw?.title || raw?.name || raw?.concept, 180)
    const summary = cleanText(raw?.summary || raw?.description || raw?.explanation, 900)
    const excerpt = cleanText(raw?.excerpt || raw?.evidence || raw?.sourceEvidence || summary, 900)
    if (!title || !summary || summary.length < 30) continue
    if (looksLikeBrokenAcademicOutput(title, { allowShort: true }) || looksLikeBrokenAcademicOutput(summary) || looksLikeBrokenAcademicOutput(excerpt)) continue
    const key = norm(`${title} ${summary}`).slice(0, 180)
    if (!key || seen.has(key)) continue
    seen.add(key)
    const keywords = safeGeneratedList(raw?.keywords, tokenizeKeywords(`${title} ${summary}`), 10, 50)
    out.push({
      category,
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
    const title = safeGeneratedOrFallback(fb.title, 'محور معرفي من الكتاب المقرر', 180, true)
    const summary = safeGeneratedOrFallback(fb.summary, 'محور أكاديمي منظّم من الكتاب المقرر صالح للدراسة والامتحان.', 900)
    const excerpt = fb.excerpt && !looksLikeBrokenAcademicOutput(fb.excerpt) ? cleanText(fb.excerpt, 900) : null
    const key = norm(`${title} ${summary}`).slice(0, 180)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push({ ...fb, title, summary, excerpt, keywords: safeGeneratedList(fb.keywords, tokenizeKeywords(`${title} ${summary}`), 10, 50) })
    if (out.length >= MAX_ITEMS_PER_BOOK) break
  }
  return out
}

async function aiKnowledgeItems(
  program: { titleAr: string; titleEn?: string | null; category?: string | null; description?: string | null },
  book: RawBookForHydration & { semester?: number | null },
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
سياسة مستوى الكتاب: ${book.levelPolicy || '-'}
عمق القراءة المتوقع: ${book.readingDepth || '-'}
طبيعة التقييم المبني على الكتاب: ${book.assessmentOrientation || '-'}
حالة قراءة الرابط/الملف: ${book.linkReadStatus || '-'} — ${book.linkReadNote || '-'}

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
  const data = items.map((item) => {
    const title = cleanText(item.title, 220)
    const summary = cleanText(item.summary, 1600)
    const excerpt = item.excerpt ? cleanText(item.excerpt, 1800) : null
    const keywords = safeGeneratedList(item.keywords, tokenizeKeywords(`${title} ${summary}`), 10, 60)
    if (!title || !summary || looksLikeBrokenAcademicOutput(title, { allowShort: true }) || looksLikeBrokenAcademicOutput(summary) || (excerpt && looksLikeBrokenAcademicOutput(excerpt))) return null
    return {
      programId,
      bookId,
      semester: item.semester ?? null,
      category: safeCategory(item.category),
      title,
      summary,
      excerpt,
      keywords: JSON.stringify(keywords),
      importance: safeImportance(item.importance),
      sourceNote: item.sourceNote ? cleanText(item.sourceNote, 400) : null,
    }
  }).filter(Boolean) as any[]
  if (data.length === 0) return 0
  await db.bookKnowledgeItem.createMany({ data })
  return data.length
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
  return rows.map((r) => {
    const title = cleanText(r.title, 220)
    const summary = cleanText(r.summary, 1600)
    const excerpt = r.excerpt ? cleanText(r.excerpt, 1800) : null
    const rawKeywords = (() => { try { return JSON.parse(r.keywords || '[]') } catch { return [] } })() as string[]
    return {
      id: r.id,
      bookId: r.bookId,
      bookTitle: r.book?.title || null,
      semester: r.semester,
      category: safeCategory(r.category),
      title,
      summary,
      excerpt,
      keywords: safeGeneratedList(rawKeywords, tokenizeKeywords(`${title} ${summary}`), 10, 60),
      importance: r.importance,
      sourceNote: r.sourceNote ? cleanText(r.sourceNote, 400) : null,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }
  }).filter((item) => item.title && item.summary && !looksLikeBrokenAcademicOutput(item.title, { allowShort: true }) && !looksLikeBrokenAcademicOutput(item.summary) && (!item.excerpt || !looksLikeBrokenAcademicOutput(item.excerpt)))
}

export async function buildKnowledgeContextForExam(programId: string, semester?: number | null, limit = 48): Promise<string> {
  await ensureProgramKnowledge(programId, semester, 8).catch(() => null)
  const items = await getProgramKnowledgeItems(programId, semester, limit)
  if (!items.length) return ''
  return items
    .map((item, i) => {
      const kw = item.keywords?.length ? ` — مصطلحات: ${item.keywords.slice(0, 5).join('، ')}` : ''
      const source = item.bookTitle ? ` — المصدر: ${item.bookTitle}` : ''
      // صياغة طبيعية بلا عناوين داخلية حتى لا تتحول إلى نص سؤال أو دليل دراسة.
      return `${i + 1}. ${cleanText(item.title, 170)}. ${cleanText(item.summary, 420)}${item.excerpt ? ` — يستند إلى: ${cleanText(item.excerpt, 260)}` : ''}${kw}${source}`
    })
    .join('\n')
}
