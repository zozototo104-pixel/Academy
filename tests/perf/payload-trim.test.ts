/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const programRulesRoute = readFileSync('src/app/api/admin/program-rules/route.ts', 'utf8')
const programRulesDetailRoute = readFileSync('src/app/api/admin/program-rules/[id]/route.ts', 'utf8')
const questionBankRoute = readFileSync('src/app/api/admin/question-bank/route.ts', 'utf8')

describe('admin payload trimming contracts', () => {
  test('program-rules list does not select heavy detail fields', () => {
    const listSelect = programRulesRoute.slice(programRulesRoute.indexOf('db.program.findMany'), programRulesRoute.indexOf('db_program_rules_custom_ids'))
    expect(listSelect).not.toContain('admissionRules: true')
    expect(listSelect).not.toContain('description: true')
    expect(listSelect).not.toContain('features: true')
    expect(listSelect).not.toContain('trademarkNotice: true')
    expect(listSelect).not.toContain('disclosureConsentText: true')
    expect(programRulesRoute).not.toContain('program: programSnapshot(p)')
  })

  test('program-rules detail endpoint returns the heavy fields', () => {
    expect(programRulesDetailRoute).toContain('admissionRules: true')
    expect(programRulesDetailRoute).toContain('description: true')
    expect(programRulesDetailRoute).toContain('features: true')
    expect(programRulesDetailRoute).toContain('program: programSnapshot(program)')
    expect(programRulesDetailRoute).toContain('rules,')
  })

  test('question-bank list excludes heavy review fields', () => {
    const listSelect = questionBankRoute.slice(questionBankRoute.indexOf('select: {'), questionBankRoute.indexOf('return items.map'))
    expect(listSelect).not.toContain('modelAnswer: true')
    expect(listSelect).not.toContain('sourceEvidence: true')
    expect(listSelect).not.toContain('correctRationale: true')
    expect(listSelect).not.toContain('distractorRationales: true')
    expect(listSelect).not.toContain('reviewNotes: true')
  })
})
