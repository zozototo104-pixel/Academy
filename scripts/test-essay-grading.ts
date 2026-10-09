import { readFileSync } from 'node:fs'
import { strict as assert } from 'node:assert'
import { clampPoints, effectiveRubric, gradeEssayWithRubric, parseEssayGradeJson, pointsFromCriteria } from '../src/lib/essay-grading'

function src(path: string) {
  return readFileSync(path, 'utf8')
}

function testWeightedPoints() {
  const points = pointsFromCriteria([
    { name: 'الدقة', weight: 50, score0to10: 8, comment: 'جيد' },
    { name: 'الشمول', weight: 30, score0to10: 6, comment: 'متوسط' },
    { name: 'الوضوح', weight: 20, score0to10: 10, comment: 'واضح' },
  ], 10)
  assert.equal(points, 7.8)
}

function testClamp() {
  assert.equal(clampPoints(99, 10), 10)
  assert.equal(clampPoints(-5, 10), 0)
  assert.equal(clampPoints(Number.NaN, 10), 0)
}

function testDefaultRubric() {
  assert.match(effectiveRubric(''), /الدقة مقابل المصدر 50%/)
}

function testTextRubricUsesDefaultWeights() {
  const result = parseEssayGradeJson(JSON.stringify({
    criteria: [
      { name: 'الدقة مقابل المصدر', weight: 1, score0to10: 10, comment: 'دقيق' },
      { name: 'الشمول', weight: 1, score0to10: 0, comment: 'ناقص' },
      { name: 'الوضوح والتنظيم', weight: 1, score0to10: 0, comment: 'ضعيف' },
    ],
    feedback: 'تعليق',
    confidence: 'HIGH',
  }), 10, 'روبرك نصي')
  assert.equal(result.points, 5)
}

function testJsonRubricWithFractionWeights() {
  const rubric = JSON.stringify([{ name: 'الدقة', weight: 0.5 }, { name: 'الشمول', weight: 0.3 }, { name: 'الوضوح', weight: 0.2 }])
  const result = parseEssayGradeJson(JSON.stringify({
    criteria: [
      { name: 'الدقة', weight: 50, score0to10: 8, comment: 'جيد' },
      { name: 'الشمول', weight: 30, score0to10: 6, comment: 'متوسط' },
      { name: 'الوضوح', weight: 20, score0to10: 10, comment: 'واضح' },
    ],
    feedback: 'تعليق',
    confidence: 'HIGH',
  }), 10, rubric)
  assert.equal(result.points, 7.8)
}

function testMissingAndExtraCriteria() {
  const rubric = JSON.stringify([{ name: 'أ', weight: 50 }, { name: 'ب', weight: 50 }])
  const result = parseEssayGradeJson(JSON.stringify({
    criteria: [
      { name: 'أ', weight: 100, score0to10: 10, comment: 'ممتاز' },
      { name: 'ج زائد', weight: 100, score0to10: 10, comment: 'يجب تجاهله' },
    ],
    feedback: 'تعليق',
    confidence: 'LOW',
  }), 10, rubric)
  assert.equal(result.criteria.length, 2)
  assert.deepEqual(result.criteria.map((c) => c.name), ['أ', 'ب'])
  assert.equal(result.criteria[1].score0to10, 0)
  assert.equal(result.points, 5)
}

async function testEmptyAnswerZeroWithoutAi() {
  const result = await gradeEssayWithRubric({ question: 'س', studentAnswer: '  ', maxPoints: 10 })
  assert.equal(result.points, 0)
  assert.match(result.feedback, /فارغة|قصيرة/)
}

function testInvalidJsonRejected() {
  assert.throws(() => parseEssayGradeJson('{"criteria":[]}', 10), /too_small|Too small|Array must contain/)
}

function testModelPointsIgnored() {
  const result = parseEssayGradeJson(JSON.stringify({
    criteria: [{ name: 'الدقة مقابل المصدر', weight: 100, score0to10: 5, comment: 'نصف الإجابة صحيح' }],
    points: 999,
    feedback: 'تعليق',
    confidence: 'HIGH',
  }), 20)
  assert.equal(result.points, 10)
}

function testApprovalRejectsNullOpenAnswerPoints() {
  const code = src('src/app/api/admin/attempts-review/route.ts')
  assert(code.includes('OPEN_ANSWER_POINTS_REQUIRED'), 'اعتماد المراجعة يجب أن يرفض أي سؤال مقالي/قصير بلا نقاط')
  assert(code.includes('points == null'), 'التحقق يجب أن يحافظ على null بدلاً من تحويله إلى صفر')
  assert(code.includes('ANSWER_NOT_IN_ATTEMPT'), 'اعتماد المراجعة يجب أن يتحقق من ملكية answerId للمحاولة')
}

async function main() {
  for (const fn of [testWeightedPoints, testClamp, testDefaultRubric, testTextRubricUsesDefaultWeights, testJsonRubricWithFractionWeights, testMissingAndExtraCriteria, testInvalidJsonRejected, testModelPointsIgnored, testApprovalRejectsNullOpenAnswerPoints]) {
    fn()
    console.log(`✓ ${fn.name}`)
  }

  await testEmptyAnswerZeroWithoutAi()
  console.log('✓ testEmptyAnswerZeroWithoutAi')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
