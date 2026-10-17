/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Structural regression checks. Database concurrency is also required to be verified
// with integration tests before calling the race conditions fully tested.
const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8')
const unitDetail = source('src/app/api/exam/detail/route.ts')
const unitSubmit = source('src/app/api/exam/submit/route.ts')
const programDetail = source('src/app/api/program-exam/detail/route.ts')
const programStart = source('src/app/api/program-exam/start/route.ts')
const programSubmit = source('src/app/api/program-exam/submit/route.ts')

describe('Stage C exam security invariants (static regression)', () => {
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
  test('unit answer keys are checked before consuming an attempt', () => {
    expect(unitSubmit.indexOf('for (const question of exam.questions)')).toBeLessThan(unitSubmit.indexOf('const claim ='))
    expect(unitSubmit).toContain("code: 'ANSWER_KEY_MISSING'")
    expect(unitSubmit).toContain("code: 'MODEL_ANSWER_MISSING'")
  })
  test('unit grading recovers unpersisted claims without discarding final results', () => {
    expect(unitSubmit).toContain('claimedUnitAttemptId = null')
    expect(unitSubmit).toContain('id: claimedUnitAttemptId')
    expect(unitSubmit).toContain("where: { id: claimedUnitAttemptId, status: 'SUBMITTED' }")
  })
  test('program attempt starts serialize requests on the student row', () => {
    expect(programDetail).toContain('db.$transaction(async (tx) =>')
    expect(programDetail).toContain('FOR UPDATE')
    expect(programDetail).toContain('tx.programExamAttempt.create(')
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
