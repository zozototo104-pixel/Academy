import assert from 'node:assert/strict'
import { validateLiteralEvidence, sourceTextAtOneBasedIndex } from '../src/lib/evidence-validator'

const longArabic = 'الإدارة الفعالة تعتمد على التخطيط والتنظيم والمتابعة المستمرة لتحقيق الأهداف المؤسسية بكفاءة'

function expectOk(evidence: string, sourceText: string) {
  const result = validateLiteralEvidence({ evidence, sourceText, minChars: 10 })
  assert.equal(result.ok, true, JSON.stringify(result))
}

function main() {
  console.log('▶ literal evidence: diacritics')
  expectOk('الإدارة الفعالة تعتمد على التخطيط', 'الإِدَارَةُ الفَعَّالَةُ تَعْتَمِدُ عَلَى التَّخْطِيطِ والتنظيم')

  console.log('▶ literal evidence: hamza and taa marbuta variants')
  expectOk('اداره فعاله تعتمد علي التخطيط', 'إدارة فعّالة تعتمد على التخطيط والتنظيم المستمر')

  console.log('▶ literal evidence: paraphrase rejected')
  assert.deepEqual(
    validateLiteralEvidence({ evidence: 'تحقق المؤسسات النجاح عندما تخطط جيداً وتتابع أعمالها بصورة مستمرة', sourceText: longArabic, minChars: 10 }),
    { ok: false, reason: 'NOT_FOUND' }
  )

  console.log('▶ literal evidence: too short')
  assert.deepEqual(validateLiteralEvidence({ evidence: 'إدارة فعالة جدا', sourceText: longArabic }), { ok: false, reason: 'TOO_SHORT' })

  console.log('▶ literal evidence: hidden PDF characters removed')
  expectOk('الإدارة الفعالة', 'الإد\u200Cارة الفعالة')

  console.log('▶ literal evidence: PDF line-break hyphenation joined')
  expectOk('الإدارة الفعالة', 'الإدا-\nرة الفعالة')

  console.log('▶ literal evidence: English case ignored')
  expectOk('Strategic Management Requires Planning', 'STRATEGIC MANAGEMENT REQUIRES PLANNING and continuous review')

  console.log('▶ sourceIndex: one-based and numeric strings')
  const sources = [{ text: 'first source' }, { text: 'second source' }]
  assert.equal(sourceTextAtOneBasedIndex(sources, 1, (item) => item.text), 'first source')
  assert.equal(sourceTextAtOneBasedIndex(sources, '1', (item) => item.text), 'first source')
  assert.equal(sourceTextAtOneBasedIndex(sources, 0, (item) => item.text), null)
  assert.equal(sourceTextAtOneBasedIndex(sources, '0', (item) => item.text), null)
  assert.equal(sourceTextAtOneBasedIndex(sources, 'abc', (item) => item.text), null)
  assert.equal(sourceTextAtOneBasedIndex(sources, 3, (item) => item.text), null)

  console.log('evidence validator guardrails: ok')
}

try {
  main()
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
