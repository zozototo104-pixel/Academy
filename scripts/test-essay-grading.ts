import { strict as assert } from 'node:assert'
import { clampPoints, effectiveRubric, parseEssayGradeJson, pointsFromCriteria } from '../src/lib/essay-grading'

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

function testInvalidJsonRejected() {
  assert.throws(() => parseEssayGradeJson('{"criteria":[]}', 10), /too_small|Too small|Array must contain/)
}

function testModelPointsIgnored() {
  const result = parseEssayGradeJson(JSON.stringify({
    criteria: [{ name: 'الدقة', weight: 100, score0to10: 5, comment: 'نصف الإجابة صحيح' }],
    points: 999,
    feedback: 'تعليق',
    confidence: 'HIGH',
  }), 20)
  assert.equal(result.points, 10)
}

for (const fn of [testWeightedPoints, testClamp, testDefaultRubric, testInvalidJsonRejected, testModelPointsIgnored]) {
  fn()
  console.log(`✓ ${fn.name}`)
}
