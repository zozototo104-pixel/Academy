const ARABIC_INDIC_DIGITS = '٠١٢٣٤٥٦٧٨٩'
const EASTERN_ARABIC_INDIC_DIGITS = '۰۱۲۳۴۵۶۷۸۹'

export function normalizeArabic(text: unknown): string {
  return String(text ?? '')
    .normalize('NFKC')
    .replace(/[-‐‑]\s*\n\s*/g, '')
    .replace(/[\u200B\u200C\u200D\u00AD\uFEFF]/g, '')
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/\u0640/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/[٠-٩]/g, (digit) => String(ARABIC_INDIC_DIGITS.indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String(EASTERN_ARABIC_INDIC_DIGITS.indexOf(digit)))
    .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
