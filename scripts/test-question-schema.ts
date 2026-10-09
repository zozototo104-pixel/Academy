import assert from 'node:assert/strict'
import { parseGeneratedQuestionCandidates, parseQuestionBatchEnvelope } from '../src/lib/question-bank-generation'

const base = { text: 'ما هي الفكرة الرئيسية التي يؤكدها النص المقتبس؟', sourceEvidence: 'الإدارة الفعالة تعتمد على التخطيط والتنظيم والمتابعة المستمرة.', sourceIndex: 1, difficulty: 'MEDIUM', cognitiveSkill: 'UNDERSTAND' }
const essay = { ...base, type: 'مقالي', modelAnswer: 'تعتمد الإدارة الفعالة على التخطيط والتنظيم والمتابعة المستمرة، وهي خطوات مترابطة لتحقيق الأهداف.' }
const mcq = { ...base, type: 'multiple_choice', options: ['التخطيط', 'التنظيم', 'المتابعة', 'التقييم'], correctAnswer: 'التخطيط' }
function accepts(q: unknown): boolean { return parseGeneratedQuestionCandidates(JSON.stringify({ questions: [q] })).accepted.length === 1 }
assert.equal(accepts(essay), true, 'ESSAY without options/correctAnswer')
assert.equal(accepts({ ...mcq, options: undefined }), false, 'MCQ without options')
const tf = parseGeneratedQuestionCandidates(JSON.stringify({ questions: [{ ...base, type: 'true_false', options: null, correctAnswer: 'صح' }] })).accepted[0]
assert.deepEqual(tf?.options, ['صح', 'خطأ'], 'TF null options default')
assert.equal(accepts({ ...mcq, correctAnswer: 'خيار غير موجود' }), false, 'MCQ mismatched answer')
assert.equal(parseQuestionBatchEnvelope(JSON.stringify([essay])).questions.length, 1, 'array envelope')
assert.equal(parseGeneratedQuestionCandidates(JSON.stringify([essay])).accepted.length, 1, 'array candidates')
assert.equal(accepts(mcq), true, 'valid MCQ')
console.log('question schema: ok')
