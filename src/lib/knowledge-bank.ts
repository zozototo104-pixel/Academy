import { db } from '@/lib/db'
import { getZAI, chatWithRetry } from '@/lib/ai'
import { geminiCompleteJson, geminiVisionJson } from '@/lib/gemini'
import { hydrateBookContentForExam, type RawBookForHydration } from '@/lib/book-content'
import { cleanAcademicOutput as sharedCleanAcademicOutput, looksLikeBrokenGeneratedArabic as sharedLooksBrokenAcademicOutput, conciseAcademicLabel } from '@/lib/academic-output-quality'

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

const KNOWLEDGE_CATEGORIES = ['SUMMARY', 'CONCEPT', 'DEFINITION', 'THEORY', 'METHOD', 'CASE', 'QUESTION_SEED'] as const
const CATEGORY_SET = new Set<string>(KNOWLEDGE_CATEGORIES)
// سقف أمان تقني فقط إذا رجع النموذج مئات العناصر؛ لا نطلب من Gemini رقماً محدداً.
const MAX_ITEMS_PER_BOOK = 80
const RICH_ITEMS_PER_BOOK_TARGET = MAX_ITEMS_PER_BOOK
const MIN_ACCEPTABLE_AI_ITEMS = 1
const MIN_CONTEXT_KNOWLEDGE_ITEMS = 1
const MIN_AI_CATEGORY_DIVERSITY = 1
const AI_SAMPLE_SEEDS = 30
const METADATA_ITEMS_TARGET = 20
// تعريف احتياطي يمنع كسر نسخة Vercel إذا بقيت دالة مبنية من commit سابق تشير لهذا الثابت.
const MAX_DIRECT_FILE_AI_BYTES = 10 * 1024 * 1024

export const KNOWLEDGE_BANK_LIMITS = {
  maxItemsPerBook: MAX_ITEMS_PER_BOOK,
  targetItemsPerBook: RICH_ITEMS_PER_BOOK_TARGET,
  minAcceptableAiItems: MIN_ACCEPTABLE_AI_ITEMS,
  minContextItems: MIN_CONTEXT_KNOWLEDGE_ITEMS,
  minAiCategoryDiversity: MIN_AI_CATEGORY_DIVERSITY,
}

export function cleanAcademicGeneratedText(value: unknown, max = 1600) {
  // توحيد التنظيف مع الحارس المركزي حتى لا تتسرب بادئات مثل
  // «حالة تطبيقية من النص» أو Markdown إلى بنك المعرفة أو أدلة الدراسة.
  return sharedCleanAcademicOutput(value, max)
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
  // استخدم الحارس المركزي أولاً حتى يكون الحكم موحداً بين التوليد والعرض والتنظيف.
  // في النصوص القصيرة نسمح للحارس المحلي بالقرار حتى لا يحذف مصطلحاً صحيحاً من كلمة أو كلمتين.
  if ((!opts.allowShort || raw.length > 45) && sharedLooksBrokenAcademicOutput(raw)) return true
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
    'محور معرفي مهم', 'حاله تطبيقيه من النص', 'حالة تطبيقية من النص', 'منهجيه مستخرجه من النص', 'منهجية مستخرجة من النص',
    'نظريه او اطار من النص', 'نظرية أو إطار من النص', 'تعريف من النص', 'بذره سؤال من النص', 'بذرة سؤال من النص',
    'دليل من المحتوي', 'دليل من المحتوى', 'خلاصه اكاديميه', 'خلاصة اكاديمية',
    'مقتطف داعم', 'مصطلحات مرتبطه', 'كلمات مفتاحيه', 'مصدر القراءه', 'بنك المعرفه الاكاديمي المستخرج',
    'يحول هذا العنصر', 'يحوّل هذا العنصر', 'يعرض هذا العنصر', 'خلاصه محوريه من النص', 'خلاصة محورية من النص',
    'الدليل المقروء', 'شرح بلغه اكاديميه واضحه', 'ربط بحاله مهنيه',
    'اي عباره تفسر بصوره ادق دلاله', 'كيف يمكن فهم فكره', 'لا تستخدم رموزا تقنيه',
    'يمثل هذا المحور ماده صالحه', 'يمثل هذا المحور مادة صالحة', 'تظهر الفكره في القراءه من خلال', 'تظهر الفكرة في القراءة من خلال',
    'مخطط معرفي شامل وبنك افكار امتحاني', 'textcontent', '\\n\\n',
    'google books', 'books google', 'goodreads', 'worldcat', 'tbm bks',
    'libro de la guerra', 'tratado de la perfeccion', 'tratado de la perfección', 'lehrsätze', 'lehrs atze',
    'vellena', 'bonapert', 'بونابرت رجاء الكتاب', 'كتاب الثاين', 'الكتاب ويف', 'كتاب احرب',
    'يفترض اجتزال', 'هو يفتترض', 'حوالي عام 8121', 'عام 8115', 'عام 8518',
    'مسو وتفوق', 'صوت الى استراتيجية', 'صوت الي استراتيجية', 'صوت الى استراتيجيه', 'صوت الي استراتيجيه',
    'اختاذ القرار', 'اختاد القرار', 'القررا', 'مبعن اخر', 'مبدى الموضوعيه', 'مبدأ الموضوعية يف',
    'يف قراءة', 'يف تحليل', 'يف بداية', 'يف صناعة', 'يف سياق', 'يف اطار', 'يف إطار',
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
    'مسو وتفوق', 'صوت الى استراتيجية', 'صوت الي استراتيجية', 'صوت الى استراتيجيه', 'صوت الي استراتيجيه',
    'اختاذ القرار', 'اختاد القرار', 'القررا', 'مبعن اخر', 'مبدى الموضوعيه', 'مبدأ الموضوعية يف',
    'يف قراءة', 'يف تحليل', 'يف اختاذ', 'يف اتخاذ', 'يف بداية', 'يف صناعة', 'يف سياق', 'يف إطار', 'يف اطار',
  ]
  if (brokenFragments.some((x) => n.includes(norm(x)))) return true

  const normalizedTokens = n.split(' ')
  const weirdTokenCount = normalizedTokens.filter((t) => ['يف', 'الثاين', 'ويف', 'اختاذ', 'اختاد', 'القررا', 'مبعن', 'املوضوعيه', 'املوضوعية', 'القرا', 'املبادي', 'االستراتيجيه'].includes(t)).length
  if (weirdTokenCount >= 1 && arabicWords >= 8) return true
  if ((n.includes('يف ') || n.includes(' ويف ')) && /(القرار|الاداره|المهني|الاستراتيجي|المشروع|الكتاب|المحتوي|المحتوى)/u.test(n)) return true

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

function labelForCategory(category: string) {
  const labels: Record<string, string> = {
    CONCEPT: 'مفهوم من النص',
    THEORY: 'نظرية أو إطار من النص',
    METHOD: 'منهجية من النص',
    CASE: 'حالة تطبيقية من النص',
    DEFINITION: 'تعريف من النص',
    QUESTION_SEED: 'بذرة سؤال من النص',
    SUMMARY: 'خلاصة من النص',
  }
  return labels[safeCategory(category)] || 'عنصر معرفة من النص'
}

function knowledgeTitleFallback(category: string, index: number) {
  const labels: Record<string, string> = {
    CONCEPT: 'مفهوم محوري',
    THEORY: 'إطار تفسيري',
    METHOD: 'منهجية تطبيق',
    CASE: 'حالة مهنية',
    DEFINITION: 'تعريف أساسي',
    QUESTION_SEED: 'سؤال مراجعة',
    SUMMARY: 'خلاصة دراسية',
  }
  return `${labels[safeCategory(category)] || 'محور معرفي'} ${index + 1}`
}

function safeKnowledgeTitle(value: unknown, summary: unknown, category: string, index: number) {
  const fromTitle = conciseAcademicLabel(value, '', 90)
  if (fromTitle && !looksLikeBrokenAcademicOutput(fromTitle, { allowShort: true })) return fromTitle
  const fromSummary = conciseAcademicLabel(summary, '', 90)
  if (fromSummary && !looksLikeBrokenAcademicOutput(fromSummary, { allowShort: true })) return fromSummary
  return knowledgeTitleFallback(category, index)
}

function categoryDiversity(items: Pick<KnowledgeItemDraft, 'category'>[]) {
  return new Set(items.map((item) => safeCategory(item.category))).size
}

function targetFromFallback(fallback: KnowledgeItemDraft[]) {
  if (fallback.length >= RICH_ITEMS_PER_BOOK_TARGET) return RICH_ITEMS_PER_BOOK_TARGET
  if (fallback.length >= MIN_ACCEPTABLE_AI_ITEMS) return fallback.length
  return Math.min(MAX_ITEMS_PER_BOOK, Math.max(MIN_ACCEPTABLE_AI_ITEMS, fallback.length || 0))
}

function hasBalancedKnowledgeShape(items: KnowledgeItemDraft[], minItems = MIN_ACCEPTABLE_AI_ITEMS) {
  return items.length >= minItems && categoryDiversity(items) >= MIN_AI_CATEGORY_DIVERSITY
}

function safeImportance(value: unknown, fallback = 55) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(10, Math.min(100, Math.round(n)))
}

function looksLikeBrokenKnowledgeSource(value: unknown) {
  const raw = cleanText(value, 5000)
  if (!raw) return true
  const n = norm(raw)
  const tokens = n.split(' ').filter(Boolean)
  const arabicLetters = countMatches(raw, /[\u0600-\u06FF]/g)
  const latinLetters = countMatches(raw, /[A-Za-zÀ-ÖØ-öø-ÿ]/g)
  const arabicWords = tokens.filter((t) => /[\u0600-\u06FF]/.test(t)).length
  const weirdTokens = new Set(['يف', 'ويف', 'الثاين', 'اختاذ', 'اختاد', 'القررا', 'القرا', 'مبعن', 'املوضوعيه', 'املوضوعية', 'املبادي', 'االستراتيجيه'])
  const weirdCount = tokens.filter((t) => weirdTokens.has(t)).length
  const bad = [
    'مسو وتفوق', 'صوت الى استراتيجية', 'صوت الي استراتيجية', 'صوت الى استراتيجيه', 'صوت الي استراتيجيه',
    'اختاذ القرار', 'اختاد القرار', 'القررا', 'مبعن اخر', 'مبدى الموضوعيه', 'مبدأ الموضوعية يف',
    'كتاب اطلب', 'كتاب احرب', 'كتاب الثاين', 'الكتاب ويف', 'يف اسبانيا', 'كتاب حرب هو',
    'انظر كتاب', 'صادر بالفرنسية', 'صادر بالانجليزية', 'صادر بالإنجليزية',
    'فيه قراءة', 'فيه تحليل', 'فيه بداية', 'فيه صناعة', 'فيه سياق', 'فيه اختيار', 'فيه اختاد', 'فيه اختاذ',
    'يف قراءة', 'يف تحليل', 'يف بداية', 'يف صناعة', 'يف سياق', 'يف اطار', 'يف إطار',
    'libro de la guerra', 'tratado de la perfeccion', 'tratado de la perfección', 'lehrsätze', 'vellena',
  ]
  if (bad.some((x) => n.includes(norm(x)))) return true
  if (arabicWords >= 50 && weirdCount >= 2) return true
  if (arabicWords >= 12 && weirdCount >= 1 && /(القرار|الاداره|المهني|الاستراتيجي|المشروع|الكتاب|المحتوي|المحتوى)/u.test(n)) return true
  if (arabicLetters >= 60 && latinLetters >= 35 && /(libro|tratado|guerra|lehrs|krieg|vellena)/i.test(raw)) return true
  if (/(?:عام|سنة|سنه|حوالي)\s*(?:[3-9]\d{3}|\d{5,})/u.test(raw) && /(كتاب|استراتيجي|الفكر|الحرب|منهج)/u.test(raw)) return true
  return false
}

function isPotentialBookContent(value: unknown) {
  const raw = cleanText(value, 2400)
  if (!raw) return false
  const n = norm(raw)
  if (/google books|books google|goodreads|worldcat|tbm bks|رابط الكتاب|لم يتوفر نص|لا يوجد نص/u.test(n)) return false
  const chars = raw.replace(/\s/g, '').length
  const letters = countMatches(raw, /[\p{L}]/gu)
  const words = countMatches(raw, /[\p{L}]{3,}/gu)
  const digits = countMatches(raw, /\d/g)
  if (raw.length < 120 || letters < 80 || words < 16) return false
  if (chars > 60 && letters / Math.max(1, chars) < 0.42) return false
  if (digits > letters * 1.1 && words < 70) return false
  if (/(?:عام|سنة|سنه|حوالي)\s*(?:[3-9]\d{3}|\d{5,})/u.test(raw) && /(كتاب|استراتيجي|الفكر|الحرب|منهج)/u.test(raw)) return false
  if (countMatches(raw, /[A-Za-zÀ-ÖØ-öø-ÿ]/g) > letters * 0.45 && /(libro|tratado|guerra|lehrs|krieg|vellena)/i.test(raw)) return false
  return true
}

function chunkBookSourceText(text: string, maxItems = 28): string[] {
  const cleaned = cleanText(text, 160000)
  if (!cleaned) return []
  const initial = cleaned
    .split(/\n{2,}|(?<=[.!؟؛])\s+(?=[\p{L}])/gu)
    .map((p) => cleanText(p, 1600))
    .filter((p) => isPotentialBookContent(p) && !looksLikeBrokenKnowledgeSource(p))

  const chunks = [...initial]
  if (chunks.length < 6) {
    const lines = cleaned.split(/\n+/).map((x) => cleanText(x, 700)).filter(Boolean)
    let buf = ''
    for (const line of lines) {
      if ((buf + ' ' + line).length > 900) {
        const c = cleanText(buf, 1000)
        if (isPotentialBookContent(c) && !looksLikeBrokenKnowledgeSource(c)) chunks.push(c)
        buf = line
      } else {
        buf = `${buf} ${line}`.trim()
      }
    }
    const last = cleanText(buf, 1000)
    if (isPotentialBookContent(last) && !looksLikeBrokenKnowledgeSource(last)) chunks.push(last)
  }

  if (chunks.length < 4 && cleaned.length >= 900) {
    const windowSize = 1000
    const step = Math.max(550, Math.floor(cleaned.length / Math.max(5, maxItems)))
    for (let i = 0; i < cleaned.length && chunks.length < maxItems; i += step) {
      const c = cleanText(cleaned.slice(i, i + windowSize), 1000)
      if (isPotentialBookContent(c) && !looksLikeBrokenKnowledgeSource(c)) chunks.push(c)
    }
  }

  const seen = new Set<string>()
  return chunks.filter((c) => {
    const key = norm(c).slice(0, 180)
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, maxItems)
}

function cleanKnowledgeSourceText(text: string, maxChars = 90000) {
  const chunks = chunkBookSourceText(text, MAX_ITEMS_PER_BOOK)
  const out: string[] = []
  let total = 0
  for (const p of chunks) {
    if (total + p.length > maxChars) break
    out.push(p)
    total += p.length + 2
  }
  return out.join('\n\n')
}

function arrayFromParsedJson(parsed: any): any[] {
  if (Array.isArray(parsed)) return parsed
  for (const key of ['items', 'knowledgeItems', 'knowledge', 'concepts', 'results', 'data']) {
    if (Array.isArray(parsed?.[key])) return parsed[key]
  }
  return []
}

function extractJsonArray(raw: string): any[] {
  const body = String(raw || '').trim()
  try {
    return arrayFromParsedJson(JSON.parse(body))
  } catch {}
  const fenced = body.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
  if (fenced) {
    try { return arrayFromParsedJson(JSON.parse(fenced)) } catch {}
  }
  const arr = body.match(/\[[\s\S]*\]/)?.[0]
  if (arr) {
    try { return arrayFromParsedJson(JSON.parse(arr)) } catch {}
  }
  const obj = body.match(/\{[\s\S]*\}/)?.[0]
  if (obj) {
    try { return arrayFromParsedJson(JSON.parse(obj)) } catch {}
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

function splitLongSeedBlock(block: string, maxChars = 1400) {
  const source = cleanText(block, 6000)
  if (!source) return []
  if (source.length <= maxChars) return [source]

  const chunks: string[] = []
  const sentences = source
    .split(/(?<=[.!؟؛])\s+|\n+/gu)
    .map((s) => cleanText(s, 700))
    .filter(Boolean)

  if (sentences.length > 1) {
    let cur = ''
    for (const sentence of sentences) {
      if ((cur + ' ' + sentence).trim().length > maxChars && cur.length >= 360) {
        chunks.push(cur)
        cur = sentence
      } else {
        cur = `${cur} ${sentence}`.trim()
      }
    }
    if (cur.length >= 180) chunks.push(cur)
  }

  if (chunks.length === 0) {
    const words = source.split(/\s+/).filter(Boolean)
    const windowSize = 120
    const step = 90
    for (let i = 0; i < words.length; i += step) {
      const chunk = cleanText(words.slice(i, i + windowSize).join(' '), maxChars)
      if (chunk.length >= 180) chunks.push(chunk)
    }
  }

  return chunks
}

function splitBookIntoSeeds(text: string, maxItems = MAX_ITEMS_PER_BOOK) {
  const cleaned = cleanText(text, 160000)
  if (!cleaned) return []

  const candidates: string[] = []
  const seen = new Set<string>()
  const add = (value: string) => {
    const chunk = cleanText(value, 1500)
    const letters = (chunk.match(/[\p{L}]/gu) || []).length
    if (chunk.length < 120 || letters < 70 || looksLikeBrokenKnowledgeSource(chunk)) return
    const key = norm(chunk).slice(0, 180)
    if (!key || seen.has(key)) return
    seen.add(key)
    candidates.push(chunk)
  }

  for (const block of cleaned.split(/\n{2,}|(?<=[.!؟؛])\s+(?=[\p{L}])/gu)) {
    for (const chunk of splitLongSeedBlock(block)) add(chunk)
  }

  if (candidates.length < Math.min(12, maxItems)) {
    for (const chunk of splitLongSeedBlock(cleaned, 1500)) add(chunk)
  }

  if (candidates.length === 0) return []
  const indexes = new Set<number>()
  const take = Math.min(maxItems, candidates.length)
  for (let i = 0; i < take; i++) {
    indexes.add(Math.floor((i * candidates.length) / take))
  }
  return Array.from(indexes).map((i) => candidates[i]).filter(Boolean).slice(0, maxItems)
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
  const rawBookName = cleanText(bookTitle, 90)
  const bookName = rawBookName && !looksLikeBrokenAcademicOutput(rawBookName, { allowShort: true }) ? rawBookName : 'الكتاب المقرر'
  return `${labels[category] || 'محور معرفي'} من «${bookName}» (${index + 1})`
}

function fallbackKnowledgeSummary(bookTitle: string, category: string) {
  const rawBookName = cleanText(bookTitle, 120)
  const bookName = rawBookName && !looksLikeBrokenAcademicOutput(rawBookName, { allowShort: true }) ? rawBookName : 'الكتاب المقرر'
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

type ProgramMeta = { titleAr: string; titleEn?: string | null; category?: string | null; description?: string | null }

function levelLabel(category?: string | null) {
  const c = String(category || '').toUpperCase()
  if (c.includes('DIPLOMA')) return 'الدبلوم المهني'
  if (c.includes('MASTER')) return 'الماجستير المهني'
  if (c.includes('DOCTOR')) return 'الدكتوراه المهنية'
  if (c.includes('ACCREDIT')) return 'مسار الاعتماد المهني'
  return 'المسار المهني الأكاديمي'
}

function cleanBookName(book: RawBookForHydration) {
  const raw = cleanText(book.title || book.titleEn || 'الكتاب المقرر', 110)
  return raw && !looksLikeBrokenAcademicOutput(raw, { allowShort: true }) ? raw : 'الكتاب المقرر'
}

function metadataKnowledgeBlueprint(program: ProgramMeta, book: RawBookForHydration & { semester?: number | null }, semester?: number | null): KnowledgeItemDraft[] {
  const bookName = cleanBookName(book)
  const programTitle = cleanText(program.titleAr || program.titleEn || 'البرنامج الأكاديمي', 160)
  const level = levelLabel(program.category)
  const purpose = cleanText(book.description || book.levelPolicy || program.description || `توظيف الكتاب في بناء معرفة مهنية متدرجة داخل ${programTitle}.`, 520)
  const readingDepth = cleanText(book.readingDepth || `قراءة تحليلية تناسب ${level}: فهم المفاهيم، ربطها بسياقات العمل، وتحويلها إلى قرارات وحالات تطبيقية.`, 420)
  const assessment = cleanText(book.assessmentOrientation || 'أسئلة فهم وتحليل وتطبيق، مع حالات عملية وإجابات قصيرة مدعومة بالدليل.', 420)
  const note = 'خطة معرفة منهجية مبنية على توصيف الكتاب والبرنامج لأن النص الكامل غير متاح أو غير مقروء بما يكفي؛ لا تُعامل كاقتباس حرفي من الكتاب.'
  const baseKeywords = tokenizeKeywords(`${bookName} ${programTitle} ${purpose}`, 6)
  const mk = (category: string, title: string, summary: string, importance = 65, keywords: string[] = []): KnowledgeItemDraft => ({
    category,
    title: cleanText(title, 190),
    summary: cleanText(summary, 1000),
    excerpt: null,
    keywords: safeGeneratedList([...keywords, ...baseKeywords], baseKeywords, 9, 55),
    importance,
    semester: semester ?? book.semester ?? null,
    sourceNote: note,
  })

  const items: KnowledgeItemDraft[] = [
    mk('SUMMARY', `الخريطة الدراسية لكتاب «${bookName}»`, `يمثل هذا العنصر خريطة أولية لاستخدام كتاب «${bookName}» داخل ${programTitle}. سبب الاعتماد: ${purpose}. يتعامل الطالب مع الكتاب بوصفه مرجعاً لتكوين لغة مهنية، ثم تحويل المفاهيم إلى مخرجات قابلة للقياس في الاختبار والواجب والمناقشة.`, 62, ['خريطة دراسية', 'مخرجات تعلم']),
    mk('CONCEPT', `الفكرة المحورية في «${bookName}»`, `الفكرة المحورية هي تحويل موضوع الكتاب إلى أداة فهم داخل ${programTitle}: تحديد المفاهيم الأساسية، علاقتها بالممارسة المهنية، وما الذي يجب أن يستطيع الطالب تفسيره أو تطبيقه بعد القراءة.`, 76, ['مفهوم محوري', 'تطبيق مهني']),
    mk('DEFINITION', `مصطلحات أساسية مرتبطة بكتاب «${bookName}»`, `يبني هذا العنصر قاموساً مبدئياً للمصطلحات التي يجب ضبطها قبل الامتحان: المصطلح، تعريفه العملي، حدوده، ومثال استخدامه داخل تخصص ${programTitle}. لا يعتمد على حفظ التعريف وحده بل على القدرة على تمييزه في حالة مهنية.`, 66, ['مصطلحات', 'تعريفات']),
    mk('THEORY', `النماذج والنظريات المتوقعة في محور الكتاب`, `على الطالب أن يقرأ الكتاب بحثاً عن النماذج أو الأطر أو المدارس الفكرية التي تفسر الظاهرة المهنية. في ${level} لا يكفي ذكر النظرية؛ يجب بيان فرضياتها وحدودها وما الذي تضيفه عند تحليل حالة واقعية في ${programTitle}.`, 74, ['نظريات', 'نماذج']),
    mk('METHOD', `منهجية قراءة الكتاب وتحويله إلى معرفة`, `منهجية التعامل مع الكتاب تبدأ بتحديد المفاهيم، ثم العلاقات بينها، ثم استخراج إجراءات أو خطوات تطبيق، ثم اختبارها على حالة عملية. ${readingDepth}`, 78, ['منهجية', 'تحليل']),
    mk('METHOD', `خطوات التطبيق المهني المستخرجة من محور الكتاب`, `يستخدم الطالب الكتاب لبناء تسلسل عملي: تشخيص المشكلة، تحديد أصحاب العلاقة أو المتغيرات، اختيار أداة تحليل مناسبة، صياغة بدائل، ثم تحديد مؤشرات نجاح قابلة للمتابعة.`, 72, ['خطوات تطبيق', 'مؤشرات']),
    mk('CASE', `حالة تطبيقية مبنية على موضوع «${bookName}»`, `يمكن تحويل موضوع الكتاب إلى حالة تطبيقية في ${programTitle}: موقف مهني يتضمن قراراً، مخاطرة أو تعارض مصالح، ثم يطلب من الطالب تحليل البدائل وتبرير الاختيار وفق مفاهيم الكتاب.`, 82, ['حالة عملية', 'قرار']),
    mk('CASE', `تحليل الأطراف والمخاطر في تطبيق أفكار الكتاب`, `يركز هذا العنصر على تحويل القراءة إلى تحليل مهني: من يتأثر بالقرار؟ ما المخاطر أو القيود؟ ما الموارد المطلوبة؟ وكيف تُقاس النتيجة؟`, 78, ['أصحاب مصلحة', 'مخاطر']),
    mk('CONCEPT', `العلاقة بين محتوى الكتاب ومخرجات التعلم`, `يربط هذا العنصر الكتاب بمخرجات التعلم: الفهم، التحليل، التطبيق، والتقييم. كل فكرة يجب أن تتحول إلى مهارة يمكن ملاحظتها في إجابة الطالب أو مشروعه التطبيقي.`, 70, ['مخرجات تعلم', 'مهارات']),
    mk('QUESTION_SEED', `بذرة سؤال فهم من «${bookName}»`, `سؤال مناسب: اشرح مفهوماً مركزياً من الكتاب، ثم بيّن كيف يغير فهم هذا المفهوم طريقة التعامل مع مشكلة في ${programTitle}. يجب أن تتضمن الإجابة تعريفاً موجزاً ومثالاً مهنياً.`, 80, ['سؤال فهم', 'مثال']),
    mk('QUESTION_SEED', `بذرة سؤال تحليل وتطبيق`, `سؤال مناسب: أمام حالة مهنية مرتبطة بموضوع الكتاب، حدّد المشكلة، حلل البدائل، اختر قراراً مبرراً، ثم اربط قرارك بمؤشر نجاح أو خطر محتمل. طبيعة التقييم: ${assessment}`, 86, ['سؤال تطبيقي', 'تحليل']),
    mk('QUESTION_SEED', `بذرة سؤال تقييم نقدي`, `سؤال مناسب لمرحلة ${level}: قيّم حدود تطبيق فكرة من الكتاب في بيئة مهنية معقدة، واذكر متى تصبح الفكرة غير كافية أو تحتاج إلى نموذج مكمّل.`, 84, ['تقييم نقدي', 'حدود التطبيق']),
    mk('THEORY', `المقارنة بين الأطر والمداخل`, `يوجه هذا العنصر الطالب إلى المقارنة بين أكثر من مدخل: ما الافتراضات؟ ما نقاط القوة؟ ما حدود الاستخدام؟ وكيف تؤثر طبيعة المؤسسة أو المشكلة على اختيار المدخل؟`, 72, ['مقارنة', 'أطر']),
    mk('METHOD', `تحويل القراءة إلى واجب أكاديمي`, `يمكن تكليف الطالب بتقرير قصير يستخرج ثلاث أفكار من الكتاب، يربط كل فكرة بحالة مهنية، ثم يضع توصية تطبيقية مدعومة بسبب واضح ومؤشر قياس.`, 69, ['واجب', 'تقرير']),
    mk('DEFINITION', `حدود المصطلحات وسياق استخدامها`, `لا يكفي تعريف المصطلح خارج سياقه. يدرّب هذا العنصر الطالب على بيان متى يستخدم المصطلح، وما حدوده، وما المؤشرات التي تثبت صحة استعماله داخل ${programTitle}.`, 67, ['حدود المفهوم', 'سياق']),
    mk('SUMMARY', `خلاصة مراجعة قبل الامتحان`, `تجمع هذه الخلاصة ما يجب تحويله من الكتاب إلى مراجعة عملية: مصطلح مضبوط، فكرة محورية، إطار تفسير، خطوة تطبيق، حالة، ثم سؤال تقويمي يختبر الفهم والتحليل.`, 71, ['مراجعة', 'امتحان']),
    mk('THEORY', `حدود تطبيق أفكار الكتاب`, `يوجه هذا العنصر الطالب إلى عدم تعميم الأفكار آلياً. كل إطار أو فكرة من الكتاب تحتاج إلى شروط تطبيق، وحدود صلاحية، ومؤشرات تكشف متى تصبح غير كافية في بيئة ${programTitle}.`, 73, ['حدود التطبيق', 'صلاحية']),
    mk('METHOD', `مؤشرات تحويل المعرفة إلى أداء`, `يربط هذا العنصر بين القراءة والأداء: ما السلوك أو القرار أو التقرير الذي يثبت أن الطالب فهم الكتاب؟ وكيف يمكن قياسه بدرجة واضحة في الواجب أو الامتحان؟`, 76, ['مؤشرات أداء', 'قياس']),
    mk('CONCEPT', `أخطاء الفهم الشائعة في محور الكتاب`, `من الأخطاء الشائعة تحويل الكتاب إلى حفظ عناوين أو تعريفات فقط. المطلوب في ${programTitle} هو قراءة نقدية تفهم السياق، تميز الشروط، وتربط المفهوم بنتيجة قابلة للقياس.`, 68, ['أخطاء شائعة', 'فهم نقدي']),
    mk('CASE', `مناقشة شفوية حول تطبيق الكتاب`, `في المناقشة يستطيع المشرف أن يطلب من الطالب الدفاع عن تطبيق فكرة من الكتاب على موقف عملي، ثم يسأله عن القيود والبدائل والمؤشرات. الهدف قياس الفهم العميق لا استرجاع النص.`, 74, ['مناقشة', 'دفاع علمي']),
  ]

  const seen = new Set<string>()
  return items.filter((item) => {
    const key = norm(`${item.category} ${item.title}`).slice(0, 160)
    if (!key || seen.has(key)) return false
    seen.add(key)
    return !!item.title && !!item.summary && !looksLikeBrokenAcademicOutput(item.title, { allowShort: true }) && !looksLikeBrokenAcademicOutput(item.summary)
  }).slice(0, MAX_ITEMS_PER_BOOK)
}

function evidenceFromSeed(seed: string, max = 520) {
  const sentences = cleanText(seed, 1400)
    .split(/(?<=[.!؟؛])\s+|\n+/gu)
    .map((s) => cleanText(s, max))
    .filter((s) => s.length >= 35 && !looksLikeBrokenAcademicOutput(s))
  return cleanText(sentences.slice(0, 3).join(' '), max) || cleanText(seed, max)
}

const TITLE_STOP_WORDS = new Set([
  'هذا', 'هذه', 'ذلك', 'الذي', 'التي', 'على', 'الى', 'إلى', 'في', 'من', 'عن', 'مع', 'داخل', 'ضمن', 'بين',
  'كتاب', 'الكتاب', 'النص', 'المقطع', 'المقروء', 'الدليل', 'المحتوى', 'المحتوي', 'البرنامج', 'الفصل',
  'يمكن', 'يجب', 'يعرض', 'يعالج', 'يوضح', 'يركز', 'يوجه', 'يبين', 'يحول', 'تحويل', 'مستخرجة', 'مستخرج',
].map(norm))

function conciseSeedPhrase(seed: string) {
  // نستخرج عنواناً دلالياً من المقطع عبر الحارس المركزي، لا أول جملة حرفية قد تكون OCR أو فعلاً عاماً مثل «ينظم...».
  const label = conciseAcademicLabel(seed, '', 90)
  if (label && !looksLikeBrokenAcademicOutput(label, { allowShort: true })) return label
  return ''
}

function semanticTopicFromSeed(category: string, seed: string, index: number) {
  const phrase = conciseSeedPhrase(seed)
  if (phrase) return phrase

  const words = norm(seed).split(' ')
  const seen = new Set<string>()
  const keywords: string[] = []
  for (const token of words) {
    if (token.length < 4 || TITLE_STOP_WORDS.has(token) || /^\d+$/.test(token) || seen.has(token)) continue
    seen.add(token)
    keywords.push(token)
    if (keywords.length >= 4) break
  }
  const core = keywords.slice(0, 2).join(' و') || `المحور ${index + 1}`
  const cat = safeCategory(category)
  if (cat === 'DEFINITION') return `تعريف ${core}`
  if (cat === 'THEORY') return `إطار ${core}`
  if (cat === 'METHOD') return `منهجية تحليل ${core}`
  if (cat === 'CASE') return `حالة تطبيقية في ${core}`
  if (cat === 'QUESTION_SEED') return `سؤال تطبيقي حول ${core}`
  if (cat === 'SUMMARY') return `خلاصة محور ${core}`
  return `مفهوم ${core}`
}

function realTextKnowledgeSummary(category: string, seed: string, programTitle: string) {
  const evidence = evidenceFromSeed(seed, 430)
  const cleanEvidence = evidence ? `وتظهر الفكرة في القراءة من خلال: ${evidence}` : 'وتستند الفكرة إلى مقطع مقروء صالح بعد تنظيف النص.'
  if (category === 'DEFINITION') return `يضبط هذا المحور معنى مصطلح أو مفهوم مركزي، ثم يحدد حدوده وشروط استخدامه في ${programTitle}. ${cleanEvidence}. المطلوب من الطالب تمييز المصطلح داخل حالة مهنية لا حفظه بمعزل عن سياقه.`
  if (category === 'THEORY') return `يركز هذا المحور على إطار أو مدخل تفسيري يساعد الطالب على فهم العلاقات والافتراضات وحدود التطبيق. ${cleanEvidence}. يستخدم في ${programTitle} للمقارنة بين البدائل وبناء تفسير مهني مدعوم.`
  if (category === 'METHOD') return `يعرض هذا المحور طريقة عمل قابلة للتحويل إلى خطوات: تشخيص المشكلة، تحليل العوامل، اختيار القرار، ثم تحديد مؤشر متابعة. ${cleanEvidence}.`
  if (category === 'CASE') return `يمثل هذا المحور مادة صالحة لبناء حالة مهنية قابلة للنقاش والتقييم في ${programTitle}. ${cleanEvidence}. يركز التحليل على الأطراف المؤثرة، القيود، المخاطر، والنتائج المتوقعة.`
  if (category === 'QUESTION_SEED') return `يفتح هذا المحور سؤال مراجعة تطبيقي: كيف تُفسَّر الفكرة وكيف تُستخدم في موقف مهني داخل ${programTitle}؟ ${cleanEvidence}.`
  if (category === 'SUMMARY') return `يلخص هذا المحور فكرة مركزية تصلح لبناء مراجعة قبل الاختبار أو الواجب في ${programTitle}. ${cleanEvidence}.`
  return `يعالج هذا المحور مفهوماً مركزياً يجب فهم علاقته بسياق ${programTitle} وتحويله إلى تطبيق مهني واضح. ${cleanEvidence}.`
}

function deterministicKnowledgeItems(
  book: RawBookForHydration & { semester?: number | null },
  text: string,
  semester?: number | null,
  program?: ProgramMeta,
  allowMetadataBlueprint = true
): KnowledgeItemDraft[] {
  const seeds = splitBookIntoSeeds(text, MAX_ITEMS_PER_BOOK)
  const seen = new Set<string>()
  const items: KnowledgeItemDraft[] = []
  const programTitle = cleanText(program?.titleAr || program?.titleEn || 'البرنامج الأكاديمي', 150)

  const push = (category: string, seed: string, index: number, _titlePrefix?: string, importance?: number) => {
    const safeCat = safeCategory(category)
    // التصنيف محفوظ في حقل category؛ العنوان نفسه يجب أن يكون مفهوماً/محوراً حقيقياً لا بادئة عرض مثل «حالة تطبيقية من النص».
    const topic = semanticTopicFromSeed(safeCat, seed, index)
    const title = cleanText(topic, 180)
    const summary = cleanText(realTextKnowledgeSummary(safeCat, seed, programTitle), 1000)
    const excerpt = evidenceFromSeed(seed, 760)
    const key = norm(`${safeCat} ${title} ${summary}`).slice(0, 190)
    if (!key || seen.has(key)) return
    if (looksLikeBrokenAcademicOutput(title, { allowShort: true }) || looksLikeBrokenAcademicOutput(summary) || looksLikeBrokenAcademicOutput(excerpt)) return
    seen.add(key)
    items.push({
      category: safeCat,
      title,
      summary,
      excerpt,
      keywords: tokenizeKeywords(`${title} ${summary} ${excerpt}`),
      importance: importance ?? (safeCat === 'QUESTION_SEED' || safeCat === 'CASE' ? 82 : safeCat === 'THEORY' || safeCat === 'METHOD' ? 74 : 66),
      semester: semester ?? null,
      sourceNote: `مبني مباشرة على مقطع مقروء من «${book.title}» بعد تنظيف جودة النص`,
    })
  }

  for (let i = 0; i < seeds.length && items.length < MAX_ITEMS_PER_BOOK; i++) {
    const seed = seeds[i]
    const primary = inferCategory(seed, i)
    push(primary, seed, i)
    if (items.length >= MAX_ITEMS_PER_BOOK) break
    if (primary !== 'QUESTION_SEED') push('QUESTION_SEED', seed, i, 'بذرة سؤال من النص', 84)
    if (items.length >= MAX_ITEMS_PER_BOOK) break
    if (i % 2 === 0 && primary !== 'CASE') push('CASE', seed, i, 'حالة تطبيقية من النص', 80)
    if (items.length >= MAX_ITEMS_PER_BOOK) break
    if (i % 3 === 1 && primary !== 'METHOD') push('METHOD', seed, i, 'منهجية مستخرجة من النص', 76)
  }

  // ضمان حد أدنى غني من الكتاب الحقيقي عند وجود نص مقروء: لا نكتفي بعدد المقاطع، بل نحول المقطع الواحد إلى معرفة وسؤال وحالة.
  const deterministicTarget = Math.min(
    MAX_ITEMS_PER_BOOK,
    cleanText(text, 1200).length >= 900 && !allowMetadataBlueprint ? RICH_ITEMS_PER_BOOK_TARGET : METADATA_ITEMS_TARGET
  )
  let round = 0
  while (items.length < deterministicTarget && seeds.length > 0 && round < 7) {
    for (let i = 0; i < seeds.length && items.length < deterministicTarget; i++) {
      const cycle = ['CONCEPT', 'DEFINITION', 'THEORY', 'METHOD', 'CASE', 'QUESTION_SEED', 'SUMMARY']
      push(cycle[(i + round) % cycle.length], seeds[i], i + round * seeds.length)
    }
    round++
  }

  const blueprint = allowMetadataBlueprint && program ? metadataKnowledgeBlueprint(program, book, semester) : []
  if (allowMetadataBlueprint && items.length < deterministicTarget) {
    for (const fb of blueprint) {
      const key = norm(`${fb.category} ${fb.title}`).slice(0, 160)
      if (!key || seen.has(key)) continue
      seen.add(key)
      items.push(fb)
      if (items.length >= deterministicTarget) break
    }
  }

  if (items.length === 0 && allowMetadataBlueprint && (book.description || book.title)) {
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
  for (let i = 0; i < rawItems.length; i++) {
    const raw = rawItems[i]
    const category = safeCategory(raw?.category)
    const summary = cleanText(raw?.summary || raw?.description || raw?.explanation, 900)
    const title = cleanText(safeKnowledgeTitle(raw?.title || raw?.name || raw?.concept, summary, category, i), 180)
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
  const desired = fallback.length ? targetFromFallback(fallback) : MIN_ACCEPTABLE_AI_ITEMS
  if (out.length >= desired || fallback.length === 0) return out
  for (let i = 0; i < fallback.length; i++) {
    const fb = fallback[i]
    const summary = safeGeneratedOrFallback(fb.summary, 'محور أكاديمي منظّم من الكتاب المقرر صالح للدراسة والامتحان.', 900)
    const title = safeKnowledgeTitle(fb.title, summary, fb.category, i)
    const excerpt = fb.excerpt && !looksLikeBrokenAcademicOutput(fb.excerpt) ? cleanText(fb.excerpt, 900) : null
    const key = norm(`${title} ${summary}`).slice(0, 180)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push({ ...fb, title, summary, excerpt, keywords: safeGeneratedList(fb.keywords, tokenizeKeywords(`${title} ${summary}`), 10, 50) })
    if (out.length >= desired || out.length >= MAX_ITEMS_PER_BOOK) break
  }
  return out
}

function ensureCategoryCoverage(items: KnowledgeItemDraft[], fallback: KnowledgeItemDraft[]): KnowledgeItemDraft[] {
  const required = ['SUMMARY', 'CONCEPT', 'DEFINITION', 'THEORY', 'METHOD', 'CASE', 'QUESTION_SEED']
  const out = [...items]
  const seen = new Set(out.map((item) => norm(`${item.category} ${item.title}`).slice(0, 180)).filter(Boolean))
  const addFallback = (fb: KnowledgeItemDraft) => {
    const key = norm(`${fb.category} ${fb.title}`).slice(0, 180)
    if (!key || seen.has(key)) return false
    if (!fb.title || !fb.summary || looksLikeBrokenAcademicOutput(fb.title, { allowShort: true }) || looksLikeBrokenAcademicOutput(fb.summary)) return false
    seen.add(key)
    out.push(fb)
    return true
  }
  for (const category of required) {
    if (out.some((item) => safeCategory(item.category) === category)) continue
    const fb = fallback.find((item) => safeCategory(item.category) === category)
    if (fb) addFallback(fb)
    if (out.length >= MAX_ITEMS_PER_BOOK) break
  }

  // لا نقبل بنك معرفة هزيل من كتاب مرفوع/مقروء. إذا أعاد النموذج 8 أو 10 عناصر فقط،
  // نُكملها بعناصر حتمية مبنية على مقاطع الكتاب نفسها، لا بعناوين عامة.
  const minTarget = targetFromFallback(fallback)
  if (out.length < minTarget) {
    for (const fb of fallback) {
      if (out.length >= minTarget) break
      addFallback(fb)
    }
  }
  return out.slice(0, MAX_ITEMS_PER_BOOK)
}

async function aiKnowledgeItems(
  program: { titleAr: string; titleEn?: string | null; category?: string | null; description?: string | null },
  book: RawBookForHydration & { semester?: number | null },
  text: string,
  semester?: number | null
): Promise<KnowledgeItemDraft[] | null> {
  if (text.length < 700) return null
  // لا نرسل النص الخام إلى الذكاء. أولاً نستخرج مقاطع عربية/أكاديمية نظيفة فقط،
  // لأن إرسال OCR مشوه يجعل النموذج يعيد صياغة التشوه ويحفظه في بنك المعرفة.
  const cleanSeeds = splitBookIntoSeeds(text, AI_SAMPLE_SEEDS)
    .map((s) => sharedCleanAcademicOutput(s, 1100))
    .filter((s) => s.length >= 120 && !looksLikeBrokenAcademicOutput(s) && !looksLikeBrokenKnowledgeSource(s))
  if (cleanSeeds.length < 4) return null
  const sample = cleanSeeds
    .slice(0, AI_SAMPLE_SEEDS)
    .map((s, i) => `مقطع نظيف ${i + 1}:\n${s}`)
    .join('\n\n---\n\n')

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

استخرج ${PREFERRED_AI_MIN_ITEMS} إلى ${PREFERRED_AI_MAX_ITEMS} عنصر معرفة عميقة ومختلفة فعلاً. الجودة أهم من العدد؛ لا تضف عناصر متشابهة لإكمال رقم معين. كل عنصر يجب أن يحتوي:
- category واحدة من: CONCEPT, THEORY, METHOD, CASE, DEFINITION, QUESTION_SEED, SUMMARY
- title عنوان قصير واضح
- summary شرح أكاديمي دقيق للفكرة كما ظهرت في الكتاب
- excerpt دليل أو إعادة صياغة أمينة من محتوى الكتاب، لا تخترع اقتباساً حرفياً
- keywords مصفوفة 4-8 كلمات مفتاحية
- importance رقم 10-100 حسب أهمية الفكرة للامتحان
- semester رقم الفصل أو null

إذا كان الكتاب رواية/نص سردي، استخرج الأحداث والشخصيات والصراعات والقرارات كمادة CASE وQUESTION_SEED قابلة للإسقاط على التخصص.

قواعد جودة صارمة:
- لا تحفظ عنوان كتاب أجنبي أو سطر OCR مكسور على أنه مفهوم أكاديمي.
- إذا ظهر نص مختلط مثل كلمات لاتينية كثيرة داخل جملة عربية، أو أرقام سنوات غير منطقية مثل 8121/8115/8518، تجاهل هذا المقطع ولا تبنِ عليه.
- لا تنسخ عبارات مثل «كتاب احرب»، «كتاب اطلب»، «يف إسبانيا»، «الثاين»، أو أي تركيب غير عربي مفهوم.
- أعد صياغة الفكرة بلغة عربية أكاديمية واضحة، وإذا لم تفهم المقطع فتجاوزه.
- title يجب أن يكون عنواناً دلالياً قصيراً من 3 إلى 8 كلمات، ولا يبدأ باسم الفئة أو بعبارات مثل «حالة تطبيقية من النص» أو «منهجية مستخرجة من النص».
- إذا كانت الفكرة طويلة فضع التفصيل في summary، ولا تجعل title جملة مقطوعة أو سطراً خاماً من OCR.
- كل عنصر يجب أن يكون صالحاً للطالب والمشرف والامتحان كما هو، دون حاجة لتنظيف يدوي.

أجب JSON فقط كمصفوفة عناصر.`

  // المسار الأساسي: Gemini JSON mode لأنه يفرض application/json ويقلل فشل التحليل.
  try {
    const raw = await Promise.race([
      geminiCompleteJson({
        system: 'أنت محلل مناهج جامعية. أرجع JSON صالحاً فقط على شكل مصفوفة، بلا Markdown ولا شرح خارج JSON.',
        history: [{ role: 'user', text: prompt }],
        temperature: 0.08,
        maxOutputTokens: 12288,
      }),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error('KNOWLEDGE_GEMINI_JSON_TIMEOUT')), 52000)),
    ])
    const arr = extractJsonArray(raw)
    const normalized = normalizeDrafts(arr, [], semester)
    if (hasBalancedKnowledgeShape(normalized)) return normalized
  } catch (e: any) {
    console.error('aiKnowledgeItems Gemini JSON failed:', String(e?.message || e).slice(0, 300))
  }

  // مسار احتياطي فقط إذا تعذر Gemini، مع استمرار رفض أي مخرجات غير JSON صالحة.
  try {
    const zai = await getZAI()
    const raw = await Promise.race([
      chatWithRetry(zai, [
        { role: 'assistant', content: 'أنت محلل مناهج جامعية يرجع JSON صالحاً فقط.' },
        { role: 'user', content: prompt },
      ], 2),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error('KNOWLEDGE_ZAI_TIMEOUT')), 36000)),
    ])
    const arr = extractJsonArray(raw)
    const normalized = normalizeDrafts(arr, [], semester)
    return hasBalancedKnowledgeShape(normalized) ? normalized : null
  } catch (e: any) {
    console.error('aiKnowledgeItems all providers failed:', String(e?.message || e).slice(0, 300))
    return null
  }
}

function bookMimeForVision(book: RawBookForHydration) {
  const mime = String(book.mimeType || '').toLowerCase()
  if (mime && mime !== 'application/octet-stream') return mime
  const ext = String(book.fileName || '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || ''
  if (ext === 'pdf') return 'application/pdf'
  if (['jpg', 'jpeg'].includes(ext)) return 'image/jpeg'
  if (ext === 'png') return 'image/png'
  if (ext === 'webp') return 'image/webp'
  return mime || 'application/octet-stream'
}

function canReadBookFileWithGemini(book: RawBookForHydration) {
  const mime = bookMimeForVision(book)
  return !!book.data && (mime.includes('pdf') || mime.startsWith('image/'))
}

async function aiKnowledgeItemsFromUploadedFile(
  program: ProgramMeta,
  book: RawBookForHydration & { semester?: number | null },
  semester?: number | null
): Promise<KnowledgeItemDraft[] | null> {
  if (!canReadBookFileWithGemini(book)) return null
  const mimeType = bookMimeForVision(book)
  const dataBase64 = String(book.data || '')
  if (!dataBase64 || dataBase64.length < 200) return null

  const level = levelLabel(program.category)
  const prompt = `أنت لجنة قراءة أكاديمية. أمامك ملف الكتاب المرفوع نفسه، وليس وصفاً ولا رابط معاينة. اقرأ الملف فعلياً واستخرج منه بنك معرفة مهني صالح للدراسة والامتحان والمشرف الذكي.

البرنامج: ${program.titleAr}
الدرجة: ${level}
وصف البرنامج: ${program.description || '-'}
الكتاب: ${book.title}${book.titleEn ? ` / ${book.titleEn}` : ''}
المؤلف: ${book.author || '-'}
الفصل: ${semester || book.semester || 'عام'}
سياسة المستوى: ${book.levelPolicy || '-'}
عمق القراءة المطلوب: ${book.readingDepth || '-'}
طبيعة التقييم: ${book.assessmentOrientation || '-'}

المطلوب من الملف المرفق فعلياً:
- استخرج مفاهيم مركزية من نص الكتاب نفسه.
- استخرج نظريات/أطر/نماذج إن وجدت، أو حدد الأطر الضمنية الواضحة من النص.
- استخرج منهجيات وخطوات تطبيق، وحالات أو أمثلة أو سيناريوهات عملية.
- استخرج تعريفات ومصطلحات وبذور أسئلة قابلة للاستخدام في الامتحان.
- اربط كل عنصر بتخصص البرنامج والدرجة، لكن لا تجعل العناصر عامة فارغة.
- إذا كان الملف رواية أو نصاً سردياً فحوّل الأحداث والشخصيات والقرارات والصراعات إلى حالات مهنية مرتبطة بالتخصص.

قواعد صارمة:
- لا تعتمد على عنوان الكتاب فقط.
- لا تكتب عناصر عامة مثل "الفكرة المحورية" أو "خطوات التطبيق" إلا إذا ربطتها بفكرة محددة قرأتها من الملف.
- إذا لم تتمكن من قراءة الملف فأجب بمصفوفة فارغة [] ولا تخترع معرفة.
- اكتب بالعربية الأكاديمية السليمة، ويمكن ذكر مصطلح أجنبي بين قوسين إذا كان أساسياً.
- لا تستخدم رموزاً تقنية داخل النص.
- كل عنصر يجب أن يصلح للعرض مباشرة للطالب والمشرف.
- title عنوان دلالي قصير من 3 إلى 8 كلمات؛ لا يبدأ باسم الفئة ولا بعبارات «من النص» أو «مستخرجة من النص»، ولا يحتوي Markdown.
- افصل بين العنوان المختصر والتحليل: العنوان في title، والشرح والدليل في summary وexcerpt.

أجب JSON فقط كمصفوفة من ${PREFERRED_AI_MIN_ITEMS} إلى ${PREFERRED_AI_MAX_ITEMS} عنصر عميق ومختلف فعلاً. لا تكرر الفكرة بصياغات متعددة ولا تكمل العدد بعناصر عامة. كل عنصر بهذا الشكل:
{"category":"CONCEPT|THEORY|METHOD|CASE|DEFINITION|QUESTION_SEED|SUMMARY","title":"عنوان محدد من محتوى الكتاب","summary":"شرح أكاديمي واضح مبني على ما قرأته من الملف ومربوط بالتخصص","excerpt":"دليل مختصر أو إعادة صياغة أمينة من النص المقروء","keywords":["كلمة"],"importance":80,"semester":${semester ?? 'null'},"sourceNote":"قراءة مباشرة من ملف الكتاب المرفوع"}`

  try {
    const raw = await Promise.race([
      geminiVisionJson({
        prompt,
        images: [{ mimeType, dataBase64 }],
        temperature: 0.08,
        maxOutputTokens: 12288,
      }),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error('KNOWLEDGE_FILE_AI_TIMEOUT')), 52000)),
    ])
    const arr = extractJsonArray(raw)
    const normalized = normalizeDrafts(arr, [], semester)
    return hasBalancedKnowledgeShape(normalized) ? normalized : null
  } catch (e: any) {
    console.error('aiKnowledgeItemsFromUploadedFile failed:', String(e?.message || e).slice(0, 240))
    return null
  }
}

async function aiMetadataKnowledgeItems(
  program: ProgramMeta,
  book: RawBookForHydration & { semester?: number | null },
  semester?: number | null
): Promise<KnowledgeItemDraft[] | null> {
  const fallback = metadataKnowledgeBlueprint(program, book, semester)
  const bookName = cleanBookName(book)
  const level = levelLabel(program.category)
  const prompt = `أنت مصمم مناهج أكاديمية مهنية. لا يوجد نص كامل مقروء لهذا الكتاب، لذلك لا يجوز أن تدّعي أنك اقتبست منه. المطلوب بناء بنك معرفة مبدئي ذكي من توصيف الكتاب والبرنامج، حتى يستخدمه المشرف والامتحانات كهيكل منهجي إلى حين رفع ملف الكتاب أو رابط قراءة مباشر.

البرنامج: ${program.titleAr}
الدرجة: ${level}
وصف البرنامج: ${program.description || '-'}
الكتاب: ${bookName}${book.titleEn ? ` / ${book.titleEn}` : ''}
المؤلف: ${book.author || '-'}
نبذة/سبب اعتماد الكتاب: ${book.description || '-'}
سياسة المستوى: ${book.levelPolicy || '-'}
عمق القراءة: ${book.readingDepth || '-'}
طبيعة التقييم: ${book.assessmentOrientation || '-'}
الفصل: ${semester || book.semester || 'عام'}

أنشئ ${MIN_ACCEPTABLE_AI_ITEMS} إلى ${METADATA_ITEMS_TARGET + 4} عنصر معرفة موزعة بذكاء على هذه الفئات:
CONCEPT, THEORY, METHOD, CASE, DEFINITION, QUESTION_SEED, SUMMARY

الشروط:
- اكتب بالعربية الأكاديمية الفصحى.
- لا تذكر أن النص غير مقروء داخل title أو summary؛ ضع ذلك فقط في sourceNote.
- لا تستخدم عبارات عامة مكررة؛ اجعل العناصر مرتبطة باسم البرنامج والدرجة والكتاب.
- فرّق بين الدبلوم والماجستير والدكتوراه: الدبلوم عملي، الماجستير تحليلي تطبيقي، الدكتوراه نقدي بحثي.
- اجعل CASE وQUESTION_SEED قابلة للتحويل مباشرة إلى واجب أو امتحان.
- لا تخترع اقتباسات حرفية أو فصولاً محددة من الكتاب.
- لا تكتب رموزاً تقنية داخل العنوان أو الشرح.
- title عنوان دلالي قصير من 3 إلى 8 كلمات، لا يبدأ باسم الفئة ولا بعبارات «من النص» أو «مستخرجة من النص» ولا يحتوي Markdown.

أجب JSON فقط كمصفوفة، وكل عنصر:
{"category":"CONCEPT|THEORY|METHOD|CASE|DEFINITION|QUESTION_SEED|SUMMARY","title":"عنوان أكاديمي قصير","summary":"شرح مهني واضح","excerpt":"إعادة صياغة منهجية لا اقتباس حرفي","keywords":["كلمة"],"importance":75,"semester":${semester ?? 'null'},"sourceNote":"خطة معرفة مبنية على توصيف الكتاب لا على قراءة نصه الكامل"}`

  try {
    const zai = await getZAI()
    const raw = await Promise.race([
      chatWithRetry(zai, [
        { role: 'assistant', content: 'أنت خبير مناهج مهنية يرجع JSON صالحاً فقط دون Markdown.' },
        { role: 'user', content: prompt },
      ], 2),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error('KNOWLEDGE_METADATA_AI_TIMEOUT')), 24000)),
    ])
    const arr = extractJsonArray(raw)
    const normalized = normalizeDrafts(arr, fallback, semester)
    const out = ensureCategoryCoverage(normalized.length ? normalized : fallback, fallback)
    return out.map((item) => ({
      ...item,
      excerpt: null,
      sourceNote: item.sourceNote || 'خطة معرفة مبنية على توصيف الكتاب لا على قراءة نصه الكامل',
    }))
  } catch (e: any) {
    console.error('aiMetadataKnowledgeItems fallback:', String(e?.message || e).slice(0, 240))
    return fallback
  }
}

async function persistBookTextIfNeeded(bookId: string | undefined, text: string, shouldPersist: boolean) {
  if (!bookId || !shouldPersist || text.length < 160) return
  await db.book.update({ where: { id: bookId }, data: { textContent: text.slice(0, 180000) } }).catch(() => {})
}

async function createKnowledgeRows(programId: string, bookId: string | null, items: KnowledgeItemDraft[]) {
  if (items.length === 0) return 0
  const data = items.map((item, i) => {
    const summary = cleanText(item.summary, 1600)
    const title = cleanText(safeKnowledgeTitle(item.title, summary, item.category, i), 220)
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
  const sourceText = cleanKnowledgeSourceText(hydrated.textContent || '')
  await persistBookTextIfNeeded(book.id, sourceText || hydrated.textContent, hydrated.shouldPersistText && sourceText.length >= 160)
  const semester = book.semester ?? null
  const metadataOnly = cleanText(`${book.title}. ${book.description || ''}`, 900)
  const fallback = deterministicKnowledgeItems(book, sourceText || metadataOnly, semester, book.program, sourceText.length < 900)
  let ai: KnowledgeItemDraft[] | null = null
  let buildMode: 'TEXT' | 'FILE' | 'TEXT_DETERMINISTIC' | 'METADATA' = 'METADATA'

  if (sourceText.length >= 900) {
    ai = await aiKnowledgeItems(book.program, book, sourceText, semester)
    if (ai?.length) buildMode = 'TEXT'
  }

  // إذا كان هناك ملف مرفوع لكن الاستخراج النصي لم يعط معرفة حقيقية، اقرأ الملف نفسه مباشرة عبر Gemini.
  // هذا يمنع الرجوع إلى عناصر عامة مبنية على العنوان فقط بينما يوجد PDF/صورة مرفوعة فعلياً.
  const shouldReadUploadedFileDirectly = canReadBookFileWithGemini(book) && (
    !ai?.length ||
    sourceText.length < 1800 ||
    hydrated.contentQuality === 'GEMINI_DOCUMENT' ||
    hydrated.contentQuality === 'NO_CONTENT'
  )
  if (shouldReadUploadedFileDirectly) {
    const fromFile = await aiKnowledgeItemsFromUploadedFile(book.program, book, semester)
    if (fromFile?.length) {
      ai = fromFile
      buildMode = 'FILE'
    }
  }

  if (!ai?.length && sourceText.length >= 900) {
    // للكتب المرفوعة لا نحفظ fallback حتمي مكرر مكان تحليل Gemini. إذا لم يكتمل التحليل، نفشل بدون حذف/استبدال بنك المعرفة الحالي.
    if (book.data) {
      throw new Error('لم يكتمل تحليل الذكاء الاصطناعي للملف، لذلك لم يتم حفظ عناصر معرفة عامة أو مكررة. أعد المحاولة بعد قليل أو ارفع نسخة PDF نصية/Word إذا تكرر التعطل.')
    }
    buildMode = 'TEXT_DETERMINISTIC'
  } else if (!ai?.length && book.data) {
    throw new Error(`يوجد ملف مرفوع للكتاب لكن لم يتمكن النظام من قراءة محتواه قراءة أكاديمية كافية. السبب: ${hydrated.sourceNote}. جرّب رفع PDF نصي أو Word DOCX، أو تأكد من تفعيل Gemini ووجود حصة كافية.`)
  } else if (!ai?.length) {
    ai = await aiMetadataKnowledgeItems(book.program, book, semester)
    buildMode = 'METADATA'
  }

  // إذا نجح Gemini في قراءة الكتاب، نحفظ مخرجاته كما هي ولا نكمّلها بحشو حتمي.
  // سبب التكرار السابق أن النظام كان يأخذ تحليل Gemini الجيد ثم يملؤه بعناصر fallback حتى يصل إلى 28 بنداً.
  const aiItems = ai?.length ? normalizeDrafts(ai, [], semester) : []
  const items = aiItems.length >= MIN_ACCEPTABLE_AI_ITEMS
    ? aiItems.slice(0, PREFERRED_AI_MAX_ITEMS)
    : ensureCategoryCoverage(normalizeDrafts([], fallback, semester), fallback)

  const deleted = await db.bookKnowledgeItem.deleteMany({ where: { bookId: book.id } })
  const inserted = await createKnowledgeRows(book.programId, book.id, items)
  const qualityNote = buildMode === 'TEXT'
    ? `${hydrated.sourceNote} — تم بناء بنك المعرفة من نص الكتاب المنظف قبل التوليد.`
    : buildMode === 'TEXT_DETERMINISTIC'
      ? `${hydrated.sourceNote} — تم بناء بنك المعرفة مباشرة من مقاطع الكتاب المقروءة بصياغة أكاديمية داخلية عند عدم اكتمال تنسيق استجابة النموذج.`
      : buildMode === 'FILE'
        ? 'تم بناء بنك المعرفة من قراءة مباشرة لملف الكتاب المرفوع عبر الذكاء البصري، بعد فشل الاستخراج النصي التقليدي أو عدم كفايته.'
        : `${hydrated.sourceNote} — لم يتوفر نص طويل نظيف ولا قراءة ملف كافية؛ بُنيت خريطة معرفة مهنية من توصيف الكتاب والبرنامج دون ادعاء اقتباس نصي.`
  return { programId: book.programId, bookId: book.id, inserted, deleted: deleted.count, usedAi: !!ai?.length, sourceNote: qualityNote }
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

  // تنظيف جذري قبل إعادة البناء: أي عناصر قديمة غير مرتبطة بكتاب أو من توليدات سابقة لا تبقى في بنك البرنامج.
  const orphanWhere: any = { programId, bookId: null }
  if (semester) orphanWhere.OR = [{ semester: null }, { semester }]
  const orphanDeleted = await db.bookKnowledgeItem.deleteMany({ where: orphanWhere }).catch(() => ({ count: 0 }))

  const results: KnowledgeBuildResult[] = []
  for (const b of books) {
    results.push(await rebuildKnowledgeForBook(b.id))
  }
  return {
    programId,
    results,
    totalInserted: results.reduce((s, r) => s + r.inserted, 0),
    totalDeleted: Number(orphanDeleted.count || 0) + results.reduce((s, r) => s + r.deleted, 0),
  }
}

export async function ensureProgramKnowledge(programId: string, semester?: number | null, minItems = MIN_CONTEXT_KNOWLEDGE_ITEMS) {
  const where: any = { programId }
  if (semester) where.OR = [{ semester: null }, { semester }]
  const books = await db.book.findMany({
    where: { programId, ...(semester ? { OR: [{ semester: null }, { semester }] } : {}) },
    select: { id: true, fileName: true, linkReadStatus: true, link: true },
  })
  const hasReadableBackingSource = books.some((book) =>
    !!book.fileName || ['FILE_EXTRACTED', 'TEXT_EXTRACTED'].includes(String(book.linkReadStatus || ''))
  )
  const effectiveMinItems = books.length <= 1 && !hasReadableBackingSource
    ? Math.min(minItems, METADATA_ITEMS_TARGET)
    : minItems
  const rawCount = await db.bookKnowledgeItem.count({ where })
  const validItems = await getProgramKnowledgeItems(programId, semester, Math.max(40, effectiveMinItems * 4)).catch(() => [])
  if (validItems.length >= effectiveMinItems) return { rebuilt: false, count: validItems.length, rawCount }
  const rebuilt = await rebuildProgramKnowledge(programId, semester)
  return { rebuilt: true, count: rebuilt.totalInserted, rawCount }
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
  return rows.map((r, i) => {
    const summary = cleanText(r.summary, 1600)
    const title = cleanText(safeKnowledgeTitle(r.title, summary, r.category, i), 220)
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
  await ensureProgramKnowledge(programId, semester, MIN_CONTEXT_KNOWLEDGE_ITEMS).catch(() => null)
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
