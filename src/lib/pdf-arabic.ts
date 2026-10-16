const ARABIC_RE = /[\u0600-\u06FF\u0750-\u077F]/
const LTR_TOKEN_RE = /[A-Za-z0-9][A-Za-z0-9._:/%+\-@]*|\d+(?:[.,]\d+)*(?:\s*[A-Za-z]{2,6})?/g

function reverseChars(value: string) {
  return Array.from(value).reverse().join('')
}

function reverseArabicRunPreservingLtr(run: string) {
  const placeholders: string[] = []
  const protectedRun = run.replace(LTR_TOKEN_RE, (token) => {
    const marker = `\u0000${placeholders.length}\u0000`
    placeholders.push(token)
    return marker
  })
  let reversed = reverseChars(protectedRun)
  placeholders.forEach((token, index) => {
    const reversedMarker = reverseChars(`\u0000${index}\u0000`)
    reversed = reversed.replace(reversedMarker, token)
  })
  return reversed
}

/**
 * Convert logical Arabic text to a visual order suitable for jsPDF text() with align:right.
 * jsPDF's setR2L plus processArabic can double-flip mixed Arabic/LTR strings, so this
 * helper keeps Latin/number tokens in LTR order while reversing Arabic runs for visual PDF output.
 */
export function toVisualArabic(text: string): string {
  const input = String(text || '')
  if (!ARABIC_RE.test(input)) return input
  const segments = input.split(/(\s+)/)
  return segments
    .map((segment) => (ARABIC_RE.test(segment) ? reverseArabicRunPreservingLtr(segment) : segment))
    .reverse()
    .join('')
    .replace(/\s+([:،؛])/g, '$1')
}
