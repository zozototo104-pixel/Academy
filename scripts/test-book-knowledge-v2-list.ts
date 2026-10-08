import assert from 'node:assert/strict'
import { db } from '../src/lib/db'
import { getProgramKnowledgeItems } from '../src/lib/knowledge-bank'

const now = new Date('2026-01-01T00:00:00Z')
const rows = Array.from({ length: 91 }, (_, i) => ({
  id: `v2-${i}`, bookId: 'book-91', programId: 'program-91', semester: 1,
  category: 'CONCEPT', kbVersion: 2, title: `مفهوم ${i + 1}`,
  summary: `مفهوم أكاديمي موثق من النص الأصلي للكتاب رقم ${i + 1}`,
  excerpt: 'هذا مقتطف موثق حرفياً من نص الكتاب المستخدم في التحقق من المفهوم الأكاديمي.',
  keywords: '[]', importance: 75, sourceNote: null, pageStart: 1, pageEnd: 1,
  textProvenance: 'NATIVE_TEXT', createdAt: now, updatedAt: now,
  book: { title: 'كتاب الاختبار', titleEn: null, semester: 1 },
}))

async function main() {
  const original = db.bookKnowledgeItem.findMany
  try {
    // Intercept only the read method; no database connection or writes are required.
    ;(db.bookKnowledgeItem as any).findMany = async (args: any) => args.where?.kbVersion === 2 ? rows : []
    const items = await getProgramKnowledgeItems('program-91', 1, 80)
    assert.equal(items.filter((item) => item.bookId === 'book-91' && item.kbVersion === 2).length, 91,
      'all 91 validated v2 items must survive legacy limit and broken-output filtering')
    console.log('91 v2 knowledge items returned without truncation')
  } finally {
    ;(db.bookKnowledgeItem as any).findMany = original
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
