import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { formalLengthWarnings, parseGeneratedQuestionCandidates } from '@/lib/question-bank-generation'

const EVIDENCE = 'باريس هي عاصمة فرنسا وأكبر مدنها وتقع على نهر السين في شمال البلاد'

function batch(overrides: Record<string, unknown> = {}) {
  const options = ['باريس', 'لندن', 'برلين']
  const question = {
    type: 'MCQ',
    text: 'ما عاصمة فرنسا؟ سؤال قصير وواضح تمامًا',
    options,
    correctAnswer: 'باريس',
    sourceEvidence: EVIDENCE,
    sourceIndex: 1,
    cognitiveSkill: 'UNDERSTAND',
    difficulty: 'MEDIUM',
    ...overrides,
  }
  return JSON.stringify({ questions: [question] })
}

describe('D3.3: formal length warns, exam-invalidating length rejects', () => {
  test('a normal question is accepted with no length flag', () => {
    const out = parseGeneratedQuestionCandidates(batch())
    expect(out.rejected).toBe(0)
    expect(out.accepted).toHaveLength(1)
    expect(out.accepted[0].qualityFlags || []).not.toContain('LENGTH_FORMAL')
  })

  test('question text beyond the formal cap (1300 > 1200) is accepted and flagged LENGTH_FORMAL', () => {
    const out = parseGeneratedQuestionCandidates(batch({ text: 'س'.repeat(1300) }))
    expect(out.rejected).toBe(0)
    expect(out.accepted).toHaveLength(1)
    expect(out.accepted[0].qualityFlags).toContain('LENGTH_FORMAL')
  })

  test('question text beyond the hard cap (2500 > 2400) is rejected as QUESTION_LENGTH_INVALID, not generic structural', () => {
    const out = parseGeneratedQuestionCandidates(batch({ text: 'س'.repeat(2500) }))
    expect(out.accepted).toHaveLength(0)
    expect(out.rejectedReasons).toEqual(['QUESTION_LENGTH_INVALID'])
  })

  test('a formally long option warns; an exam-invalidating option length rejects with the same specific code', () => {
    const longOption = 'خ'.repeat(300)
    const warned = parseGeneratedQuestionCandidates(batch({ options: [longOption, 'لندن', 'برلين'], correctAnswer: longOption }))
    expect(warned.rejected).toBe(0)
    expect(warned.accepted[0].qualityFlags).toContain('LENGTH_FORMAL')

    const hugeOption = 'خ'.repeat(600)
    const rejected = parseGeneratedQuestionCandidates(batch({ options: [hugeOption, 'لندن', 'برلين'], correctAnswer: hugeOption }))
    expect(rejected.accepted).toHaveLength(0)
    expect(rejected.rejectedReasons).toEqual(['QUESTION_LENGTH_INVALID'])
  })

  test('back-office length (source evidence) is formal too: warns within the hard cap, rejects beyond it', () => {
    const warned = parseGeneratedQuestionCandidates(batch({ sourceEvidence: 'د'.repeat(2000) }))
    expect(warned.rejected).toBe(0)
    expect(warned.accepted[0].qualityFlags).toContain('LENGTH_FORMAL')

    const rejected = parseGeneratedQuestionCandidates(batch({ sourceEvidence: 'د'.repeat(4000) }))
    expect(rejected.accepted).toHaveLength(0)
    expect(rejected.rejectedReasons).toEqual(['QUESTION_LENGTH_INVALID'])
  })

  test('non-length structural defects keep their old classification', () => {
    const out = parseGeneratedQuestionCandidates(batch({ difficulty: undefined }))
    expect(out.accepted).toHaveLength(0)
    expect(out.rejectedReasons).toEqual(['DIFFICULTY_REQUIRED'])
  })

  test('the warning helper itself only fires on string length beyond the formal caps', () => {
    expect(formalLengthWarnings({ text: 'قصير', options: ['أ', 'ب'] })).toEqual([])
    expect(formalLengthWarnings({ text: 'س'.repeat(1201) })).toEqual(['LENGTH_FORMAL'])
    expect(formalLengthWarnings({ text: 'س'.repeat(1200) })).toEqual([])
  })
})

describe('D3.3 alignment guards: the sanitizer must never silently cut what the parser accepted', () => {
  test('the job storage caps match the parser hard caps', () => {
    const job = readFileSync('src/lib/question-bank-job.ts', 'utf8')
    expect(job).toContain('cleanText(raw.text || raw.question || fallback.title, 2400)')
    expect(job).toContain('cleanText(raw.sourceEvidence, 3600)')
    expect(job).not.toContain('cleanText(x, 260)')
    const gen = readFileSync('src/lib/question-bank-generation.ts', 'utf8')
    expect(gen).toContain("'QUESTION_LENGTH_INVALID'")
    expect(gen).toContain('LENGTH_FORMAL')
  })
})
