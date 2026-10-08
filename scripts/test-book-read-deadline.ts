import assert from 'node:assert/strict'
import { analyzeStepWithStore, enrichStepWithStore, type AnalyzeStepStore, type EnrichStepStore } from '../src/lib/book-chunk-analyzer'

async function main() {
  let aiCalls = 0, saved = 0, failures = 0, completed = 0
  const knowledge = [{ title: 'مفهوم محفوظ', summary: 'معرفة سابقة لا تحذف' }]
  const analyzeStore: AnalyzeStepStore = {
    getJob: async () => ({ id: 'job', bookId: 'book', programId: 'program', phase: 'ANALYZE', status: 'RUNNING' }),
    nextChunk: async () => ({ id: 'chunk', bookId: 'book', programId: 'program', index: 12, text: 'نص مقطع لم يُحلل', pageStart: 12, pageEnd: 12, textProvenance: 'NATIVE_TEXT', attempts: 0 }),
    priorItems: async () => knowledge,
    saveAnalyzed: async () => { saved++ },
    saveFailure: async () => { failures++ },
    complete: async () => { completed++ },
  }
  const result = await analyzeStepWithStore('job', Date.now() + 5_000, analyzeStore, async () => { aiCalls++; return [] })
  assert.equal(aiCalls, 0, 'AI call must not start with less than 25 seconds')
  assert.equal(saved, 0, 'chunk must remain un-analyzed')
  assert.equal(failures, 0, 'deadline must not count as a failed chunk attempt')
  assert.equal(completed, 0)
  assert.equal(result.completed, false)
  assert.equal(knowledge.length, 1, 'existing knowledge must remain intact')

  let saturated = 0
  const enrichStore: EnrichStepStore = {
    getJob: async () => ({ id: 'job', bookId: 'book', phase: 'ENRICH' }),
    nextChunk: async () => ({ id: 'chunk', bookId: 'book', programId: 'program', index: 12, text: 'نص مقطع لم يُشبع', pageStart: 12, pageEnd: 12, textProvenance: 'NATIVE_TEXT', analysisPasses: 1 }),
    existing: async () => ({ local: knowledge, own: knowledge }),
    save: async () => { saturated++ },
    finish: async () => {},
  }
  const enriched = await enrichStepWithStore('job', Date.now() + 5_000, enrichStore, async () => { aiCalls++; return [] })
  assert.equal(aiCalls, 0)
  assert.equal(saturated, 0, 'chunk must not be marked saturated')
  assert.equal(enriched.completed, false)
  assert.equal(knowledge.length, 1)
  console.log('book read deadline guards passed')
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
