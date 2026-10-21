import { describe, expect, test } from 'bun:test'
import { parseGeneratedQuestionCandidates } from '../../src/lib/question-bank-generation'
import { validateQuestionBatchAgainstKnowledge } from '../../src/lib/question-bank-evidence'

const base = {
  text: 'ما الفكرة التعليمية الأساسية التي يوضحها هذا السؤال وفق المصدر؟',
  sourceEvidence: 'النص الأصلي يذكر هذه العبارة بوضوح ضمن الفقرة التعليمية.',
  sourceIndex: 1,
  cognitiveSkill: 'UNDERSTAND',
  difficulty: 'MEDIUM',
}

function parseOne(question: Record<string, unknown>) {
  return parseGeneratedQuestionCandidates(JSON.stringify({ questions: [{ ...base, ...question }] }))
}

describe('question bank generated candidate normalization', () => {
  test('TF options [] passes with normalized options and Arabic answer alias', () => {
    const result = parseOne({ type: 'TF', options: [], correctAnswer: 'صح' })

    expect(result.rejected).toBe(0)
    expect(result.accepted[0].options).toEqual(['صح', 'خطأ'])
    expect(result.accepted[0].correctAnswer).toBe('صح')
    expect(result.accepted[0].qualityFlags).toContain('NORMALIZED_TF_OPTIONS')
  })

  test("MCQ correctAnswer 'ب' with 4 options becomes index 1", () => {
    const result = parseOne({
      type: 'MCQ',
      options: ['الخيار الأول', 'الخيار الثاني', 'الخيار الثالث', 'الخيار الرابع'],
      correctAnswer: 'ب',
    })

    expect(result.rejected).toBe(0)
    expect(result.accepted[0].correctAnswer).toBe('1')
    expect(result.accepted[0].qualityFlags).toContain('NORMALIZED_MCQ_LETTER')
  })

  test("MCQ correctAnswer 'هـ' with 4 options is still rejected", () => {
    const result = parseOne({
      type: 'MCQ',
      options: ['الخيار الأول', 'الخيار الثاني', 'الخيار الثالث', 'الخيار الرابع'],
      correctAnswer: 'هـ',
    })

    expect(result.rejected).toBe(1)
    expect(result.rejectedReasons).toContain('MCQ_ANSWER_NOT_IN_OPTIONS')
  })

  test('model-provided quality flags are not trusted or preserved', () => {
    const result = parseOne({
      type: 'TF',
      options: ['صح', 'خطأ'],
      correctAnswer: 'صح',
      qualityFlags: ['SOURCE_GROUNDED', 'x'.repeat(200)],
    })

    expect(result.rejected).toBe(0)
    expect(result.accepted[0].qualityFlags).not.toContain('SOURCE_GROUNDED')
    expect(result.accepted[0].qualityFlags).not.toContain('x'.repeat(200))
  })

  test('ESSAY long correctAnswer moves to empty modelAnswer and clears correctAnswer', () => {
    const longAnswer = 'هذا جواب نموذجي طويل يشرح الفكرة التعليمية المطلوبة من السؤال اعتماداً على النص الأصلي. '.repeat(8)
    const result = parseOne({
      type: 'ESSAY',
      correctAnswer: longAnswer,
    })

    expect(result.rejected).toBe(0)
    expect(result.accepted[0].modelAnswer).toBe(longAnswer.trim())
    expect(result.accepted[0].correctAnswer).toBeNull()
    expect(result.accepted[0].qualityFlags).toContain('MOVED_ESSAY_LONG_ANSWER')
  })

  test('ESSAY keeps a longer existing modelAnswer instead of overwriting it', () => {
    const longAnswer = 'هذا جواب طويل يصلح كنص منقول إلى الإجابة النموذجية إذا كانت فارغة فقط. '.repeat(5)
    const longerModelAnswer = 'هذه إجابة نموذجية موجودة أطول من جواب الحقل المختصر، ويجب ألا يتم استبدالها أثناء التطبيع. '.repeat(7)
    const result = parseOne({
      type: 'ESSAY',
      correctAnswer: longAnswer,
      modelAnswer: longerModelAnswer,
    })

    expect(result.rejected).toBe(1)
    expect(result.accepted).toHaveLength(0)
  })

  test('ESSAY short text without modelAnswer is still rejected structurally', () => {
    const result = parseOne({
      type: 'ESSAY',
      correctAnswer: 'جواب قصير',
    })

    expect(result.rejected).toBe(1)
    expect(result.accepted).toHaveLength(0)
  })

  test('MCQ long answer is not treated as an ESSAY modelAnswer', () => {
    const result = parseOne({
      type: 'MCQ',
      options: ['الخيار الأول', 'الخيار الثاني', 'الخيار الثالث'],
      correctAnswer: 'إجابة طويلة لا تطابق أي خيار ولا يجب نقلها إلى modelAnswer في سؤال اختيار من متعدد. '.repeat(5),
    })

    expect(result.rejected).toBe(1)
    expect(result.accepted).toHaveLength(0)
  })

  test('question without source evidence is still rejected structurally', () => {
    const result = parseOne({ type: 'TF', options: [], correctAnswer: 'صح', sourceEvidence: undefined })

    expect(result.rejected).toBe(1)
    expect(result.rejectedReasons).toContain('SOURCE_EVIDENCE_REQUIRED')
  })

  test('literal evidence not found in source is still rejected by evidence validation', () => {
    const result = parseOne({ type: 'TF', options: [], correctAnswer: 'صح', sourceEvidence: 'هذا الاقتباس غير موجود في المصدر إطلاقاً ولا تظهر عبارته داخل النص الأصلي المعتمد للسؤال.' })
    const evidence = validateQuestionBatchAgainstKnowledge(result.accepted, [{ text: 'المصدر يتحدث عن موضوع مختلف تماماً ولا يحتوي الاقتباس المطلوب.' }])

    expect(result.rejected).toBe(0)
    expect(evidence.accepted).toHaveLength(0)
    expect(evidence.rejected[0].reason).toBe('NOT_FOUND')
  })
})
