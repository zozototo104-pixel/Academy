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
    .replace(/\b\d{1,5}\s+of\s+\d{1,5}\b/gi, ' ')
    .replace(/\bpage\s+\d{1,5}\s+(?:of|\/|من)\s+\d{1,5}\b/gi, ' ')
    .replace(/\bصفحة\s+\d{1,5}\s+(?:من|\/|of)\s+\d{1,5}\b/gi, ' ')
    .replace(/\b(?:CONCEPT|THEORY|METHOD|CASE|DEFINITION|QUESTION_SEED|SUMMARY)\b\s*(?:\|\s*(?:أهمية|اهمية)\s*\d{1,3})?/gi, ' ')
    .replace(/\[\s*(?:CONCEPT|THEORY|METHOD|CASE|DEFINITION|QUESTION_SEED|SUMMARY)\s*(?:\|[^\]]*)?\]/gi, ' ')
    .replace(/(?:^|[\n\s.؛،-])(?:محور\s+معرفي\s+مهم|الفكرة|خلاصة\s+أكاديمية|خلاصة\s+اكاديمية|مقتطف\s+داعم|دليل\s+من\s+المحتوى|دليل\s+من\s+المحتوي|كلمات\s+مفتاحية|مصطلحات\s+مرتبطة|مصدر\s+القراءة|جودة\s+المحتوى|جودة\s+المحتوي)\s*[:：]\s*/giu, ' ')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s+([،؛؟.!])/g, '$1')
    .replace(/([،؛؟.!]){2,}/g, '$1')
    .trim()
    .slice(0, max)
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
    'محور معرفي مهم', 'دليل من المحتوي', 'دليل من المحتوى', 'خلاصه اكاديميه', 'خلاصة اكاديمية',
    'مقتطف داعم', 'مصطلحات مرتبطه', 'كلمات مفتاحيه', 'مصدر القراءه', 'جوده المحتوي', 'رابط الكتاب',
    'google com search', 'books google', 'tbm bks', 'لم يظهر فيه نص', 'رابط مفتوح لكن لم يظهر',
    'بنك المعرفه الاكاديمي المستخرج', 'اي عباره تفسر بصوره ادق دلاله', 'كيف يمكن فهم فكره', 'كيف يمكن تطبيق فكره',
    'libro de la guerra', 'tratado de la perfeccion', 'tratado de la perfección', 'lehrsätze', 'lehrs atze',
    'vellena', 'bonapert', 'بونابرت رجاء الكتاب', 'كتاب الثاين', 'الكتاب ويف', 'عام 8121', 'عام 8115', 'عام 8518',
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
    'يف قراءة', 'يف تحليل', 'يف اختاذ', 'يف اتخاذ', 'يف بداية', 'يف صناعة', 'يف سياق', 'يف إطار', 'يف اطار',
  ]
  if (brokenFragments.some((x) => n.includes(normalizeAcademic(x)))) return true

  const normalizedTokens = n.split(' ')
  const weirdTokenCount = normalizedTokens.filter((t) => ['يف', 'الثاين', 'ويف', 'اختاذ', 'اختاد', 'القررا', 'مبعن', 'املوضوعيه', 'املوضوعية', 'القرا'].includes(t)).length
  if (weirdTokenCount >= 1 && arabicWords >= 8) return true
  if ((n.includes('يف ') || n.includes(' ويف ')) && /(القرار|الاداره|المهني|الاستراتيجي|المشروع|الكتاب|المحتوي|المحتوى)/u.test(n)) return true

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
