// Two-mode book repair button — the loop driver (plan §3) + source pins
// for the AdminBooks glue (this repo has no DOM test infra — component
// tests are source pins, same as student-zoom-embed-hang.test.ts).
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'

let apiCalls: Array<{ url: string; init?: unknown }> = []
let apiScript: unknown[] = []

mock.module('@/lib/store', () => ({
  api: async (url: string, init?: unknown) => {
    apiCalls.push({ url, init })
    const next = apiScript.shift()
    if (next instanceof Error) throw next
    return next
  },
  useAppStore: () => ({ user: null }),
}))

const { runBookRepairScanFlow, BOOK_REPAIR_COMPLETE_PAUSE_MS } = await import('@/lib/book-repair-scan-flow')

const counters = (overrides: Record<string, number> = {}) => ({
  chunksCorrected: 1, chunksNeedsReview: 0, chunksRemaining: 3,
  itemsCorrected: 0, itemsNeedsReview: 0, itemsRemaining: 0, ...overrides,
})

const step = (overrides: Record<string, unknown> = {}) => ({
  job: { status: 'RUNNING' },
  counters: counters(),
  done: false,
  processedChunks: 1,
  ...overrides,
})

const run = (options: Record<string, unknown>) => runBookRepairScanFlow({
  mode: 'complete',
  bookId: 'book-1',
  shouldStop: () => false,
  onStep: () => {},
  reassertStop: async () => {},
  sleep: async () => {},
  pauseMs: 0,
  ...options,
} as Parameters<typeof runBookRepairScanFlow>[0])

describe('book repair scan flow driver', () => {
  beforeEach(() => {
    apiCalls = []
    apiScript = []
  })

  test('batch mode runs exactly one step and reports more-work', async () => {
    apiScript = [step()]
    const onStepCalls: unknown[] = []
    const result = await run({ mode: 'batch', onStep: (s: unknown) => { onStepCalls.push(s) } })
    expect(apiCalls.length).toBe(1)
    expect(apiCalls[0].url).toBe('/api/admin/books/book-1/repair-corrupt-pages')
    expect((apiCalls[0].init as { body?: string }).body).toBe('{"mode":"SCAN"}')
    expect(result.outcome).toBe('more-work')
    expect(result.steps).toBe(1)
    expect(onStepCalls.length).toBe(1)
  })

  test('complete mode loops until done', async () => {
    apiScript = [step(), step(), step({ done: true, counters: counters({ chunksRemaining: 0 }) })]
    const onStepCalls: unknown[] = []
    const result = await run({ onStep: (s: unknown) => { onStepCalls.push(s) } })
    expect(apiCalls.length).toBe(3)
    expect(result.outcome).toBe('done')
    expect(result.steps).toBe(3)
    expect(onStepCalls.length).toBe(3)
    expect((result.lastStep as { done: boolean }).done).toBe(true)
  })

  test('stop requested mid-loop halts and re-asserts STOP once', async () => {
    apiScript = [step(), step(), step({ done: true })]
    let stop = false
    let reasserts = 0
    const result = await run({
      shouldStop: () => stop,
      onStep: () => { if (apiCalls.length === 2) stop = true },
      reassertStop: async () => { reasserts += 1 },
    })
    expect(apiCalls.length).toBe(2)
    expect(result.outcome).toBe('stopped')
    expect(result.steps).toBe(2)
    expect(reasserts).toBe(1)
  })

  test('stop before the first step makes no call and no re-assert', async () => {
    apiScript = [step({ done: true })]
    let reasserts = 0
    const result = await run({ shouldStop: () => true, reassertStop: async () => { reasserts += 1 } })
    expect(apiCalls.length).toBe(0)
    expect(result.outcome).toBe('stopped')
    expect(result.steps).toBe(0)
    expect(reasserts).toBe(0)
  })

  test('error mid-loop preserves the error and does not re-assert STOP', async () => {
    apiScript = [step(), new Error('boom')]
    let reasserts = 0
    const result = await run({ reassertStop: async () => { reasserts += 1 } })
    expect(apiCalls.length).toBe(2)
    expect(result.outcome).toBe('error')
    expect((result.error as Error).message).toBe('boom')
    expect(reasserts).toBe(0)
  })

  test('409 read-job conflict stops quietly without re-asserting STOP', async () => {
    apiScript = [step(), new Error('BOOK_REPAIR_JOB_ACTIVE')]
    let reasserts = 0
    const result = await run({ reassertStop: async () => { reasserts += 1 } })
    expect(apiCalls.length).toBe(2)
    expect(result.outcome).toBe('conflict')
    expect(reasserts).toBe(0)
  })

  test('a PAUSED job halts the loop and re-asserts STOP once', async () => {
    apiScript = [step({ job: { status: 'PAUSED' } })]
    let reasserts = 0
    const result = await run({ reassertStop: async () => { reasserts += 1 } })
    expect(apiCalls.length).toBe(1)
    expect(result.outcome).toBe('stopped')
    expect(result.steps).toBe(1)
    expect(reasserts).toBe(1)
  })

  test('pause between complete-mode steps uses the 1s default', async () => {
    apiScript = [step(), step(), step({ done: true })]
    const sleeps: number[] = []
    const result = await run({ pauseMs: 50, sleep: async (ms: number) => { sleeps.push(ms) } })
    expect(result.outcome).toBe('done')
    expect(sleeps).toEqual([50, 50])
    expect(BOOK_REPAIR_COMPLETE_PAUSE_MS).toBe(1000)
  })
})

describe('two-mode repair button wiring (source pins)', () => {
  const SOURCE = readFileSync('src/components/aact/AdminBooks.tsx', 'utf8')

  test('the choice dialog offers both modes', () => {
    expect(SOURCE).toContain('إكمال المهمة كاملة')
    expect(SOURCE).toContain('أربعة أربعة')
    expect(SOURCE).toContain('const choice = await askAdminChoice({')
    expect(SOURCE).toContain("import { runBookRepairScanFlow } from '@/lib/book-repair-scan-flow'")
    expect(SOURCE).toContain("mode: 'complete'")
  })

  test('STOP during a complete run sets the driver flag', () => {
    expect(SOURCE).toContain("if (action === 'STOP') bookRepairCompleteStopRef.current[bookId] = true")
    expect(SOURCE).toContain('shouldStop: () => bookRepairCompleteStopRef.current[bookId] === true')
  })

  test('the STOP button stays enabled during a complete run', () => {
    expect(SOURCE).toContain('disabled={bookReadBusyId === b.id && bookRepairCompleteRunningId !== b.id}')
    expect(SOURCE).toContain('disabled={bookReadBusyId === b.id || bookRepairCompleteRunningId === b.id || unfinishedRead')
  })

  test('the four-by-four toast text is unchanged', () => {
    expect(SOURCE).toContain('اضغط الزر مجدداً للمتابعة من حيث توقف.')
  })
})
