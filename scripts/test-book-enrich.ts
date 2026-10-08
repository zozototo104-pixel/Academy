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
      if (items.length) { persisted.push(...items.map(({ title, summary }) => ({ title, summary }))); passes++ }
      else saturatedAt = new Date()
    },
    finish: async () => {},
  }
  const result = await enrichStepWithStore('job', Date.now() + 30000, store, async () => produced)
  return { result, persisted, added, saturated: Boolean(saturatedAt), passes }
}

async function main() {
  const duplicate = await scenario([candidate.title], [candidate])
  assert.equal(duplicate.added, 0, 'same-chunk Jaccard duplicate rejected')
  assert.ok(duplicate.saturatedAt instanceof Date, 'zero new items saturates the chunk')
  assert.deepEqual(duplicate.persisted.map((item) => item.title), [candidate.title], 'existing item never deleted')

  const accepted = await scenario(['معلومة قديمة'], [candidate])
  assert.equal(accepted.added, 1)
  assert.deepEqual(accepted.persisted.map((item) => item.title), ['معلومة قديمة', candidate.title], 'new knowledge appended')

  const full = await scenario(Array.from({ length: 20 }, (_, index) => `معلومة سابقة ${index}`), [candidate])
  assert.equal(full.added, 0, '20-item cap respected')
  assert.equal(full.persisted.length, 20)
  assert.ok(full.saturatedAt instanceof Date)
  console.log('book enrichment behavior tests passed')
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
