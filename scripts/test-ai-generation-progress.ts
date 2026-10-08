import assert from 'node:assert/strict'
import { aiGenerationProgressKey, questionDuplicateKey } from '../src/lib/ai-generation-progress'

function main() {
  console.log('▶ AI generation progress helper keys and dedupe')

  assert.equal(aiGenerationProgressKey('QUESTION_BANK', 'program-1', 'ALL'), 'AI_GEN_PROGRESS:QUESTION_BANK:program-1:ALL')
  assert.equal(aiGenerationProgressKey('PROGRAM_EXAM', 'program-1', 2), 'AI_GEN_PROGRESS:PROGRAM_EXAM:program-1:2')

  const a = questionDuplicateKey('ما هو مفهومُ الدليل؟', 'source-1')
  const b = questionDuplicateKey('ما هو مفهوم الدليل', 'source-1')
  const c = questionDuplicateKey('ما هو مفهوم الدليل', 'source-2')
  assert.equal(a, b, 'Arabic normalization should deduplicate equivalent question text for the same source')
  assert.notEqual(a, c, 'same text with a different source remains a different generation target')

  console.log('AI generation progress helpers: ok')
}

main()
