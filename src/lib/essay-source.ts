import { db } from '@/lib/db'

// مصدر المقارنة لتصحيح الأسئلة المقالية.
//
// عنصر بنك المعرفة قد يحمل جزءًا فقط مما يقوله الكتاب: سؤال «اذكر اثنين
// من…» قد تكون إجابته في الكتاب ستة بنود بينما البنك التقط ثلاثة منها
// فقط — فلو قارنّا بالاقتباس وحده لحُسبت إجابة الطالب الصحيحة (من
// البنود التي لم يلتقطها البنك) خطأً. لذلك يقود نصّ المقطع المخزّن من
// الكتاب نفسه المصدرَ، وملخّص العنصر يؤطّره فقط، والاقتباس بديل عند
// غياب المقطع.
const ESSAY_SOURCE_MAX_CHARS = 12000

export async function buildEssaySourceMap(ids: ReadonlyArray<unknown>): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))]
  const map = new Map<string, string>()
  if (!unique.length) return map

  let items: Array<{ id: string; summary?: string | null; excerpt?: string | null; chunkId?: string | null }> = []
  try {
    items = await db.bookKnowledgeItem.findMany({
      where: { id: { in: unique } },
      select: { id: true, summary: true, excerpt: true, chunkId: true },
    })
  } catch {
    items = []
  }

  const chunkIds = [...new Set(items.map((item) => item.chunkId).filter((id): id is string => Boolean(id)))]
  const chunkTextById = new Map<string, string>()
  if (chunkIds.length && typeof (db as any).bookChunk?.findMany === 'function') {
    try {
      const chunks = await db.bookChunk.findMany({ where: { id: { in: chunkIds } }, select: { id: true, text: true } })
      for (const chunk of chunks) {
        if (chunk?.id) chunkTextById.set(chunk.id, chunk.text || '')
      }
    } catch {
      // يبقى الملخّص/الاقتباس بديلًا عند تعذّر قراءة المقاطع.
    }
  }

  for (const item of items) {
    const chunkText = item.chunkId ? (chunkTextById.get(item.chunkId) || '').trim() : ''
    const parts: string[] = []
    if (item.summary?.trim()) parts.push(item.summary.trim())
    if (chunkText) parts.push(chunkText)
    else if (item.excerpt?.trim()) parts.push(item.excerpt.trim())
    map.set(item.id, parts.join('\n\n').slice(0, ESSAY_SOURCE_MAX_CHARS))
  }
  return map
}
