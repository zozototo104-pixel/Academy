import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Wiring pins for the 2026-11-04 book-read failure fixes. The behavioral half
// (which errors pause vs fail a job) lives in scripts/test-book-read-lock.ts;
// these pins keep the user-facing honesty guarantees from silently regressing:
// a FAILED job must not be reported as "not found", a trailing step call after
// a COMPLETED job must not surface as an error, and the text router's final
// error must name the candidates it skipped instead of implying a 1-provider
// chain.
const root = join(import.meta.dir, '..', '..')
const readStep = readFileSync(join(root, 'src/app/api/admin/books/[id]/read-step/route.ts'), 'utf8')
const textAi = readFileSync(join(root, 'src/lib/text-ai.ts'), 'utf8')
const jobControl = readFileSync(join(root, 'src/lib/book-read-job-control.ts'), 'utf8')

describe('read-step honest job states', () => {
  it('never answers the bare BOOK_READ_JOB_NOT_FOUND code', () => {
    expect(readStep.includes('BOOK_READ_JOB_NOT_FOUND')).toBe(false)
  })

  it('tells the admin a FAILED job must be restarted from the read button', () => {
    expect(readStep).toContain("latest?.status === 'FAILED'")
    expect(readStep).toContain('آخر محاولة لقراءة هذا الكتاب فشلت')
    expect(readStep).toContain('status: 409')
  })

  it('treats a step call after completion as an already-completed skip', () => {
    expect(readStep).toContain("latest?.status === 'COMPLETED'")
    expect(readStep).toContain("skipped: 'ALREADY_COMPLETED'")
  })
})

describe('four-way failure handling in the read-step route', () => {
  it('classifies step failures instead of a binary transient check', () => {
    expect(readStep).toContain('classifyBookReadFailure')
    expect(jobControl).toContain('export function classifyBookReadFailure')
  })

  it('stops with a clear operator message on proven billing exhaustion', () => {
    expect(readStep).toContain("kind === 'BILLING'")
    expect(readStep).toContain('نفد رصيد جميع المزودين المتاحين')
  })

  it('stops with a settings message when no provider is configured', () => {
    expect(readStep).toContain("kind === 'CONFIG'")
    expect(readStep).toContain('خطأ إعدادات')
  })

  it('keeps the strict billing rule: any non-balance skip downgrades the verdict', () => {
    expect(jobControl).toContain("skipReasons.every((reason) => reason === 'NO_BALANCE')")
    expect(jobControl).toContain('if (skipReasons.length > 0) return \'TRANSIENT\'')
  })
})

describe('router error names skipped candidates', () => {
  it('collects skip notes with fixed reason codes', () => {
    expect(textAi).toContain('const noteSkip = ')
    expect(textAi).toContain("noteSkip(provider, model, 'NO_BALANCE')")
    expect(textAi).toContain("noteSkip(provider, model, 'COOLDOWN_KEY')")
    expect(textAi).toContain("noteSkip(provider, model, 'COOLDOWN_MODEL')")
    expect(textAi).toContain("noteSkip(provider, model, 'MODEL_DEAD')")
  })

  it('appends the skipped list to the final router error', () => {
    expect(textAi).toContain('|| تخطّى: ${skipNotes.join(')
    expect(textAi).toContain("errors.join(' | ') || 'TEXT_AI_ROUTER_FAILED'")
  })
})
