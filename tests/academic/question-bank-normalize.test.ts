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
    expect(result.accepted[0].correctAnswer).toBe('0')
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

  test('ESSAY long correctAnswer moves to modelAnswer without trimming', () => {
    const longAnswer = 'هذا جواب نموذجي طويل يشرح الفكرة التعليمية المطلوبة من السؤال اعتماداً على النص الأصلي. '.repeat(8)
    const result = parseOne({
      type: 'ESSAY',
      correctAnswer: longAnswer,
    })

    expect(result.rejected).toBe(0)
    expect(result.accepted[0].modelAnswer).toBe(longAnswer.trim())
    expect(result.accepted[0].correctAnswer).toBeNull()
    expect(result.accepted[0].qualityFlags).toContain('MOVED_ESSAY_ANSWER')
  })

  test('literal evidence not found in source is still rejected by evidence validation', () => {
    const result = parseOne({ type: 'TF', options: [], correctAnswer: 'صح', sourceEvidence: 'هذا الاقتباس غير موجود في المصدر إطلاقاً.' })
    const evidence = validateQuestionBatchAgainstKnowledge(result.accepted, [{ text: 'المصدر يتحدث عن موضوع مختلف تماماً ولا يحتوي الاقتباس المطلوب.' }])

    expect(result.rejected).toBe(0)
    expect(evidence.accepted).toHaveLength(0)
    expect(evidence.rejected[0].reason).toBe('NOT_FOUND')
  })
})
