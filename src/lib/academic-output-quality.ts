// حارس جودة مركزي لكل مخرجات الذكاء الأكاديمية.
// الهدف: منع تسرب OCR مشوّه، أسماء حقول داخلية، ترجمات آلية مكسورة، أو خليط لغات غير صالح للطالب.

export function normalizeAcademic(value: unknown): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[ًٌٍَُِّْـ]/g, '')
    .replace(/[إأآا]/g, 'ا')
    .replace(/[ىي]/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export interface OcrWordRepair {
  before: string
  after: string
  context: string
}

export interface OcrWordRepairResult {
  text: string
  replacements: number
  changes: OcrWordRepair[]
}

// إصلاحات OCR عربية شائعة على مستوى الكلمة المستقلة فقط — القائمة نفسها
// التي يستخدمها cleanAcademicOutput. تُستخدم وحدها لإصلاح نص مقطع كتاب
// دون حذف أي بادئة أو علامة أو اقتطاع أي حرف: نص المقطع نص كتاب، لا
// مخرجات ذكاء، فلا يصح أن يمر على تنظيف مخرجات الذكاء كاملاً.
const KNOWN_OCR_WORD_REPAIRS: Array<{ pattern: RegExp; word: string; fix: string }> = [
  { pattern: /(^|[^\p{L}\p{N}])ويف(?=$|[^\p{L}\p{N}])/gu, word: 'ويف', fix: 'وفي' },
  { pattern: /(^|[^\p{L}\p{N}])يف(?=$|[^\p{L}\p{N}])/gu, word: 'يف', fix: 'في' },
  { pattern: /(^|[^\p{L}\p{N}])الثاين(?=$|[^\p{L}\p{N}])/gu, word: 'الثاين', fix: 'الثاني' },
  { pattern: /(^|[^\p{L}\p{N}])اختاذ(?=$|[^\p{L}\p{N}])/gu, word: 'اختاذ', fix: 'اتخاذ' },
  { pattern: /(^|[^\p{L}\p{N}])اختاد(?=$|[^\p{L}\p{N}])/gu, word: 'اختاد', fix: 'اتخاذ' },
  { pattern: /(^|[^\p{L}\p{N}])القررا(?=$|[^\p{L}\p{N}])/gu, word: 'القررا', fix: 'القرار' },
  { pattern: /(^|[^\p{L}\p{N}])القرا(?=$|[^\p{L}\p{N}])/gu, word: 'القرا', fix: 'القرار' },
  { pattern: /(^|[^\p{L}\p{N}])مبعن(?=$|[^\p{L}\p{N}])/gu, word: 'مبعن', fix: 'بمعنى' },
  { pattern: /(^|[^\p{L}\p{N}])املوضوعية(?=$|[^\p{L}\p{N}])/gu, word: 'املوضوعية', fix: 'الموضوعية' },
  { pattern: /(^|[^\p{L}\p{N}])املوضوعيه(?=$|[^\p{L}\p{N}])/gu, word: 'املوضوعيه', fix: 'الموضوعية' },
  { pattern: /(^|[^\p{L}\p{N}])املبادي(?=$|[^\p{L}\p{N}])/gu, word: 'املبادي', fix: 'المبادئ' },
  { pattern: /(^|[^\p{L}\p{N}])املكتسب(?=$|[^\p{L}\p{N}])/gu, word: 'املكتسب', fix: 'المكتسب' },
  { pattern: /(^|[^\p{L}\p{N}])االستراتيجية(?=$|[^\p{L}\p{N}])/gu, word: 'االستراتيجية', fix: 'الاستراتيجية' },
  { pattern: /(^|[^\p{L}\p{N}])االستراتيجيه(?=$|[^\p{L}\p{N}])/gu, word: 'االستراتيجيه', fix: 'الاستراتيجية' },
  { pattern: /(^|[^\p{L}\p{N}])الاستراتيجيه(?=$|[^\p{L}\p{N}])/gu, word: 'الاستراتيجيه', fix: 'الاستراتيجية' },
  { pattern: /(^|[^\p{L}\p{N}])الإستراتيجيه(?=$|[^\p{L}\p{N}])/gu, word: 'الإستراتيجيه', fix: 'الإستراتيجية' },
  { pattern: /(^|[^\p{L}\p{N}])المدرسه(?=$|[^\p{L}\p{N}])/gu, word: 'المدرسه', fix: 'المدرسة' },
  { pattern: /(^|[^\p{L}\p{N}])سلسله(?=$|[^\p{L}\p{N}])/gu, word: 'سلسله', fix: 'سلسلة' },
  { pattern: /(^|[^\p{L}\p{N}])متتابعه(?=$|[^\p{L}\p{N}])/gu, word: 'متتابعه', fix: 'متتابعة' },
  { pattern: /(^|[^\p{L}\p{N}])متكامله(?=$|[^\p{L}\p{N}])/gu, word: 'متكامله', fix: 'متكاملة' },
  { pattern: /(^|[^\p{L}\p{N}])حاله(?=$|[^\p{L}\p{N}])/gu, word: 'حاله', fix: 'حالة' },
  { pattern: /(^|[^\p{L}\p{N}])تكتيكيه(?=$|[^\p{L}\p{N}])/gu, word: 'تكتيكيه', fix: 'تكتيكية' },
]

const MAX_OCR_REPAIR_CHANGES = 20

export function repairKnownOcrWords(value: unknown): OcrWordRepairResult {
  let text = String(value || '')
  const changes: OcrWordRepair[] = []
  let replacements = 0
  for (const { pattern, word, fix } of KNOWN_OCR_WORD_REPAIRS) {
    pattern.lastIndex = 0
    text = text.replace(pattern, (match: string, prefix: string, offset: number, whole: string) => {
      replacements += 1
      if (changes.length < MAX_OCR_REPAIR_CHANGES) {
        const start = Math.max(0, offset - 50)
        const end = Math.min(whole.length, offset + match.length + 50)
        changes.push({ before: word, after: fix, context: whole.slice(start, end) })
      }
      return `${prefix}${fix}`
    })
  }
  return { text, replacements, changes }
}

export function cleanAcademicOutput(value: unknown, max = 1800): string {
  const stripped = String(value || '')
    .replace(/\u0000/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/\[([^\]\n]{1,120})\]\([^\)\n]{1,500}\)/g, '$1')
    .replace(/[«"]?\s*\*\*([^*\n]{2,160})\*\*\s*[»"]?/g, '$1')
    .replace(/[`*_~>#]+/g, ' ')
    .replace(/^\s*(?:[-–—•]+\s*)?(?:مفهوم|تعريف|خلاصة|ملخص|مصطلح|بذرة\s+سؤال|سؤال|نظرية\s+أو\s+إطار|نظرية|إطار|منهجية|طريقة|حالة\s+تطبيقية)\s*(?:من\s+النص|مستخرجة\s+من\s+النص|مستخرج\s+من\s+النص|من\s+الكتاب|مستخرجة\s+من\s+الكتاب|مستخرج\s+من\s+الكتاب)?\s*[:：\-–—]+\s*/giu, ' ')
    .replace(/\b\d{1,5}\s+of\s+\d{1,5}\b/gi, ' ')
    .replace(/\bpage\s+\d{1,5}\s+(?:of|\/|من)\s+\d{1,5}\b/gi, ' ')
    .replace(/\bصفحة\s+\d{1,5}\s+(?:من|\/|of)\s+\d{1,5}\b/gi, ' ')
    .replace(/\[\s*(?:CONCEPT|THEORY|METHOD|CASE|DEFINITION|QUESTION_SEED|SUMMARY)\s*(?:\|[^\]]*)?\]/gi, ' ')
    .replace(/\b(?:CONCEPT|THEORY|METHOD|CASE|DEFINITION|QUESTION_SEED|SUMMARY)\b\s*(?:\|\s*(?:أهمية|اهمية)\s*\d{1,3})?/gi, ' ')
    .replace(/(?:^|[\n\s.؛،-])(?:محور\s+معرفي\s+مهم|الفكرة|خلاصة\s+أكاديمية|خلاصة\s+اكاديمية|مقتطف\s+داعم|دليل\s+من\s+المحتوى|دليل\s+من\s+المحتوي|كلمات\s+مفتاحية|مصطلحات\s+مرتبطة|مصدر\s+القراءة|جودة\s+المحتوى|جودة\s+المحتوي)\s*[:：]\s*/giu, ' ');
  // إصلاحات OCR عربية شائعة قبل الحكم على جودة النص؛ الهدف ليس إخفاء الخلل بل إنقاذ النص الصحيح قبل التوليد.
  return repairKnownOcrWords(stripped).text
    .replace(/\bStrategic\s+Paradigm\b/gi, 'النموذج الذهني الاستراتيجي')
    .replace(/\bLogistics\b/gi, 'اللوجستيات')
    .replace(/\bTactics\b/gi, 'التكتيك')
    .replace(/(^|[^\p{L}\p{N}])اللوجستيك(?=$|[^\p{L}\p{N}])/gu, '$1اللوجستيات')
    .replace(/(^|[^\p{L}\p{N}])البرادايم\s+الإستراتيجي(?=$|[^\p{L}\p{N}])/gu, '$1النموذج الذهني الاستراتيجي')
    .replace(/(^|[^\p{L}\p{N}])البرادايم\s+الاستراتيجي(?=$|[^\p{L}\p{N}])/gu, '$1النموذج الذهني الاستراتيجي')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s+([،؛؟.!])/g, '$1')
    .replace(/([،؛؟.!]){2,}/g, '$1')
    .trim()
    .slice(0, max)
}

const LABEL_STOP_WORDS = new Set([
  'هذا', 'هذه', 'ذلك', 'الذي', 'التي', 'على', 'الى', 'إلى', 'في', 'من', 'عن', 'مع', 'داخل', 'ضمن', 'بين',
  'كتاب', 'الكتاب', 'النص', 'المقطع', 'الدليل', 'المحتوى', 'المحتوي', 'البرنامج', 'الفصل', 'المحور', 'محور',
  'يمكن', 'يجب', 'يعرض', 'يعالج', 'يوضح', 'يركز', 'يوجه', 'يبين', 'يحوّل', 'يحول', 'تحويل', 'مستخرجة', 'مستخرج',
  'حالة', 'تطبيقية', 'منهجية', 'نظرية', 'إطار', 'تعريف', 'مفهوم', 'خلاصة', 'سؤال', 'بذرة',
  'مصطلحات', 'تعريفات', 'نظريات', 'أطر', 'مفاهيم', 'منهجيات', 'حالات', 'أسئلة', 'اسئلة', 'محاور',
].map(normalizeAcademic))

function compactLabel(value: string, max: number) {
  const compacted = value
    .replace(/\([^)]{1,90}\)/g, ' ')
    .replace(/^[\s\-–—•:："'«»]+|[\s\-–—•:："'«»]+$/g, ' ')
    .replace(/^(?:و?هو|و?هي|و?ذلك|إذ|اذ|حيث|وقد|كما|لذلك|وبذلك|إن|ان|أن|أنّ)\s+/u, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return compacted.length <= max ? compacted : compacted.slice(0, max).replace(/\s+\S*$/u, '').trim()
}

function isGenericLabelPhrase(value: string): boolean {
  const n = normalizeAcademic(value)
  const words = n.split(' ').filter(Boolean)
  if (!n) return true
  // المصطلح/عنوان المحور يجب أن يكون اسماً دلالياً، لا جملة فعلية أو بقايا تعليمات داخلية.
  if (/(?:النص|المقطع|الدليل المقروء|حاله تطبيقيه|حالة تطبيقية|مستخرجه|مستخرج|بلغه اكاديميه|بلغة أكاديمية|الدليل المقروء)/u.test(n)) return true
  if (/^(?:يحول|يعرض|ينظم|شرح|يربط|ربط|يدرس|يستخدم|يركز|يوضح|يقدم|تحويل|يوظف|يصوغ|يشرح|تاثيره|تاثيرها)(?:\s|$)/u.test(n)) return true
  if (/^حاله\s+و?تطبيقيه$/u.test(n)) return true
  if (/[A-Za-z]{4,}/.test(value) && /[\u0600-\u06FF]/.test(value)) return true
  if (/(?:strategicg|strategicq|logisticg|tacticg)/i.test(value)) return true
  if (words.length <= 3 && /^(?:محور|محاور|مصطلحات|تعريفات|نظريات|اطر|مفاهيم|منهجيات|حالات|اسئله|اسيله|خلاصه|المصطلحات|التعريفات|النظريات|الاطر|المفاهيم|المنهجيات|الحالات|الاسئله|الاسيله|الخلاصه)/u.test(n)) return true
  return [
    'المصطلحات والتعريفات', 'النظريات والاطر', 'منهجيات التطبيق', 'الحالات العمليه',
    'اسئله المراجعه', 'المفاهيم المركزيه', 'الخلاصه الدراسيه', 'محور دراسي', 'محور اكاديمي',
    'سلسله متتابعه متكامله', 'سلسله متتابعه', 'النص والبرادايم', 'المعرفه والامتحان الشامله',
  ].includes(n)
}

export function conciseAcademicLabel(value: unknown, fallback = 'محور أكاديمي', max = 80): string {
  const cleaned = cleanAcademicOutput(value, Math.max(260, max * 3))
  if (!cleaned) return cleanAcademicOutput(fallback, max)

  const first = cleaned.split(/[.!؟؛\n]/u).find((part) => cleanAcademicOutput(part, 220).length >= 6) || cleaned
  const beforeColon = first.split(/[:：]/u)[0]
  const candidates = [beforeColon, first]
  for (const candidate of candidates) {
    const phrase = compactLabel(cleanAcademicOutput(candidate, 150), max)
    const words = phrase.split(/\s+/).filter(Boolean)
    if (words.length >= 2 && words.length <= 8 && phrase.length >= 6 && !isGenericLabelPhrase(phrase) && !looksLikeBrokenGeneratedArabic(phrase)) return phrase
  }

  const seen = new Set<string>()
  const tokens: string[] = []
  for (const token of normalizeAcademic(cleaned).split(' ')) {
    const bare = token.replace(/^و/u, '')
    if (bare.length < 4 || /^\d+$/.test(bare) || LABEL_STOP_WORDS.has(token) || LABEL_STOP_WORDS.has(bare) || seen.has(bare)) continue
    seen.add(bare)
    tokens.push(bare)
    if (tokens.length >= 4) break
  }
  const fromTokens = compactLabel(tokens.join(' '), max)
  if (fromTokens.length >= 6 && !isGenericLabelPhrase(fromTokens) && !looksLikeBrokenGeneratedArabic(fromTokens)) return fromTokens
  return cleanAcademicOutput(fallback, max)
}

export function sanitizeAcademicLabelList(values: unknown, fallback: string[] = [], maxItems = 12, maxChars = 80): string[] {
  const raw = Array.isArray(values) ? values : []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of [...raw, ...fallback]) {
    const label = conciseAcademicLabel(item, '', maxChars)
    const key = normalizeAcademic(label)
    if (!key || seen.has(key) || looksLikeBrokenGeneratedArabic(label)) continue
    seen.add(key)
    out.push(label)
    if (out.length >= maxItems) break
  }
  return out
}

function countMatches(value: string, re: RegExp): number {
  return (value.match(re) || []).length
}

function words(value: string): string[] {
  return String(value || '').split(/\s+/).map((w) => w.trim()).filter(Boolean)
}

export function looksLikeBrokenGeneratedArabic(value: unknown): boolean {
  const raw = cleanAcademicOutput(value, 5000)
  if (!raw) return true
  const n = normalizeAcademic(raw)
  const chars = raw.replace(/\s/g, '')
  const letters = countMatches(raw, /[\p{L}]/gu)
  const digits = countMatches(raw, /\d/g)
  const arabicLetters = countMatches(raw, /[\u0600-\u06FF]/g)
  const latinLetters = countMatches(raw, /[A-Za-zÀ-ÖØ-öø-ÿ]/g)
  const ws = words(raw)
  const arabicWords = ws.filter((w) => /[\u0600-\u06FF]/.test(w)).length
  const latinWords = ws.filter((w) => /[A-Za-zÀ-ÖØ-öø-ÿ]/.test(w)).length

  if (letters < 12) return true
  if (chars.length > 30 && letters / Math.max(1, chars.length) < 0.48) return true
  if (digits >= 6 && letters < 45) return true

  // عبارات داخلية أو روابط لا يجوز أن تظهر للطالب أو في بنك المعرفة.
  const forbidden = [
    'محور معرفي مهم', 'حاله تطبيقيه من النص', 'حالة تطبيقية من النص', 'منهجيه مستخرجه من النص', 'منهجية مستخرجة من النص',
    'نظريه او اطار من النص', 'نظرية أو إطار من النص', 'تعريف من النص', 'بذره سؤال من النص', 'بذرة سؤال من النص',
    'دليل من المحتوي', 'دليل من المحتوى', 'خلاصه اكاديميه', 'خلاصة اكاديمية',
    'مقتطف داعم', 'مصطلحات مرتبطه', 'كلمات مفتاحيه', 'مصدر القراءه', 'جوده المحتوي', 'رابط الكتاب',
    'يحول هذا العنصر', 'يحوّل هذا العنصر', 'يعرض هذا العنصر', 'خلاصه محوريه من النص', 'خلاصة محورية من النص',
    'الدليل المقروء', 'شرح بلغه اكاديميه واضحه', 'ربط بحاله مهنيه',
    'google com search', 'books google', 'tbm bks', 'لم يظهر فيه نص', 'رابط مفتوح لكن لم يظهر',
    'بنك المعرفه الاكاديمي المستخرج', 'اي عباره تفسر بصوره ادق دلاله', 'كيف يمكن فهم فكره', 'كيف يمكن تطبيق فكره',
    'وفق المقطع الاتي', 'يعرض الكتاب المقطع الاتي', 'بالاعتماد علي الدليل النصي', 'يمكن تحويل المقطع', 'يجوز تعميم المقطع', 'قراءه المقطع',
    'اي استنتاج مهني هو الادق', 'يعالج الكتاب الفكره الاتيه', 'عند تحويله الي حاله مهنيه', 'امام مدير يعمل', 'موقف مستمد من الكتاب',
    'libro de la guerra', 'tratado de la perfeccion', 'tratado de la perfección', 'lehrsätze', 'lehrs atze',
    'vellena', 'bonapert', 'بونابرت رجاء الكتاب', 'كتاب الثاين', 'عام 8121', 'عام 8115', 'عام 8518',
    'انظر كتاب', 'صادر بالفرنسية', 'صادر بالانجليزية', 'صادر بالإنجليزية',
  ]
  if (forbidden.some((x) => n.includes(normalizeAcademic(x)))) return true

  // أرقام سنوات مستحيلة غالباً تنتج من OCR مقلوب مثل 8121 بدلاً من 1821 أو 8115 بدلاً من 1518.
  if (/(?:عام|سنة|سنه|حوالي|around|year)\s*(?:[3-9]\d{3}|\d{5,})/iu.test(raw)) return true
  if (/\b(?:8[0-9]{3}|9[0-9]{3})\b/.test(raw) && /(كتاب|كتب|الفكر|الاستراتيجي|الحرب|العسكري)/u.test(raw)) return true

  // خليط OCR/ترجمة: كلمات لاتينية كثيرة داخل جملة عربية قصيرة، خصوصاً أسماء كتب أجنبية تسرّبت كأنها مفهوم.
  const noisyLatinNames = /(libro\s+de\s+la|tratado\s+de|perfecci[oó]n|vellena|lehrs[aä]tze|krieg(?:es)?|guerra|alfonso\s+hernandez)/i
  if (noisyLatinNames.test(raw) && arabicWords >= 4) return true
  if (latinWords >= 4 && arabicWords >= 4 && raw.length < 800 && /(?:\bde\b|\bdel\b|\bund\b|\boder\b|\breine\b|\bmit\b|\bthe\b)/i.test(raw)) return true

  // مؤشرات ترجمات مكسورة متكررة ظهرت من OCR.
  // Substring fragments ending in «يف» or starting with «فيه» are gone on purpose:
  // cleaning already repairs a standalone «يف»/«ويف» to «في»/«وفي» before this
  // check runs, so such a fragment can only match a valid verb such as «يضيف»
  // or a valid phrase such as «فيه قراءة». A surviving standalone token is
  // still caught by the token check below.
  const brokenFragments = [
    'كتاب اطلب', 'كتاب احرب', 'في اسبانيا مع كتاب', 'اهنا', 'إهنا', 'مستحيله وان الثانيه ال',
    'هو يفتترض', 'يفترض اجتزال ان الاول', 'وان الثانيه ال', 'هذا المنهج منذ زمن بعيد حيث ظهر',
    'استخدم هذا المنهج منذ زمن بعيد حيث ظهر', 'بدات الاعلان عن نفسه', 'السيما عند موسسي الفكر',
    'الاستراتيجي ال عسكري', 'مع كتاب اطلب', 'مع كتاب احرب', 'كتاب حرب هو', 'ويف', 'الثاين',
    'مسو وتفوق', 'صوت الى استراتيجية', 'صوت الي استراتيجية', 'صوت الى استراتيجيه', 'صوت الي استراتيجيه',
    'اختاذ القرار', 'اختاد القرار', 'القررا', 'مبعن اخر',
  ]
  if (brokenFragments.some((x) => n.includes(normalizeAcademic(x)))) return true

  const normalizedTokens = n.split(' ')
  const weirdTokenCount = normalizedTokens.filter((t) => ['يف', 'الثاين', 'ويف', 'اختاذ', 'اختاد', 'القررا', 'مبعن', 'املوضوعيه', 'املوضوعية', 'القرا', 'املبادي', 'االستراتيجيه', 'املكتسب'].includes(t)).length
  if (weirdTokenCount >= 1 && arabicWords >= 8) return true
  // OCR fragments must be standalone tokens. Searching for 'يف ' also matches
  // the ending of valid verbs such as «يضيف». «فيه» is a normal Arabic word
  // and must never trigger this broad OCR heuristic by itself.
  if (normalizedTokens.some((token) => ['يف', 'ويف'].includes(token)) && /(القرار|الاداره|المهني|الاستراتيجي|المشروع|الكتاب|المحتوي|المحتوى|القراءه|القراءة)/u.test(n)) return true

  // تكرار عالٍ أو كلمات قصيرة جداً يدل على تشوه OCR.
  const veryShort = ws.filter((w) => w.length <= 2).length
  if (ws.length >= 18 && veryShort / ws.length > 0.45) return true

  return false
}

export type KnowledgeItemCleanupPlan =
  | { action: 'KEEP' }
  | { action: 'DELETE_EMPTY' }
  | { action: 'REVIEW'; reason: 'UNRESOLVED' }
  | { action: 'UPDATE'; data: { title: string; summary: string; excerpt: string | null } }

// Never delete a book-derived knowledge item merely because a heuristic rejects
// it. Repair every text field first, and only persist if ALL fields pass.
// Unresolved rows keep their original text, source IDs and guide references.
export function planKnowledgeItemCleanup(
  row: { title: string; summary: string; excerpt?: string | null },
  isBroken: (text: string) => boolean = looksLikeBrokenGeneratedArabic,
): KnowledgeItemCleanupPlan {
  const fullClean = (value: string) => cleanAcademicOutput(value, Math.max(1800, value.length + 128))
  const title = fullClean(row.title || '')
  const summary = fullClean(row.summary || '')
  const excerpt = row.excerpt == null ? null : fullClean(row.excerpt)
  // Only truly empty stored fields may be deleted. Markup or damaged text
  // that becomes blank after cleaning still counts as original user data.
  if (![row.title, row.summary, row.excerpt].some((value) => String(value || '').trim())) return { action: 'DELETE_EMPTY' }
  // Never commit a partial repair: if ANY field remains empty/corrupted,
  // leave all original fields and reference identifiers untouched.
  if (!title || !summary || (row.excerpt && !excerpt)
    || isBroken(`${title}. ${summary}`) || (excerpt && isBroken(excerpt))) {
    return { action: 'REVIEW', reason: 'UNRESOLVED' }
  }
  if (title !== row.title || summary !== row.summary || excerpt !== (row.excerpt ?? null)) {
    return { action: 'UPDATE', data: { title, summary, excerpt } }
  }
  return { action: 'KEEP' }
}

// AI repairs are accepted only when they are complete, academically readable,
// and explicitly anchored to an exact excerpt from the same source chunk.
// No guessed citation, metadata, category, IDs or new item may be written.
export function validateGroundedKnowledgeRepair(
  value: unknown,
  sourceText: string,
): { title: string; summary: string; excerpt: string } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  if (typeof input.title !== 'string' || typeof input.summary !== 'string' || typeof input.excerpt !== 'string') return null
  const title = input.title.trim()
  const summary = input.summary.trim()
  const excerpt = input.excerpt.trim()
  if (title.length < 10 || title.length > 160 || summary.length < 55 || summary.length > 1800 || excerpt.length < 35 || excerpt.length > 1000) return null
  if (cleanAcademicOutput(title, 1800) !== title || cleanAcademicOutput(summary, 2000) !== summary || cleanAcademicOutput(excerpt, 1200) !== excerpt) return null
  if (planKnowledgeItemCleanup({ title, summary, excerpt }).action !== 'KEEP') return null

  // No lexical-similarity heuristic can prove a model's summary is truthful:
  // it can add an invented causal claim using the same vocabulary.
  // For automatic acceptance, each field MUST be an exact contiguous span
  // from a readable source. Paraphrases belong in human review, not auto-save.
  const whitespace = (s: string) => s.replace(/\s+/g, ' ').trim()
  const source = whitespace(sourceText)
  if (looksLikeBrokenGeneratedArabic(source)) return null
  if (![title, summary, excerpt].every((field) => source.includes(whitespace(field)))) return null
  return { title, summary, excerpt }
}

export function acceptableAcademicText(value: unknown, opts?: { min?: number; maxLatinRatio?: number }): boolean {
  const raw = cleanAcademicOutput(value, 5000)
  const min = opts?.min ?? 20
  if (raw.length < min) return false
  if (looksLikeBrokenGeneratedArabic(raw)) return false
  const latin = countMatches(raw, /[A-Za-zÀ-ÖØ-öø-ÿ]/g)
  const arabic = countMatches(raw, /[\u0600-\u06FF]/g)
  const maxLatinRatio = opts?.maxLatinRatio ?? 0.38
  if (arabic >= 20 && latin / Math.max(1, latin + arabic) > maxLatinRatio) return false
  return true
}

export function cleanOrFallback(value: unknown, fallback: string, max = 1800, min = 18): string {
  const cleaned = cleanAcademicOutput(value, max)
  if (cleaned.length >= min && !looksLikeBrokenGeneratedArabic(cleaned)) return cleaned
  return cleanAcademicOutput(fallback, max)
}

export function sanitizeAcademicList(values: unknown, fallback: string[] = [], maxItems = 10, maxChars = 180): string[] {
  const raw = Array.isArray(values) ? values : []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of raw) {
    const cleaned = cleanAcademicOutput(item, maxChars)
    const key = normalizeAcademic(cleaned)
    if (!key || seen.has(key) || looksLikeBrokenGeneratedArabic(cleaned)) continue
    seen.add(key)
    out.push(cleaned)
    if (out.length >= maxItems) break
  }
  for (const item of fallback) {
    const cleaned = cleanAcademicOutput(item, maxChars)
    const key = normalizeAcademic(cleaned)
    if (!key || seen.has(key) || looksLikeBrokenGeneratedArabic(cleaned)) continue
    seen.add(key)
    out.push(cleaned)
    if (out.length >= maxItems) break
  }
  return out
}
