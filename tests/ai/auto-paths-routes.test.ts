/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Step 7b + 7i — per-route purpose audit and verifier independence.
// (a) Auto ranking can never return the generator as verifier: the
//     choke point (resolveAutoCandidates) and the scorer
//     (scoreModelForTask) both apply excludeProviders /
//     excludeModelFamilies BEFORE any candidate can win — including
//     through the ALBORIHI cross-family exception path, which auto
//     code never sets and never widens (only textAiComplete sets
//     allowAlborihiCrossFamilyVerifier, on an explicit REVIEW +
//     ACADEMIC_CRITICAL + excluded-ALBORIHI request).
// (b) Every 7i call site carries an explicit purpose/taskType so the
//     auto ranking for that purpose applies instead of the CHAT default.
import { resolveAutoCandidates, scoreModelForTask } from '../../src/lib/ai-auto-mode'

const GENERATOR = { provider: 'GEMINI', model: 'gemini-3.8-flash' }

describe('verifier never equals generator under auto (step 7b)', () => {
  test('resolveAutoCandidates drops the generator provider even when ranked first', () => {
    const result = resolveAutoCandidates({
      autoMode: true,
      ranking: [GENERATOR, { provider: 'GROQ', model: 'llama-3.3-70b' }],
      purpose: 'REVIEW',
      excludeProviders: ['GEMINI'],
      excludeModelFamilies: ['gemini'],
      modelFamily: (_provider, model) => (model.includes('gemini') ? 'gemini' : 'llama'),
    })
    expect(result.autoOverride).toBe(true)
    expect(result.autoCandidates.map((c) => `${c.provider}:${c.model}`)).toEqual(['GROQ:llama-3.3-70b'])
    expect(result.excludedReasons.join(' ')).toContain('EXCLUDED_PROVIDER')
  })

  test('resolveAutoCandidates drops the generator family even from another provider', () => {
    const result = resolveAutoCandidates({
      autoMode: true,
      ranking: [
        { provider: 'OPENAI', model: 'gemini-3.8-flash' },
        { provider: 'GROQ', model: 'llama-3.3-70b' },
      ],
      purpose: 'REVIEW',
      excludeProviders: ['GEMINI'],
      excludeModelFamilies: ['gemini'],
      modelFamily: (_provider, model) => (model.includes('gemini') ? 'gemini' : 'llama'),
    })
    expect(result.autoCandidates.map((c) => c.model)).toEqual(['llama-3.3-70b'])
    expect(result.excludedReasons.join(' ')).toContain('EXCLUDED_FAMILY')
  })

  test('scoreModelForTask excludes the generator by provider AND by family', () => {
    const byProvider = scoreModelForTask({
      provider: 'GEMINI', model: 'gemini-3.8-flash', purpose: 'REVIEW',
      excludeProviders: ['GEMINI'], excludeModelFamilies: ['gemini'],
    })
    expect(byProvider.excludedReason).toBe('EXCLUDED_PROVIDER')
    const byFamily = scoreModelForTask({
      provider: 'OPENAI', model: 'gemini-3.8-flash', purpose: 'REVIEW',
      excludeProviders: ['GEMINI'], excludeModelFamilies: ['gemini'],
      modelFamily: () => 'gemini',
    })
    expect(byFamily.excludedReason).toBe('EXCLUDED_FAMILY')
  })

  test('auto never re-admits ALBORIHI when the verifier excluded it', () => {
    // The ALBORIHI cross-family exception is a router-level decision
    // (textAiComplete, REVIEW + ACADEMIC_CRITICAL only). The auto
    // layer has no input for it and must not widen it: an excluded
    // ALBORIHI stays excluded even at rank 1.
    const result = resolveAutoCandidates({
      autoMode: true,
      ranking: [
        { provider: 'ALBORIHI', model: 'claude-sonnet-5' },
        { provider: 'GROQ', model: 'llama-3.3-70b' },
      ],
      purpose: 'REVIEW',
      excludeProviders: ['ALBORIHI'],
      excludeModelFamilies: ['claude'],
      modelFamily: (_provider, model) => (model.includes('claude') ? 'claude' : 'llama'),
    })
    expect(result.autoCandidates.map((c) => c.provider)).toEqual(['GROQ'])
    // With only the excluded provider ranked, auto has no qualified
    // candidate and passes through — it never invents a verifier.
    const onlyExcluded = resolveAutoCandidates({
      autoMode: true,
      ranking: [{ provider: 'ALBORIHI', model: 'claude-sonnet-5' }],
      purpose: 'REVIEW',
      excludeProviders: ['ALBORIHI'],
      excludeModelFamilies: ['claude'],
      modelFamily: () => 'claude',
    })
    expect(onlyExcluded.autoOverride).toBe(false)
    expect(onlyExcluded.autoCandidates).toEqual([])
  })
})

// --- Per-route purpose audit (step 7i): each call site must carry an
// explicit purpose AND taskType, so the auto ranking for that purpose
// applies instead of the CHAT default. If a purpose is removed, this
// test fails with the file that lost it.
const ROOT = join(import.meta.dir, '..', '..')
const PURPOSE_AUDIT: Array<{ file: string; purpose: string; taskType: string; taskTypeLiteral?: string }> = [
  { file: 'src/lib/ai.ts', purpose: 'CHAT', taskType: 'CHAT', taskTypeLiteral: "taskType: options.taskType || 'CHAT'" },
  { file: 'src/lib/ai.ts', purpose: 'GRADING', taskType: 'ESSAY_GRADING_SUPERVISOR' },
  { file: 'src/lib/admission-ai.ts', purpose: 'ANALYSIS', taskType: 'ADMISSION_REVIEW' },
  { file: 'src/lib/meeting-assistant.ts', purpose: 'CHAT', taskType: 'MEETING_ASSISTANT' },
  { file: 'src/lib/meeting-minutes.ts', purpose: 'GENERATION', taskType: 'MEETING_MINUTES' },
  { file: 'src/lib/human-handoff.ts', purpose: 'ANALYSIS', taskType: 'HANDOFF_INTENT' },
  { file: 'src/lib/supervisor-assessment-ai.ts', purpose: 'GENERATION', taskType: 'SUPERVISOR_ASSESSMENT' },
  { file: 'src/lib/essay-grading.ts', purpose: 'GRADING', taskType: 'ESSAY_GRADING' },
  { file: 'src/lib/ocr.ts', purpose: 'VISION', taskType: 'IMAGE_DOCUMENT_READ' },
  { file: 'src/lib/outline-units.ts', purpose: 'GENERATION', taskType: 'UNIT_GENERATION' },
  { file: 'src/lib/knowledge-bank.ts', purpose: 'ANALYSIS', taskType: 'BOOK_KNOWLEDGE' },
  { file: 'src/lib/knowledge-bank.ts', purpose: 'ANALYSIS', taskType: 'BOOK_KNOWLEDGE_UNIT' },
  { file: 'src/lib/book-chunk-analyzer.ts', purpose: 'ANALYSIS', taskType: 'BOOK_ANALYSIS' },
  { file: 'src/lib/book-chunk-analyzer.ts', purpose: 'ANALYSIS', taskType: 'BOOK_ENRICH' },
  { file: 'src/app/api/admin/program-units/suggest/route.ts', purpose: 'ANALYSIS', taskType: 'PROGRAM_UNIT_ANALYSIS' },
  { file: 'src/app/api/admin/program-units/suggest/route.ts', purpose: 'GENERATION', taskType: 'PROGRAM_UNIT_SYNTHESIS' },
  { file: 'src/app/api/admin/thesis-topics/route.ts', purpose: 'GENERATION', taskType: 'THESIS_TOPICS' },
  { file: 'src/app/api/admin/representatives/[id]/rewrite/route.ts', purpose: 'GENERATION', taskType: 'REPRESENTATIVE_REWRITE' },
  { file: 'src/app/api/admin/assignments/suggest/route.ts', purpose: 'GENERATION', taskType: 'ASSIGNMENT_SUGGEST' },
  { file: 'src/app/api/admin/study-schedule/generate/route.ts', purpose: 'GENERATION', taskType: 'STUDY_SCHEDULE' },
  { file: 'src/app/api/supervisor/thesis-review/route.ts', purpose: 'ANALYSIS', taskType: 'THESIS_REVIEW' },
  { file: 'src/app/api/thesis/[id]/process-step/route.ts', purpose: 'ANALYSIS', taskType: 'THESIS_CHUNK_SUMMARY' },
  { file: 'src/app/api/thesis/[id]/process-step/route.ts', purpose: 'ANALYSIS', taskType: 'THESIS_DIGEST' },
]

describe('per-route purpose audit (step 7i)', () => {
  for (const entry of PURPOSE_AUDIT) {
    test(`${entry.file} carries purpose ${entry.purpose} + taskType ${entry.taskType}`, () => {
      const source = readFileSync(join(ROOT, entry.file), 'utf8')
      expect(source).toContain(`purpose: '${entry.purpose}'`)
      expect(source).toContain(entry.taskTypeLiteral || `taskType: '${entry.taskType}'`)
    })
  }
})
