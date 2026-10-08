import assert from 'node:assert/strict'
import { planBookOutline, tocFromChunks } from '../src/lib/book-outline'

const chunks = Array.from({ length: 12 }, (_, index) => ({
  index, headingPath: null as string | null,
  text: index === 0 ? 'المحتويات\nالفصل الأول ........ 2\nالفصل الثاني ........ 5\nالفصل الثالث ........ 8\nالفصل الرابع ........ 11' : `نص الفصل ${index}`,
  pageStart: index + 1, pageEnd: index + 1,
}))
const ids = new Map(chunks.map((chunk) => [chunk.index, `chunk-${chunk.index}`]))
const items = chunks.map((chunk) => ({ chunkId: `chunk-${chunk.index}`, title: `عنصر ${chunk.index}`, summary: 'عنصر موثق' }))
const toc = tocFromChunks(chunks)
assert.equal(toc.length, 4)
const outline = planBookOutline(chunks, items, ids, 1)
assert.equal(outline.source, 'TOC')
// A one-chunk unlabeled preface is absorbed into the first real chapter.
assert.equal(outline.sections.length, 4)
assert.equal(outline.sections[0].title, 'الفصل الأول')
assert.equal(outline.sections[0].chunkStartIndex, 0)
assert.equal(outline.sections[0].chunkEndIndex, 3)
assert.deepEqual(outline.sections.slice(1).map((section) => section.chunkStartIndex), [4, 7, 10])
assert.equal(outline.sections.at(-1)?.chunkEndIndex, 11)
for (let i = 1; i < outline.sections.length; i++) {
  assert.equal(outline.sections[i].chunkStartIndex, outline.sections[i - 1].chunkEndIndex + 1, 'no gaps or overlap')
}
assert.equal(outline.sections.reduce((sum, section) => sum + section.itemsCount, 0), 12)

const headingChunks = chunks.map((chunk) => ({ ...chunk, text: 'نص', headingPath: chunk.index < 6 ? `الفصل ${chunk.index + 1}` : null }))
const headed = planBookOutline(headingChunks, items, ids, 2)
assert.equal(headed.source, 'HEADINGS')
assert.ok(headed.sections.length < 6, 'tiny single-chunk sections should merge')
assert.equal(headed.sections[0].chunkStartIndex, 0)
assert.equal(headed.sections.at(-1)?.chunkEndIndex, 11)
const tenChunks = Array.from({ length: 10 }, (_, index) => ({ index, pageStart: index + 1, pageEnd: index + 1, text: 'محتوى', headingPath: index < 3 ? 'الفصل الأول' : index < 7 ? 'الفصل الثاني' : 'الفصل الثالث' }))
const tenIds = new Map(tenChunks.map((chunk) => [chunk.index, `ten-${chunk.index}`]))
const tenItems = tenChunks.map((chunk) => ({ chunkId: `ten-${chunk.index}`, title: 'معرفة', summary: 'ملخص' }))
const three = planBookOutline(tenChunks, tenItems, tenIds, 1)
assert.equal(three.source, 'HEADINGS')
assert.deepEqual(three.sections.map((section) => section.title), ['الفصل الأول', 'الفصل الثاني', 'الفصل الثالث'])
assert.deepEqual(three.sections.map((section) => [section.chunkStartIndex, section.chunkEndIndex]), [[0, 2], [3, 6], [7, 9]])

const titled = tenChunks.map((chunk) => ({ ...chunk, headingPath: `الإسعافات الأولية النفسية > ${chunk.headingPath} > المبحث الأول` }))
const withoutBookHeader = planBookOutline(titled, tenItems, tenIds, 1, [], 'الإسعافات الأولية النفسية')
assert.equal(withoutBookHeader.source, 'HEADINGS')
assert.ok(withoutBookHeader.sections.every((section) => section.title !== 'الإسعافات الأولية النفسية'))
assert.deepEqual(withoutBookHeader.sections.map((section) => section.title), ['الفصل الأول', 'الفصل الثاني', 'الفصل الثالث'])

const recurring = tenChunks.map((chunk) => ({ ...chunk, headingPath: chunk.index === 5 ? 'الفصل الأول' : chunk.headingPath }))
const noDuplicate = planBookOutline(recurring, tenItems, tenIds, 1)
assert.deepEqual(noDuplicate.sections.map((section) => section.title), ['الفصل الأول', 'الفصل الثاني', 'الفصل الثالث'])
assert.equal(noDuplicate.sections.reduce((sum, section) => sum + section.itemsCount, 0), 10)
console.log('book outline tests passed')
