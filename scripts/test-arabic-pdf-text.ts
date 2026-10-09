import { strict as assert } from 'node:assert'
import { fixArabicPdfText } from '../src/lib/arabic-pdf-text'

const cases: Array<[string, string]> = [
  ['ﻻ', 'لا'],
  ['أطباء بال حدود', 'أطباء بلا حدود'],
  ['ليس إال.', 'ليس إلا.'],
  ['االحتياطات', 'الاحتياطات'],
  ['األولية', 'الأولية'],
  ['اإلسعافات', 'الإسعافات'],
  ['ال يجوز', 'لا يجوز'],
  ['الكتاب', 'الكتاب'],
  ['المعرفة', 'المعرفة'],
  ['بالمدرسة', 'بالمدرسة'],
  ['والقلم', 'والقلم'],
  ['فالطالب', 'فالطالب'],
]

for (const [input, expected] of cases) {
  assert.equal(fixArabicPdfText(input), expected, `${input} => ${expected}`)
  assert.equal(fixArabicPdfText(fixArabicPdfText(input)), fixArabicPdfText(input), `idempotent: ${input}`)
}

console.log('Arabic PDF text normalization tests passed')
