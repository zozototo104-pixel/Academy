import { getZAI, chatWithRetry } from '@/lib/ai'
import { ACADEMY_INFO } from '@/lib/academyData'
import { ensureGeminiKey, geminiCompleteJson } from '@/lib/gemini'

// ===== خبير الذكاء الاصطناعي: اقتراح الكتب وتوليد الامتحانات الشاملة =====

export interface BookSuggestion {
  title: string
  titleEn: string
  author: string
  year: string
  reason: string
  link: string
}

export interface GeneratedQuestion {
  type: 'MCQ' | 'TF' | 'SHORT' | 'ESSAY'
  text: string
  options?: string[]
  correct?: string
  modelAnswer?: string
  points?: number
}

const LEVEL_AR: Record<string, string> = {
  DOCTORATE: 'الدكتوراه المهنية',
  MASTERS: 'الماجستير المهني',
  DIPLOMA: 'الدبلوم المهني المتقدم',
  ACCREDITATION: 'الاعتماد الدولي',
}

function cleanText(value: unknown, max = 1000): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function googleBooksSearch(title: string): string {
  return `https://books.google.com/books?q=${encodeURIComponent(title)}`
}

async function completeJsonWithFallback(args: {
  system: string
  prompt: string
  label: string
  temperature?: number
  maxOutputTokens?: number
  retries?: number
}): Promise<string> {
  const errors: string[] = []

  if (await ensureGeminiKey().catch(() => false)) {
    try {
      return await geminiCompleteJson({
        system: args.system,
        history: [{ role: 'user', text: args.prompt }],
        temperature: args.temperature ?? 0.25,
        maxOutputTokens: args.maxOutputTokens ?? 4096,
      })
    } catch (e: any) {
      const msg = String(e?.message || e).slice(0, 220)
      errors.push(`Gemini: ${msg}`)
      console.error(`${args.label} Gemini failed:`, msg)
    }
  } else {
    errors.push('Gemini: GEMINI_NOT_CONFIGURED')
  }

  try {
    const zai = await getZAI()
    return await chatWithRetry(
      zai,
      [
        { role: 'assistant', content: args.system },
        { role: 'user', content: args.prompt },
      ],
      args.retries ?? 3
    )
  } catch (e: any) {
    const msg = String(e?.message || e).slice(0, 220)
    errors.push(`ZAI: ${msg}`)
    console.error(`${args.label} ZAI failed:`, msg)
  }

  throw new Error(`${args.label} AI failed — ${errors.join(' | ')}`)
}

function extractJsonArray(raw: string): any[] {
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start === -1 || end === -1 || end <= start) return parseLoose(raw)
  try {
    const arr = JSON.parse(raw.slice(start, end + 1))
    return Array.isArray(arr) ? arr : parseLoose(raw)
  } catch {
    return parseLoose(raw)
  }
}

/** إصلاح علامات التنصيص الداخلية غير المهرّبة داخل سطر JSON */
function repairJsonQuotes(s: string): string {
  let out = ''
  let inStr = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (!inStr) {
      if (ch === '"') inStr = true
      out += ch
      continue
    }
    if (ch === '\\') {
      out += ch + (s[i + 1] ?? '')
      i++
      continue
    }
    if (ch === '"') {
      let j = i + 1
      while (j < s.length && /\s/.test(s[j])) j++
      const nxt = s[j]
      if (nxt === ',' || nxt === '}' || nxt === ']' || nxt === ':' || j >= s.length) {
        inStr = false
        out += ch
      } else {
        out += '\\"'
      }
      continue
    }
    out += ch
  }
  return out
}

function tryParseJsonObject(t: string): any | null {
  let s = t.trim().replace(/^\d+[.)\-]\s*/, '').replace(/[،,]\s*$/, '')
  if (!s.startsWith('{')) return null
  try {
    return JSON.parse(s)
  } catch {}
  try {
    return JSON.parse(repairJsonQuotes(s))
  } catch {}
  return null
}

/** استخراج متسامح: مصفوفة كاملة ← سطر بسطر ← مطابقة أقواس كائن-كائن */
function parseLoose(raw: string): any[] {
  const byLine: any[] = []
  for (const line of raw.split('\n')) {
    const obj = tryParseJsonObject(line)
    if (obj) byLine.push(obj)
  }
  if (byLine.length >= 3) return byLine

  const objs: any[] = []
  let depth = 0
  let cur = ''
  let inStr = false
  let esc = false
  for (const ch of raw) {
    if (depth > 0) cur += ch
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') {
      inStr = true
      continue
    }
    if (ch === '{') {
      depth++
      if (depth === 1) cur = ch
    } else if (ch === '}') {
      depth--
      if (depth === 0) {
        const obj = tryParseJsonObject(cur)
        if (obj) objs.push(obj)
        cur = ''
      }
    }
  }
  return objs.length >= byLine.length ? objs : byLine
}

function normalizeSuggestion(b: any): BookSuggestion | null {
  const title = cleanText(b?.title, 300)
  const titleEn = cleanText(b?.titleEn || b?.englishTitle || b?.originalTitle, 300)
  if (!title && !titleEn) return null
  const searchTitle = titleEn || title
  const rawLink = cleanText(b?.link || b?.url, 600)
  const link = /^https?:\/\//i.test(rawLink) ? rawLink : googleBooksSearch(searchTitle)
  return {
    title: title || titleEn,
    titleEn,
    author: cleanText(b?.author, 200) || 'مرجع أكاديمي متخصص',
    year: cleanText(b?.year, 20) || 'حديث/متداول',
    reason: cleanText(b?.reason, 600) || 'مرجع مناسب لبناء خلفية معرفية ومنهجية في التخصص.',
    link,
  }
}

function fallbackBookSuggestions(program: { titleAr: string; titleEn?: string | null; category: string; description?: string | null }): BookSuggestion[] {
  const topic = cleanText(program.titleEn || program.titleAr, 180)
  const level = LEVEL_AR[program.category] || 'الدراسات المهنية'
  const base = [
    ['Research Design: Qualitative, Quantitative, and Mixed Methods Approaches', 'John W. Creswell & J. David Creswell', '2018', 'مرجع منهجي أساسي للبحوث الأكاديمية والمهنية ويخدم إعداد مشروع التخرج.'],
    ['Research Methodology: Methods and Techniques', 'C. R. Kothari', '2004', 'مرجع واضح في تصميم البحث وجمع البيانات وتحليلها.'],
    ['Harvard Business Review Manager’s Handbook', 'Harvard Business Review Press', '2017', 'مرجع تطبيقي شامل في الإدارة والقيادة واتخاذ القرار.'],
    ['Strategic Management: Concepts and Cases', 'Fred R. David & Forest R. David', '2020', 'يعطي الطالب أدوات تحليل استراتيجية قابلة للتطبيق في أغلب البرامج المهنية.'],
    ['Project Management: A Systems Approach to Planning, Scheduling, and Controlling', 'Harold Kerzner', '2022', 'مرجع قوي لإدارة المشاريع والمتابعة والرقابة المؤسسية.'],
    ['Human Resource Management', 'Gary Dessler', '2020', 'مرجع عملي في إدارة الموارد البشرية والسلوك التنظيمي.'],
    ['Quality Management for Organizational Excellence', 'David L. Goetsch & Stanley Davis', '2021', 'مناسب لفهم الجودة والتحسين المستمر وبناء مؤشرات الأداء.'],
    ['The Fifth Discipline: The Art and Practice of the Learning Organization', 'Peter M. Senge', '2006', 'يربط التعلم المؤسسي بالتطوير القيادي والتغيير.'],
  ]

  return base.map(([titleEn, author, year, reason]) => ({
    title: `مرجع في ${program.titleAr}: ${titleEn}`.slice(0, 300),
    titleEn,
    author,
    year,
    reason: `${reason} اختير كاقتراح احتياطي مناسب لمستوى ${level} إلى حين رجوع الذكاء الاصطناعي باقتراحات أكثر تخصصاً في ${topic}.`,
    link: googleBooksSearch(`${titleEn} ${topic}`),
  }))
}

/** اقتراح كتب مرجعية لتخصص البرنامج بناءً على واقع التخصص عالمياً */
export async function suggestBooksForProgram(program: {
  titleAr: string
  titleEn?: string | null
  category: string
  description?: string | null
}): Promise<BookSuggestion[]> {
  const level = LEVEL_AR[program.category] || program.category
  const description = cleanText(program.description, 600)
  const fallback = fallbackBookSuggestions(program)
  const prompt = `أنت خبير ذكاء اصطناعي أكاديمي متخصص في تحليل مناهج الدراسات العليا وواقع التخصصات في العالم.

التخصص المطلوب: "${program.titleAr}" (${program.titleEn || '-'}) — درجة: ${level}
وصف البرنامج: ${description || 'لا يوجد وصف تفصيلي؛ استنتج من اسم البرنامج ومستواه.'}
الأكاديمية: ${ACADEMY_INFO.nameAr} — برامج دراسات عليا مهنية دولية.

المطلوب:
- حلل واقع تخصص "${program.titleAr}" عالمياً اليوم: أبرز المناهج المعتمدة في الجامعات المرموقة، المراجع الكلاسيكية الأساسية، وأحدث الإصدارات التي تعكس التطورات الحديثة في المجال.
- اقترح 8 كتب أو مراجع علمية يجب على طالب ${level} في هذا التخصص قراءتها ليمتحن بها.
- نوّع بين الكلاسيكيات المرجعية والإصدارات الحديثة، وبين المتوفر بالعربية والإنجليزية قدر الإمكان.
- اذكر لكل كتاب: العنوان بالعربية، العنوان الأصلي بالإنجليزية، المؤلف، سنة النشر التقريبية، وسبب اختياره لهذا التخصص في سطرين كحد أقصى.
- لكل كتاب أضف رابطاً واقعياً آمناً. إذا لم تكن متأكداً من رابط مباشر دقيق، استخدم رابط بحث Google Books أو Open Library ولا تخترع رابطاً مكسوراً.

أجب بصيغة JSON فقط بدون أي نص إضافي — مصفوفة من 8 عناصر:
[{"title":"<العنوان بالعربية>","titleEn":"<العنوان بالإنجليزية>","author":"<المؤلف>","year":"<سنة>","reason":"<سبب الاختيار>","link":"<رابط الكتاب أو رابط بحث عنه>"}]`

  try {
    const raw = await completeJsonWithFallback({
      label: 'book suggestions',
      system: 'أنت خبير أكاديمي يرجع JSON صالحاً فقط دون أي نص إضافي.',
      prompt,
      temperature: 0.25,
      maxOutputTokens: 4096,
      retries: 3,
    })
    const cleaned = extractJsonArray(raw)
      .map(normalizeSuggestion)
      .filter(Boolean) as BookSuggestion[]

    const merged = [...cleaned]
    for (const b of fallback) {
      if (merged.length >= 8) break
      if (!merged.some((x) => cleanText(x.titleEn || x.title).toLowerCase() === cleanText(b.titleEn || b.title).toLowerCase())) merged.push(b)
    }
    if (merged.length > 0) return merged.slice(0, 8)
  } catch (e: any) {
    console.error('suggestBooksForProgram fallback used:', String(e?.message || e).slice(0, 500))
  }

  return fallback.slice(0, 8)
}

export interface ExamSourceBook {
  title: string
  titleEn?: string | null
  author?: string | null
  year?: string | null
  description?: string | null
  link?: string | null
  textContent?: string | null
  sourceNote?: string | null
  contentQuality?: string | null
}

const BATCH_SPECS: {
  kind: string
  count: number
  instruction: string
}[] = [
  {
    kind: 'MCQ',
    count: 20,
    instruction:
      'أسئلة اختيار من متعدد (4 خيارات أ-د) تغطي المفاهيم والنظريات والمناهج الأساسية في الكتب المقررة كلها، لكل سؤال إجابة صحيحة واحدة. النقاط: 2 لكل سؤال.',
  },
  {
    kind: 'MIX_TF_MCQ',
    count: 20,
    instruction:
      '15 سؤال صح/خطأ (type: TF، options: ["صح","خطأ"]، correct: "0" للصح و"1" للخطأ، النقاط 2) + 5 أسئلة اختيار من متعدد تطبيقية (type: MCQ، النقاط 2) تقيس الفهم العميق لا الحفظ.',
  },
  {
    kind: 'SHORT_A',
    count: 8,
    instruction:
      'أسئلة إجابة قصيرة تحليلية (type: SHORT، النقاط 5) تطلب شرح مفهوم أو مقارنة أو ذكر خطوات — لكل سؤال إجابة نموذجية وافية (modelAnswer) من 2-4 جمل يصحح عليها الذكاء الاصطناعي.',
  },
  {
    kind: 'SHORT_B',
    count: 7,
    instruction:
      'أسئلة إجابة قصيرة تحليلية إضافية (type: SHORT، النقاط 5) تغطي جوانب الكتب التي لم تغطيها الأسئلة السابقة: أهداف المبادئ، الفروق الدقيقة، شروط التطبيق — لكل سؤال إجابة نموذجية (modelAnswer) من 2-4 جمل.',
  },
  {
    kind: 'ESSAY_A',
    count: 5,
    instruction:
      'أسئلة مقالية معمقة (type: ESSAY، النقاط 10) على مستوى بحثي: تحليل نقدي وربط النظريات بواقع التخصص — لكل سؤال إجابة نموذجية مفصلة (modelAnswer) كمعيار تصحيح في 4-6 جمل.',
  },
  {
    kind: 'ESSAY_B',
    count: 5,
    instruction:
      'أسئلة مقالية معمقة إضافية (type: ESSAY، النقاط 10): تصميم حلول لقضايا التخصص، تقييم منهجيات، صياغة رؤى استشرافية — لكل سؤال إجابة نموذجية مفصلة (modelAnswer) في 4-6 جمل.',
  },
  {
    kind: 'CASE_MCQ',
    count: 15,
    instruction:
      'أسئلة اختيار من متعدد مبنية على حالات عملية ودراسات واقعية من مجال التخصص (type: MCQ، 4 خيارات، النقاط 2): تُعرض حالة قصيرة ثم سؤال عن أفضل قرار/تشخيص/منهجية وفقاً لما ورد في الكتب المقررة.',
  },
]

/** توليد دفعة أسئلة من الكتب المقررة وفق مواصفة الدفعة */
export async function generateExamQuestionBatch(
  program: { titleAr: string; titleEn?: string | null; category: string; description?: string | null },
  books: ExamSourceBook[],
  batchIndex: number
): Promise<GeneratedQuestion[]> {
  const spec = BATCH_SPECS[batchIndex % BATCH_SPECS.length]
  const level = LEVEL_AR[program.category] || 'الدراسات العليا'

  const booksSection = books
    .map((b, i) => {
      const excerpt = (b.textContent || '').slice(0, 2500)
      return `كتاب ${i + 1}: «${b.title}» ${b.author ? `— ${b.author}` : ''}
${b.description ? `نبذة: ${b.description.slice(0, 300)}\n` : ''}${excerpt ? `مقتطف من محتوى الكتاب:\n${excerpt}\n` : ''}`
    })
    .join('\n\n')

  const prompt = `أنت خبير ذكاء اصطناعي يمتحن طلاب ${level} في تخصص "${program.titleAr}" (${program.titleEn || '-'}) في ${ACADEMY_INFO.nameAr}.
قرأت الكتب المقررة التالية كاملة وحللتها، وستبني أسئلة الامتحان عليها حصرياً:

${booksSection}

وصف البرنامج: ${cleanText(program.description, 500) || 'غير مذكور'}

الدفعة المطلوبة (${spec.count} سؤالاً):
${spec.instruction}

شروط صارمة:
- مستوى الأسئلة: ${level} — تحليلي وتطبيقي وليس حفظاً سطحياً
- الأسئلة مستمدة من مفاهيم الكتب المقررة أعلاه وحقيقة مجال التخصص عالمياً
- صياغة عربية فصحى واضحة ودقيقة علمياً
- لا تكرر سؤالاً أو فكرة سؤال مرتين
- كل سؤال MCQ له options مصفوفة 4 نصوص و correct رقم الخيار الصحيح كنص "0"-"3"
- كل سؤال TF له options ["صح","خطأ"] و correct "0" أو "1"
- كل سؤال SHORT/ESSAY له modelAnswer (الإجابة النموذجية للتصحيح الآلي)
- points رقماً كما هو محدد في المواصفة
- مهم جداً: أرسل كل سؤال في سطر مستقل — كائن JSON واحد لكل سطر داخل مصفوفة، ولا تستخدم علامة تنصيص " داخل نص السؤال أو الخيارات أو الإجابة النموذجية (استخدم «» بدلاً منها)

أجب بصيغة JSON فقط — مصفوفة من ${spec.count} أسئلة:
[{"type":"MCQ","text":"...","options":["أ","ب","ج","د"],"correct":"0","points":2}]`

  let raw = ''
  try {
    raw = await completeJsonWithFallback({
      label: `exam question batch ${batchIndex + 1}`,
      system: 'أنت أستاذ امتحانات دراسات عليا يرجع JSON صالحاً فقط دون أي نص إضافي أو تعليقات.',
      prompt,
      temperature: 0.25,
      maxOutputTokens: 8192,
      retries: 3,
    })
  } catch (e: any) {
    console.error('generateExamQuestionBatch failed:', String(e?.message || e).slice(0, 600))
    return []
  }

  let arr: any[] = []
  try {
    arr = extractJsonArray(raw)
  } catch {
    arr = parseLoose(raw)
  }

  const cleaned: GeneratedQuestion[] = []
  for (const q of arr) {
    const type = String(q.type || '').toUpperCase()
    const text = String(q.text || '').trim()
    if (!text) continue
    if (type === 'MCQ' || type === 'TF') {
      const options = Array.isArray(q.options) ? q.options.map((o: any) => String(o)).slice(0, 6) : null
      const correct = String(q.correct ?? '')
      if (!options || options.length < 2 || correct === '' || Number.isNaN(Number(correct))) continue
      cleaned.push({ type, text: text.slice(0, 2000), options, correct, points: Number(q.points) || 2 })
    } else if (type === 'SHORT' || type === 'ESSAY') {
      const modelAnswer = String(q.modelAnswer || q.correct || '').trim()
      if (!modelAnswer) continue
      cleaned.push({
        type,
        text: text.slice(0, 2000),
        modelAnswer: modelAnswer.slice(0, 3000),
        points: Number(q.points) || (type === 'ESSAY' ? 10 : 5),
      })
    }
  }
  return cleaned.slice(0, spec.count)
}

export const EXAM_BATCH_COUNT = BATCH_SPECS.length
export const EXAM_BATCH_SPECS = BATCH_SPECS

/** وصف عربي لنوع السؤال */
export const QTYPE_AR: Record<string, string> = {
  MCQ: 'اختيار من متعدد',
  TF: 'صح أو خطأ',
  SHORT: 'إجابة قصيرة',
  ESSAY: 'سؤال مقالي',
}
