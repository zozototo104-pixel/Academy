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

  test('question-bank list selects bounded previews and omits full review fields', () => {
    const select = questionBankRoute.match(/SELECT ([\s\S]*?)FROM "QuestionBankItem"/)?.[1]
    expect(select).toBeDefined()
    let remaining = select!
    for (const [field, alias] of [
      ['modelAnswer', 'modelAnswer'], ['sourceEvidence', 'sourceEvidence'],
      ['reviewNotes', 'verifierReason'], ['rejectedReason', 'rejectedReason'],
    ]) {
      const preview = `NULLIF(LEFT(BTRIM("${field}", \${whitespace}), 200), '') AS "${alias}"`
      expect(remaining).toContain(preview)
      remaining = remaining.replace(preview, '')
      expect(remaining).not.toContain(`"${field}"`)
    }
    expect(remaining).not.toMatch(/\*|correctRationale|distractorRationales/)
  })
})
