/**
 * Arabic Speech Normalizer — تجهيز النص للنطق الطبيعي قبل TTS.
 * يحول الأرقام والعملات والنسب والتواريخ والاختصارات إلى كلمات عربية منطوقة،
 * وينظف رموز Markdown حتى لا تُقرأ حرفياً.
 */

const ONES = ['صفر', 'واحد', 'اثنان', 'ثلاثة', 'أربعة', 'خمسة', 'ستة', 'سبعة', 'ثمانية', 'تسعة', 'عشرة']
const TEENS = ['أحد عشر', 'اثنا عشر', 'ثلاثة عشر', 'أربعة عشر', 'خمسة عشر', 'ستة عشر', 'سبعة عشر', 'ثمانية عشر', 'تسعة عشر']
const TENS = ['', '', 'عشرون', 'ثلاثون', 'أربعون', 'خمسون', 'ستون', 'سبعون', 'ثمانون', 'تسعون']
const HUNDREDS = ['', 'مئة', 'مئتان', 'ثلاثمئة', 'أربعمئة', 'خمسمئة', 'ستمئة', 'سبعمئة', 'ثمانمئة', 'تسعمئة']

/** تحويل عدد صحيح (0..999,999,999) إلى كلمات عربية منطوقة */
export function numberToArabicWords(num: number): string {
  if (!isFinite(num)) return ''
  num = Math.round(Math.abs(num))
  if (num <= 10) return ONES[num]
  if (num <= 19) return TEENS[num - 11]
  if (num < 100) {
    const t = Math.floor(num / 10)
    const o = num % 10
    return o ? `${ONES[o]} و${TENS[t]}` : TENS[t]
  }
  if (num < 1000) {
    const h = Math.floor(num / 100)
    const rest = num % 100
    return rest ? `${HUNDREDS[h]} و${numberToArabicWords(rest)}` : HUNDREDS[h]
  }
  if (num < 1_000_000) {
    const th = Math.floor(num / 1000)
    const rest = num % 1000
    const thWords =
      th === 1 ? 'ألف' : th === 2 ? 'ألفان' : th <= 10 ? `${numberToArabicWords(th)} آلاف` : `${numberToArabicWords(th)} ألفاً`
    return rest ? `${thWords} و${numberToArabicWords(rest)}` : thWords
  }
  const m = Math.floor(num / 1_000_000)
  const rest = num % 1_000_000
  const mWords = m === 1 ? 'مليون' : m === 2 ? 'مليونان' : m <= 10 ? `${numberToArabicWords(m)} ملايين` : `${numberToArabicWords(m)} مليوناً`
  return rest ? `${mWords} و${numberToArabicWords(rest)}` : mWords
}

/** جزء عشري: "3.5" → "ثلاثة فاصلة خمسة" */
function withDecimal(intPart: number, decPart: string): string {
  const digits = decPart.replace(/0+$/, '') || 'صفر'
  const spoken = digits.split('').map((d) => ONES[Number(d)] || d).join(' ')
  return `${numberToArabicWords(intPart)} فاصلة ${spoken}`
}

/** هل الرقم يشبه سنة (1900-2099) في سياق تاريخ؟ */
function looksLikeYear(before: string): boolean {
  return /(عام|سنة|في\s|من\s|حتى\s|ذ|ب)$/.test(before)
}

/**
 * التحويل الرئيسي — يُستدعى قبل إرسال أي مقطع إلى TTS.
 */
export function normalizeForSpeech(input: string): string {
  let text = input

  // 1) إزالة تنسيقات Markdown — لا تُنطق
  text = text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/[*_#`~>|]/g, '')
    .replace(/\[(.*?)\]\(.*?\)/g, '$1')

  // 2) اختصارات شائعة
  text = text
    .replace(/أ\.د(?=[.\s])/g, 'أستاذ دكتور')
    .replace(/(?<![ال])د\.(?=\s)/g, 'دكتور ')
    .replace(/\bم\.م\b/g, 'مدير عام')
    .replace(/\bفي المئة\b/g, 'بالمئة')

  // 3) النسب المئوية: 15% أو 15٪ → خمسة عشر بالمئة
  text = text.replace(/(\d+(?:[.,]\d+)?)\s*[%٪]/g, (_m, num: string) => {
    const [i, d] = num.replace(',', '.').split('.')
    const words = d ? withDecimal(Number(i), d) : numberToArabicWords(Number(i))
    return `${words} بالمئة`
  })

  // 4) العملات: 4100$ أو $4100 أو 750 دولار
  text = text.replace(/\$\s*(\d+(?:[.,]\d+)?)/g, (_m, num: string) => `${num} دولار`)
  text = text.replace(/(\d+(?:[.,]\d+)?)\s*(\$|دولار|شيكل|دينار|يورو|جنيه)/g, (_m, num: string, cur: string) => {
    const [i, d] = num.replace(',', '.').split('.')
    const curWord = cur === '$' ? 'دولار' : cur
    const words = d ? withDecimal(Number(i), d) : numberToArabicWords(Number(i))
    return `${words} ${curWord}`
  })

  // 5) الأرقام العامة (مع مراعاة السنوات في سياقها): "عام 2026" تبقى منطوقة ككلمات سنة
  text = text.replace(/(\d+(?:[.,]\d+)?)/g, (match, num: string, offset: number, whole: string) => {
    const before = whole.slice(Math.max(0, offset - 14), offset)
    const after = whole.slice(offset + match.length, offset + match.length + 8)
    // تاريخ هجري/ميلادي بصيغة 2026/09/09 — نطق الأجزاء كأرقام مفردة
    if (/^\d{4}$/.test(num) && looksLikeYear(before)) {
      return yearToWords(Number(num))
    }
    if (/\d{1,2}\/\d{1,2}\/\d{4}/.test(whole.slice(offset, offset + 12))) {
      return num.split('/').map((p: string) => numberToArabicWords(Number(p))).join(' ')
    }
    if (num.includes('.') || num.includes(',')) {
      const [i, d] = num.replace(',', '.').split('.')
      // أرقام مالية بعلامة عشرية — نقرأ الفاصلة
      if (d && d.length <= 2 && /(دولار|شيكل|دينار|\$)/.test(after)) return withDecimal(Number(i), d)
      return withDecimal(Number(i), d)
    }
    void after
    return numberToArabicWords(Number(num))
  })

  // 6) الرموز المتبقية التي قد تُقرأ بشكل غريب
  text = text
    .replace(/&/g, ' و')
    .replace(/@/g, ' آت ')
    .replace(/\+/g, ' زائد ')
    .replace(/=/g, ' يساوي ')

  // 7) تنظيف المسافات
  text = text.replace(/\s{2,}/g, ' ').trim()
  return text
}

/** نطق السنوات بالصيغة المنطوقة: 2026 → ألفان وستة وعشرون */
function yearToWords(y: number): string {
  if (y >= 2000) {
    const rest = y - 2000
    if (rest === 0) return 'ألفين'
    return `${numberToArabicWords(2000 + rest)}`.replace('ألفان و', 'ألفين و')
  }
  if (y >= 1900) {
    const rest = y - 1900
    return rest === 0 ? 'ألف وتسعمئة' : `ألف وتسعمئة و${numberToArabicWords(rest)}`
  }
  return numberToArabicWords(y)
}
