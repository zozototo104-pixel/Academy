/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Structural regression checks. Database concurrency is also required to be verified
// with integration tests before calling the race conditions fully tested.
const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8')
const unitDetail = source('src/app/api/exam/detail/route.ts')
const unitSubmit = source('src/app/api/exam/submit/route.ts')
const examAi = source('src/lib/ai.ts')
const programDetail = source('src/app/api/program-exam/detail/route.ts')
const programStart = source('src/app/api/program-exam/start/route.ts')
const programSubmit = source('src/app/api/program-exam/submit/route.ts')
const examView = source('src/components/aact/ExamView.tsx')

describe('Stage C exam security invariants (static regression)', () => {
  test('program exam consent must render while questions are intentionally hidden before starting', () => {
    expect(programDetail).toContain('questions: currentActiveAttempt')
    expect(programDetail).toContain(': [],')
    expect(examView).toContain("const isObjective = q?.type === 'MCQ' || q?.type === 'TF'")
    const consent = examView.indexOf("if (!result && activeExamKind === 'final' && !examStarted)")
    const missingQuestionFallback = examView.indexOf('if (!q) {', consent)
    expect(consent).toBeGreaterThan(0)
    expect(missingQuestionFallback).toBeGreaterThan(consent)
    expect(examView).toContain('تعذر عرض سؤال الامتحان')
  })

  test('after start, only render questions from an active attempt and retry details without starting twice', () => {
    const start = examView.indexOf("const started = await api<any>('/api/program-exam/start'")
    const fresh = examView.indexOf('const fresh = await api<ExamData>(`/api/program-exam/detail?examId=')
    const state = examView.indexOf('setExamStarted(true)', fresh)
    expect(start).toBeGreaterThan(0)
    expect(fresh).toBeGreaterThan(start)
    expect(state).toBeGreaterThan(fresh)
    expect(examView).toContain('if (!Array.isArray(fresh.questions) || !fresh.questions.length)')
    const fallback = examView.slice(examView.indexOf('if (!q) {'), examView.indexOf('// ===== Exam taking screen ====='))
    expect(fallback).toContain("setCurrent(0)")
    expect(fallback).toContain("setData(fresh)")
    expect(fallback).not.toContain('/api/program-exam/start')
    expect(programStart).toContain("status: 'STARTED'")
  })
  test('exam feedback uses the configured router and never changes scoring', () => {
    const feedback = examAi.slice(examAi.indexOf('export async function generateOverallFeedback('))
    expect(feedback).toContain('await textAiCompleteJson({')
    expect(feedback).toContain("taskType: 'EXAM_FEEDBACK'")
    expect(feedback).toContain('OVERALL_FEEDBACK_INVALID_SCHEMA')
    expect(feedback).not.toContain('getZAI()')
    expect(feedback).not.toContain('zai.chat.')
    expect(unitSubmit).toContain('generateOverallFeedback(')
    expect(unitSubmit).toContain('buildAnswerKeyFeedback(')
    expect(unitSubmit).toContain('score: Math.round(percentage * 10) / 10')
    expect(unitSubmit).toContain("status: 'NEEDS_REVIEW'")
  })

  test('unit attempt starts on the server inside an exclusive transaction', () => {
    expect(unitDetail).toContain('db.$transaction(async (tx) =>')
    expect(unitDetail).toContain('FOR UPDATE')
    expect(unitDetail).toContain("status: 'STARTED'")
    expect(unitDetail).toContain('tx.examAttempt.create(')
    expect(unitDetail).toContain('existing ??')
  })
  test('unit submission atomically claims an existing attempt before grading', () => {
    expect(unitSubmit).toContain('db.examAttempt.updateMany(')
    expect(unitSubmit).toContain("status: 'STARTED'")
    expect(unitSubmit).toContain("status: 'SUBMITTED'")
    expect(unitSubmit).toContain('claim.count !== 1')
    expect(unitSubmit).not.toContain('tx.examAttempt.create(')
  })
  test('objective answer keys are validated before claim; missing essay models require review after preservation', () => {
    expect(unitSubmit.indexOf('for (const question of exam.questions)')).toBeLessThan(unitSubmit.indexOf('const claim ='))
    expect(unitSubmit).toContain("code: 'ANSWER_KEY_MISSING'")
    // A missing essay model is not a reason to reject the student's answer:
    // persist it atomically and send the attempt for manual grading.
    expect(unitSubmit.indexOf('const claim =')).toBeLessThan(unitSubmit.indexOf('if (!q.modelAnswer && essayText.trim().length > 0)'))
    expect(unitSubmit).toContain("code: 'ESSAY_MODEL_ANSWER_MISSING'")
    expect(unitSubmit).toContain("status: 'NEEDS_REVIEW'")
  })
  test('unit grading recovers unpersisted claims without discarding final results', () => {
    expect(unitSubmit).toContain('claimedUnitAttemptId = null')
    expect(unitSubmit).toContain('id: claimedUnitAttemptId')
    expect(unitSubmit).toContain("where: { id: claimedUnitAttemptId, status: 'SUBMITTED' }")
  })
  test('program attempt starts serialize requests on the student row', () => {
    expect(programDetail).not.toContain('programExamAttempt.create')
    expect(programDetail).not.toContain('FOR UPDATE')
    expect(programStart).toContain('db.$transaction(async (tx) =>')
    expect(programStart).toContain('FOR UPDATE')
    expect(programStart).toContain('tx.programExamAttempt.create(')
  })
  test('program submission claims attempts atomically', () => {
    expect(programSubmit).toContain('db.programExamAttempt.updateMany(')
    expect(programSubmit).toContain('claimed.count !== 1')
    expect(programSubmit).toContain('ATTEMPT_ALREADY_CLAIMED')
  })
  test('both exam submission endpoints bound and validate answers', () => {
    for (const code of [unitSubmit, programSubmit]) {
      expect(code).toContain('maxPayloadBytes = 512 * 1024')
      expect(code).toContain('answers.length > 150')
      expect(code).toContain('new Set(answers.map((a) => a.questionId)).size !== answers.length')
    }
  })
})
