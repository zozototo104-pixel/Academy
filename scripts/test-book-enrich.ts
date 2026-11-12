import assert from 'node:assert/strict'
import { enrichStepWithStore, type EnrichStepStore, type BookKnowledgeCandidate } from '../src/lib/book-chunk-analyzer'

const evidence = 'يُعرّف المنهج الأكاديمي المفهوم بوصفه وحدة معرفية تساعد على تفسير الظواهر من خلال أدلة موثقة وملاحظات متكررة في سياقات تعليمية متعددة.'
const candidate: BookKnowledgeCandidate = { category: 'CONCEPT', title: 'المفهوم الأكاديمي', summary: 'وحدة معرفية لتفسير الظواهر', excerpt: evidence, importance: 70 }

async function scenario(existingTitles: string[], produced: BookKnowledgeCandidate[]) {
  const persisted = existingTitles.map((title) => ({ title, summary: candidate.summary }))
  let saturatedAt: Date | null = null
  let passes = 1
  let added = 0
  const store: EnrichStepStore = {
    getJob: async () => ({ id: 'job', bookId: 'book', phase: 'ENRICH' }),
    nextChunk: async () => ({ id: 'chunk', bookId: 'book', programId: 'program', index: 3, text: evidence, pageStart: 4, pageEnd: 4, textProvenance: 'NATIVE_TEXT', analysisPasses: passes }),
    existing: async () => ({ local: persisted, own: persisted }),
    save: async (_chunk, items) => {
      // Model append-only createMany: no removal or modification of previously persisted rows.
      added = items.length
      if (items.length) persisted.push(...items.map(({ title, summary }) => ({ title, summary })))
      if (persisted.length >= 20) saturatedAt = new Date()
      else passes++
    },
    finish: async () => {},
  }
  const result = await enrichStepWithStore('job', Date.now() + 30000, store, async () => produced)
  return { result, persisted, added, saturated: Boolean(saturatedAt), passes }
}

async function main() {
  const duplicate = await scenario([candidate.title], [candidate])
  assert.equal(duplicate.added, 0, 'same-chunk Jaccard duplicate rejected')
  assert.equal(duplicate.saturated, false, 'one zero-acceptance round must not saturate')
  assert.equal(duplicate.passes, 2, 'zero-acceptance round counts toward the three-round cap')
  assert.deepEqual(duplicate.persisted.map((item) => item.title), [candidate.title], 'existing item never deleted')

  const accepted = await scenario(['معلومة قديمة'], [candidate])
  assert.equal(accepted.added, 1)
  assert.deepEqual(accepted.persisted.map((item) => item.title), ['معلومة قديمة', candidate.title], 'new knowledge appended')

  const full = await scenario(Array.from({ length: 20 }, (_, index) => `معلومة سابقة ${index}`), [candidate])
  assert.equal(full.added, 0, '20-item cap respected')
  assert.equal(full.persisted.length, 20)
  assert.equal(full.saturated, true)
  // Three empty rounds exhaust eligibility without setting saturatedAt.
  let passes = 0
  let saved: { title: string; summary: string }[] = [{ title: candidate.title, summary: candidate.summary }]
  let finished = 0
  const store: EnrichStepStore = {
    getJob: async () => ({ id: 'job', bookId: 'book', phase: 'ENRICH' }),
    nextChunk: async () => passes < 3 ? ({ id: 'chunk', bookId: 'book', programId: 'program', index: 0, text: evidence, pageStart: 1, pageEnd: 1, textProvenance: 'NATIVE_TEXT', analysisPasses: passes }) : null,
    existing: async () => ({ own: saved, local: saved }),
    save: async (_chunk, items) => { saved = [...saved, ...items.map(({ title, summary }) => ({ title, summary }))]; passes++ },
    finish: async () => { finished++ },
  }
  for (let round = 0; round < 3; round++) {
    await enrichStepWithStore('job', Date.now() + 30000, store, async () => [candidate])
    assert.equal(passes, round + 1)
    assert.equal(finished, 0)
  }
  const exhausted = await enrichStepWithStore('job', Date.now() + 30000, store, async () => [candidate])
  assert.equal(exhausted.completed, true, 'three empty rounds exhaust enrichment eligibility')
  assert.equal(finished, 1)
  assert.equal(saved.length, 1, 'existing knowledge remains untouched after empty rounds')

  // An accepted result after an empty round proceeds normally.
  passes = 0; saved = [{ title: candidate.title, summary: candidate.summary }]; finished = 0
  await enrichStepWithStore('job', Date.now() + 30000, store, async () => [candidate])
  const fresh: BookKnowledgeCandidate = { ...candidate, title: 'تطبيق تربوي جديد', summary: 'تطبيق عملي مختلف ومستقل في التعليم' }
  const resumed = await enrichStepWithStore('job', Date.now() + 30000, store, async () => [fresh])
  assert.equal(resumed.added, 1, 'success after zero accepted continues')
  assert.equal(passes, 2)
  assert.equal(saved.length, 2)
  // An exhausted provider defers only its chunk; the next valid chunk can
  // still be enriched, and the previously saved knowledge is untouched.
  const deferredChunks: string[] = []
  const successfulChunks: string[] = []
  const chunks = ['bad', 'good']
  const isolatedStore: EnrichStepStore = {
    getJob: async () => ({ id: 'job', bookId: 'book', phase: 'ENRICH' }),
    nextChunk: async () => {
      const id = chunks.find((item) => !deferredChunks.includes(item) && !successfulChunks.includes(item))
      return id ? { id, bookId: 'book', programId: 'program', index: id === 'bad' ? 0 : 1, text: evidence, pageStart: 1, pageEnd: 1, textProvenance: 'NATIVE_TEXT', analysisPasses: 0 } : null
    },
    existing: async () => ({ own: [], local: [] }),
    defer: async (id, reason) => { assert.equal(reason, 'INVALID_JSON_RESPONSE'); deferredChunks.push(id) },
    save: async (chunk, items) => { successfulChunks.push(chunk.id); assert.equal(items.length, 1) },
    finish: async () => { throw new Error('deferred chunks are not complete') },
  }
  const firstFailure = await enrichStepWithStore('job', Date.now() + 30_000, isolatedStore, async () => { throw new Error('INVALID_JSON_RESPONSE') })
  assert.equal(firstFailure.completed, false)
  assert.equal(firstFailure.added, 0)
  assert.deepEqual(deferredChunks, ['bad'])
  const secondSuccess = await enrichStepWithStore('job', Date.now() + 30_000, isolatedStore, async () => [candidate])
  assert.equal(secondSuccess.added, 1)
  assert.deepEqual(successfulChunks, ['good'])
  assert.deepEqual(deferredChunks, ['bad'], 'failing chunk remains retryable')
  console.log('book enrichment behavior tests passed')
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
