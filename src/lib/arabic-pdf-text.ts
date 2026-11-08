const WORD_BOUNDARY = '[^\u0621-\u064A\u0660-\u0669\u06F0-\u06F9A-Za-z0-9_]'

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Genuine words that begin with «امل» and must never be reordered:
// أملاك (properties) and the possessive forms of أمل (hope).
const LAM_MEEM_EXCEPTIONS = new Set(['املاك', 'املنا', 'املهم', 'املهن', 'املها', 'املكم', 'املكن'])

function replaceIndependentWord(text: string, word: string, replacement: string) {
  const pattern = new RegExp(`(^|${WORD_BOUNDARY})${escapeRegExp(word)}(?=$|${WORD_BOUNDARY})`, 'gu')
  return text.replace(pattern, (_match, prefix: string) => `${prefix}${replacement}`)
}

export function fixArabicPdfText(text: string): string {
  let value = String(text || '').normalize('NFKC')

  // Explicit safe fixes for reversed lam-alef ligatures at the start of words.
  value = value
    .replace(/اال/g, 'الا')
    .replace(/األ/g, 'الأ')
    .replace(/اإل/g, 'الإ')
    .replace(/اآل/g, 'الآ')

  // Reversed lam-meem at the start of a word: the extractor emits
  // «امل» where the word is «الم» (المشروع تُستخرج «املشروع»،
  // والمؤثرات «املؤثرات»). Swap only at a word start — allowing one
  // proclitic (ب/ل/و/ف/ك/س) — and only for words of five letters or
  // more, so genuine short «امل» words are never touched; a small
  // exception list protects the rest (أملاك وأخواتها). «امل» inside a
  // word (كامل، شامل، التعامل) is correct Arabic and is never matched:
  // the pattern must begin at a non-Arabic boundary.
  value = value.replace(
    /(^|[^\u0621-\u064A\u0660-\u0669\u06F0-\u06F9A-Za-z0-9_])([بلوفكس]?)(امل[\u0621-\u064A]{2,})/gu,
    (match, boundary: string, clitic: string, word: string) => {
      if (LAM_MEEM_EXCEPTIONS.has(word)) return match
      return `${boundary}${clitic}الم${word.slice(3)}`
    },
  )

  // Independent-word fixes only. Do not touch article ال inside real words.
  value = replaceIndependentWord(value, 'إال', 'إلا')
  value = replaceIndependentWord(value, 'أال', 'ألا')
  value = replaceIndependentWord(value, 'بال', 'بلا')
  value = replaceIndependentWord(value, 'وال', 'ولا')
  value = replaceIndependentWord(value, 'فال', 'فلا')
  value = replaceIndependentWord(value, 'ال', 'لا')

  return value
}
