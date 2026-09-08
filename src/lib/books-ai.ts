import { getZAI, chatWithRetry } from '@/lib/ai'
import { ACADEMY_INFO } from '@/lib/academyData'

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
  // 1) كائن لكل سطر (JSONL)
  const byLine: any[] = []
  for (const line of raw.split('\n')) {
    const obj = tryParseJsonObject(line)
    if (obj) byLine.push(obj)
  }
  if (byLine.length >= 3) return byLine

  // 2) مطابقة أقواس متوازنة لكائنات مستقلة (يتحمّل خلل كائن واحد)
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

/** اقتراح كتب مرجعية لتخصص البرنامج بناءً على واقع التخصص عالمياً */
export async function suggestBooksForProgram(program: {
  titleAr: string
  titleEn?: string | null
  category: string
  description: string
}): Promise<BookSuggestion[]> {
  const zai = await getZAI()
  const level = LEVEL_AR[program.category] || program.category
  const prompt = `أنت خبير ذكاء اصطناعي أكاديمي متخصص في تحليل مناهج الدراسات العليا وواقع التخصصات في العالم.

التخصص المطلوب: "${program.titleAr}" (${program.titleEn || '-'}) — درجة: ${level}
وصف البرنامج: ${program.description.slice(0, 600)}
الأكاديمية: ${ACADEMY_INFO.nameAr} — برامج دراسات عليا مهنية دولية.

المطلوب:
- حلل واقع تخصص "${program.titleAr}" عالمياً اليوم: أبرز المداول المعتمدة في الجامعات المرموقة، المراجع الكلاسيكية الأساسية، أحدث الإصدارات التي تعكس التطورات الحديثة في المجال.
- اقترح 8 كتب (مراجع علمية) يجب على طالب ${level} في هذا التخصص قراءتها ليمتحن بها.
- نوّع بين الكلاسيكيات المرجعية والإصدارات الحديثة، وبين المتوفر بالعربية والإنجليزية.
- اذكر لكل كتاب: العنوان بالعربية، العنوان الأصلي بالإنجليزية، المؤلف، سنة النشر التقريبية، وسبب اختياره لهذا التخصص (سطران كحد أقصى).
- مهم: لكل كتاب أضف رابطاً إلكترونياً واقعياً (link) يتيح الاطلاع أو التحميل أو الشراء — استخدم مصادر حقيقية معروفة فقط مثل:
  - Google Books: https://books.google.com/books?id=... أو صفحة البحث https://books.google.com/books?q=<اسم الكتاب بالإنجليزية>
  - Open Library: https://openlibrary.org/search?q=<العنوان>
  - Archive.org: https://archive.org/search?query=<العنوان>
  - موقع الناشر أو Amazon أو Goodreads أو DOI للمراجع العلمية
  إذا لم تكن متأكداً من رابط مباشر دقيق، استخدم رابط بحث آمن بالصيغة أعلاه — لا تخترع روابط مكسورة.

أجب بصيغة JSON فقط بدون أي نص إضافي — مصفوفة من 8 عناصر:
[{"title":"<العنوان بالعربية>","titleEn":"<العنوان بالإنجليزية>","author":"<المؤلف>","year":"<سنة>","reason":"<سبب الاختيار>","link":"<رابط الكتاب أو رابط بحث عنه>"}]`

  const raw = await chatWithRetry(zai, [
    { role: 'assistant', content: 'أنت خبير أكاديمي يرجع JSON صالحاً فقط دون أي نص إضافي.' },
    { role: 'user', content: prompt },
  ])
  const arr = extractJsonArray(raw)
  return arr
    .filter((b) => b && b.title)
    .slice(0, 10)
    .map((b) => ({
      title: String(b.title).slice(0, 300),
      titleEn: String(b.titleEn || '').slice(0, 300),
      author: String(b.author || '').slice(0, 200),
      year: String(b.year || '').slice(0, 20),
      reason: String(b.reason || '').slice(0, 600),
      link: String(b.link || '').trim().slice(0, 600),
    }))
}

export interface ExamSourceBook {
  title: string
  author?: string | null
  description?: string | null
  textContent?: string | null
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
  program: { titleAr: string; titleEn?: string | null; category: string; description: string },
  books: ExamSourceBook[],
  batchIndex: number
): Promise<GeneratedQuestion[]> {
  const zai = await getZAI()
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

وصف البرنامج: ${program.description.slice(0, 500)}

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

  const raw = await chatWithRetry(zai, [
    { role: 'assistant', content: 'أنت أستاذ امتحانات دراسات عليا يرجع JSON صالحاً فقط دون أي نص إضافي أو تعليقات.' },
    { role: 'user', content: prompt },
  ])
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
  return cleaned
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
