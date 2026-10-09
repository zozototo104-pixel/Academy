const WORD_BOUNDARY = '[^\u0621-\u064A\u0660-\u0669\u06F0-\u06F9A-Za-z0-9_]'

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

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

  // Independent-word fixes only. Do not touch article ال inside real words.
  value = replaceIndependentWord(value, 'إال', 'إلا')
  value = replaceIndependentWord(value, 'أال', 'ألا')
  value = replaceIndependentWord(value, 'بال', 'بلا')
  value = replaceIndependentWord(value, 'وال', 'ولا')
  value = replaceIndependentWord(value, 'فال', 'فلا')
  value = replaceIndependentWord(value, 'ال', 'لا')

  return value
}
