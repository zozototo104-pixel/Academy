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

export function cleanAcademicOutput(value: unknown, max = 1800): string {
  return String(value || '')
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
    .replace(/(?:^|[\n\s.؛،-])(?:محور\s+معرفي\s+مهم|الفكرة|خلاصة\s+أكاديمية|خلاصة\s+اكاديمية|مقتطف\s+داعم|دليل\s+من\s+المحتوى|دليل\s+من\s+المحتوي|كلمات\s+مفتاحية|مصطلحات\s+مرتبطة|مصدر\s+القراءة|جودة\s+المحتوى|جودة\s+المحتوي)\s*[:：]\s*/giu, ' ')
    // إصلاحات OCR عربية شائعة قبل الحكم على جودة النص؛ الهدف ليس إخفاء الخلل بل إنقاذ النص الصحيح قبل التوليد.
    .replace(/(^|[^\p{L}\p{N}])ويف(?=$|[^\p{L}\p{N}])/gu, '$1وفي')
    .replace(/(^|[^\p{L}\p{N}])يف(?=$|[^\p{L}\p{N}])/gu, '$1في')
    .replace(/(^|[^\p{L}\p{N}])الثاين(?=$|[^\p{L}\p{N}])/gu, '$1الثاني')
    .replace(/(^|[^\p{L}\p{N}])اختاذ(?=$|[^\p{L}\p{N}])/gu, '$1اتخاذ')
    .replace(/(^|[^\p{L}\p{N}])اختاد(?=$|[^\p{L}\p{N}])/gu, '$1اتخاذ')
    .replace(/(^|[^\p{L}\p{N}])القررا(?=$|[^\p{L}\p{N}])/gu, '$1القرار')
    .replace(/(^|[^\p{L}\p{N}])القرا(?=$|[^\p{L}\p{N}])/gu, '$1القرار')
    .replace(/(^|[^\p{L}\p{N}])مبعن(?=$|[^\p{L}\p{N}])/gu, '$1بمعنى')
    .replace(/(^|[^\p{L}\p{N}])املوضوعية(?=$|[^\p{L}\p{N}])/gu, '$1الموضوعية')
    .replace(/(^|[^\p{L}\p{N}])املوضوعيه(?=$|[^\p{L}\p{N}])/gu, '$1الموضوعية')
    .replace(/(^|[^\p{L}\p{N}])املبادي(?=$|[^\p{L}\p{N}])/gu, '$1المبادئ')
    .replace(/(^|[^\p{L}\p{N}])املكتسب(?=$|[^\p{L}\p{N}])/gu, '$1المكتسب')
    .replace(/(^|[^\p{L}\p{N}])االستراتيجية(?=$|[^\p{L}\p{N}])/gu, '$1الاستراتيجية')
    .replace(/(^|[^\p{L}\p{N}])االستراتيجيه(?=$|[^\p{L}\p{N}])/gu, '$1الاستراتيجية')
    .replace(/(^|[^\p{L}\p{N}])الاستراتيجيه(?=$|[^\p{L}\p{N}])/gu, '$1الاستراتيجية')
    .replace(/(^|[^\p{L}\p{N}])الإستراتيجيه(?=$|[^\p{L}\p{N}])/gu, '$1الإستراتيجية')
    .replace(/(^|[^\p{L}\p{N}])المدرسه(?=$|[^\p{L}\p{N}])/gu, '$1المدرسة')
    .replace(/(^|[^\p{L}\p{N}])سلسله(?=$|[^\p{L}\p{N}])/gu, '$1سلسلة')
    .replace(/(^|[^\p{L}\p{N}])متتابعه(?=$|[^\p{L}\p{N}])/gu, '$1متتابعة')
    .replace(/(^|[^\p{L}\p{N}])متكامله(?=$|[^\p{L}\p{N}])/gu, '$1متكاملة')
    .replace(/(^|[^\p{L}\p{N}])حاله(?=$|[^\p{L}\p{N}])/gu, '$1حالة')
    .replace(/(^|[^\p{L}\p{N}])تكتيكيه(?=$|[^\p{L}\p{N}])/gu, '$1تكتيكية')
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
    'vellena', 'bonapert', 'بونابرت رجاء الكتاب', 'كتاب الثاين', 'الكتاب ويف', 'عام 8121', 'عام 8115', 'عام 8518',
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
  const brokenFragments = [
    'كتاب اطلب', 'كتاب احرب', 'يف اسبانيا', 'في اسبانيا مع كتاب', 'اهنا', 'إهنا', 'مستحيله وان الثانيه ال',
    'هو يفتترض', 'يفترض اجتزال ان الاول', 'وان الثانيه ال', 'هذا المنهج منذ زمن بعيد حيث ظهر',
    'استخدم هذا المنهج منذ زمن بعيد حيث ظهر', 'بدات الاعلان عن نفسه', 'السيما عند موسسي الفكر',
    'الاستراتيجي ال عسكري', 'بشكل واضح يف اسبانيا', 'مع كتاب اطلب', 'مع كتاب احرب', 'كتاب حرب هو', 'ويف', 'الثاين',
    'مسو وتفوق', 'صوت الى استراتيجية', 'صوت الي استراتيجية', 'صوت الى استراتيجيه', 'صوت الي استراتيجيه',
    'اختاذ القرار', 'اختاد القرار', 'القررا', 'مبعن اخر', 'مبدى الموضوعيه يف', 'مبدأ الموضوعية يف',
    'فيه قراءة', 'فيه تحليل', 'فيه بداية', 'فيه صناعة', 'فيه سياق', 'فيه اختيار', 'فيه اختاد', 'فيه اختاذ',
    'يف قراءة', 'يف تحليل', 'يف اختاذ', 'يف اتخاذ', 'يف بداية', 'يف صناعة', 'يف سياق', 'يف إطار', 'يف اطار',
  ]
  if (brokenFragments.some((x) => n.includes(normalizeAcademic(x)))) return true

  const normalizedTokens = n.split(' ')
  const weirdTokenCount = normalizedTokens.filter((t) => ['يف', 'الثاين', 'ويف', 'اختاذ', 'اختاد', 'القررا', 'مبعن', 'املوضوعيه', 'املوضوعية', 'القرا', 'املبادي', 'االستراتيجيه', 'املكتسب'].includes(t)).length
  if (weirdTokenCount >= 1 && arabicWords >= 8) return true
  if ((n.includes('يف ') || n.includes(' ويف ') || n.includes('فيه ')) && /(القرار|الاداره|المهني|الاستراتيجي|المشروع|الكتاب|المحتوي|المحتوى|القراءه|القراءة)/u.test(n)) return true

  // تكرار عالٍ أو كلمات قصيرة جداً يدل على تشوه OCR.
  const veryShort = ws.filter((w) => w.length <= 2).length
  if (ws.length >= 18 && veryShort / ws.length > 0.45) return true

  return false
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
