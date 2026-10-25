import { describe, expect, test, mock } from 'bun:test'
import { NextRequest } from 'next/server'
import { readFileSync } from 'node:fs'

// Guard for the crisis-diploma stuck units (2026-10-25): 28 APPROVED
// questions, 0 SOURCE_GROUNDED, so the exam builder refused with
// "0 of 20" while the UI said complete. The reverify endpoint must stamp
// ONLY the questions the existing AI verifier confirms against original
// book text — never the ones without a source, without generator
// provenance, or with OCR provenance (which can never carry the stamp by
// construction). The AI verifier is the sole stamping authority; the
// classification here only decides what may be SENT to it.
//
// Regression (2026-10-25-g, production report): v1 took the FIRST 10
// ungrounded items per press, so a batch of only-skipped items never
// changed anything and every press repeated the same 10 forever
// ("stamped 0 · skipped 10 · remaining 18", identical on re-press).
// v2 classifies ALL ungrounded items first and sends up to 10 VERIFIABLE
// items per press, so skipped items never consume a batch slot.

const updateCalls: any[] = []
const prov = JSON.stringify({ aiProvenance: { provider: 'GROQ', model: 'llama-3' } })
const CHUNK_TEXT = 'original book chunk text that is long enough to pass the forty character threshold for verification'

function verifiableItem(id: string, text: string) {
  return { id, knowledgeItemId: 'k1', text, type: 'MCQ', options: '["a","b"]', correctAnswer: '0', modelAnswer: null, sourceEvidence: 'evidence', qualityFlags: '["SOURCE_LINKED"]', reviewNotes: prov }
}

let bankItems: any[] = [
  verifiableItem('q-pass', 'PASS question'),
  verifiableItem('q-reject', 'REJECT question'),
  { id: 'q-ocr-pass', knowledgeItemId: 'k3', text: 'PASS OCR question', type: 'MCQ', options: '["a","b"]', correctAnswer: '0', modelAnswer: null, sourceEvidence: 'evidence', qualityFlags: '["SOURCE_LINKED","OCR_DERIVED_SOURCE","NEEDS_HUMAN_REVIEW"]', reviewNotes: prov },
  { id: 'q-nosource', knowledgeItemId: null, text: 'NOSOURCE question', type: 'MCQ', options: '["a","b"]', correctAnswer: '0', modelAnswer: null, sourceEvidence: 'evidence', qualityFlags: null, reviewNotes: prov },
  { id: 'q-noprov', knowledgeItemId: 'k1', text: 'NOPROV question', type: 'MCQ', options: '["a","b"]', correctAnswer: '0', modelAnswer: null, sourceEvidence: 'evidence', qualityFlags: null, reviewNotes: '{}' },
]

mock.module('@/lib/db', () => ({
  db: {
    unit: { findUnique: async () => ({ id: 'u1', title: 'Unit', programId: 'p1' }) },
    questionBankItem: {
      findMany: async () => bankItems,
      update: async (args: any) => {
        updateCalls.push(args)
        return {}
      },
    },
    bookKnowledgeItem: {
      findMany: async () => [
        { id: 'k1', chunkId: 'c1', summary: 's', excerpt: 'e', textProvenance: null },
        { id: 'k2', chunkId: null, summary: 's', excerpt: 'e', textProvenance: 'VISION_OCR' },
        { id: 'k3', chunkId: 'c3', summary: 's', excerpt: 'e', textProvenance: 'VISION_OCR' },
      ],
    },
    bookChunk: {
      findMany: async () => [
        { id: 'c1', index: 3, pageStart: 10, pageEnd: 10, text: CHUNK_TEXT },
        { id: 'c3', index: 5, pageStart: 81, pageEnd: 87, text: CHUNK_TEXT },
      ],
    },
  },
}))
mock.module('@/lib/auth', () => ({ requireAdmin: async () => ({ id: 'admin-1', name: 'Admin' }) }))
mock.module('@/lib/notify', () => ({ audit: async () => undefined }))
// Faithful mock of the real verifier's OCR branch: an OCR question is
// stripped UNLESS the caller passes allowOcrGrounding (reverify only).
let lastVerifierOpts: any = null
mock.module('@/lib/question-verifier', () => ({
  verifyQuestionsWithCrossProvider: async (opts: any) => {
    lastVerifierOpts = opts
    return opts.questions.map((q: any) => {
      if (!String(q.text || '').includes('PASS')) return { ...q, verifierReason: 'not supported by source' }
      if (q.textProvenance === 'VISION_OCR' && !opts.allowOcrGrounding) {
        return { ...q, qualityFlags: ['SOURCE_LINKED', 'OCR_DERIVED_SOURCE', 'NEEDS_HUMAN_REVIEW'], verifierProvider: 'GROQ', verifierModel: 'verifier-m', verifierReason: 'supported', verifiedAt: '2026-10-25T00:00:00.000Z' }
      }
      return { ...q, qualityFlags: [...(q.qualityFlags || []), 'SOURCE_GROUNDED', ...(q.textProvenance === 'VISION_OCR' ? ['OCR_DERIVED_SOURCE'] : [])], verifierProvider: 'GROQ', verifierModel: 'verifier-m', verifierReason: 'supported', verifiedAt: '2026-10-25T00:00:00.000Z' }
    })
  },
}))

async function callReverify() {
  const { POST } = await import('@/app/api/admin/units/[id]/questions/reverify-grounding/route')
  const res = await POST(new NextRequest('http://localhost/api/admin/units/u1/questions/reverify-grounding', { method: 'POST' }), {
    params: Promise.resolve({ id: 'u1' }),
  })
  expect(res.status).toBe(200)
  return res.json()
}

describe('unit exam reverify grounding', () => {
  test('stamps only verifier-passed items; OCR items stamp only via the reverify allowance, marker kept', async () => {
    const mark = updateCalls.length
    const body = await callReverify()
    expect(body.total).toBe(5)
    expect(body.verifiableTotal).toBe(3)
    expect(body.processed).toBe(3)
    expect(body.stamped).toBe(2)
    expect(body.rejected).toBe(1)
    expect(body.skipped).toBe(2)
    expect(body.skippedNoSource).toBe(1)
    expect(body.skippedNoProvenance).toBe(1)
    expect(body.skippedOcr).toBe(0)
    expect(body.alreadyRechecked).toBe(0)
    expect(body.verifiableRemaining).toBe(0)
    expect(body.remaining).toBe(0)
    // The endpoint must pass the OCR allowance AND the source provenance
    // to the verifier; without either, the OCR item would be stripped.
    expect(lastVerifierOpts.allowOcrGrounding).toBe(true)
    expect(lastVerifierOpts.questions.find((q: any) => String(q.text || '').includes('OCR'))?.textProvenance).toBe('VISION_OCR')
    const byId = new Map(updateCalls.slice(mark).map((call) => [call.where.id, call.data]))
    // Passed: stamped, other flags preserved.
    expect(String(byId.get('q-pass')?.qualityFlags || '')).toContain('SOURCE_GROUNDED')
    expect(String(byId.get('q-pass')?.qualityFlags || '')).toContain('SOURCE_LINKED')
    // OCR passed: stamped AND the OCR marker kept next to the stamp.
    expect(String(byId.get('q-ocr-pass')?.qualityFlags || '')).toContain('SOURCE_GROUNDED')
    expect(String(byId.get('q-ocr-pass')?.qualityFlags || '')).toContain('OCR_DERIVED_SOURCE')
    // Rejected: reason recorded + reverify marker, but never stamped.
    expect(String(byId.get('q-reject')?.qualityFlags || '')).not.toContain('SOURCE_GROUNDED')
    expect(String(byId.get('q-reject')?.reviewNotes || '')).toContain('not supported by source')
    expect(String(byId.get('q-reject')?.reviewNotes || '')).toContain('reverify')
    // Skipped items are never written at all.
    expect(byId.has('q-nosource')).toBe(false)
    expect(byId.has('q-noprov')).toBe(false)
  })

  test('skipped items first must not starve verifiable items (the production loop)', async () => {
    // 10 skipped items BEFORE the 2 verifiable ones: v1 processed only the
    // first 10 (all skipped) and verified nothing, forever.
    bankItems = [
      ...Array.from({ length: 10 }, (_, i) => ({ id: `q-skip-${i}`, knowledgeItemId: 'k1', text: `SKIP question ${i}`, type: 'MCQ', options: '["a","b"]', correctAnswer: '0', modelAnswer: null, sourceEvidence: 'evidence', qualityFlags: null, reviewNotes: '{}' })),
      verifiableItem('q-pass', 'PASS question'),
      verifiableItem('q-reject', 'REJECT question'),
    ]
    const mark = updateCalls.length
    const body = await callReverify()
    expect(body.total).toBe(12)
    expect(body.verifiableTotal).toBe(2)
    expect(body.processed).toBe(2)
    expect(body.stamped).toBe(1)
    expect(body.rejected).toBe(1)
    expect(body.skipped).toBe(10)
    expect(body.skippedNoProvenance).toBe(10)
    expect(body.verifiableRemaining).toBe(0)
    const writtenIds = updateCalls.slice(mark).map((call) => call.where.id)
    expect(writtenIds.sort()).toEqual(['q-pass', 'q-reject'])
  })

  test('items already rejected by an earlier reverify press are terminal, not re-sent', async () => {
    bankItems = [
      { id: 'q-old-reject', knowledgeItemId: 'k1', text: 'OLD question', type: 'MCQ', options: '["a","b"]', correctAnswer: '0', modelAnswer: null, sourceEvidence: 'evidence', qualityFlags: '["SOURCE_LINKED"]', reviewNotes: JSON.stringify({ aiProvenance: { provider: 'GROQ', model: 'llama-3' }, verifier: { source: 'reverify', reason: 'not supported by source' } }) },
      verifiableItem('q-pass', 'PASS question'),
    ]
    const mark = updateCalls.length
    const body = await callReverify()
    expect(body.total).toBe(2)
    expect(body.alreadyRechecked).toBe(1)
    expect(body.verifiableTotal).toBe(1)
    expect(body.processed).toBe(1)
    expect(body.stamped).toBe(1)
    expect(body.verifiableRemaining).toBe(0)
    expect(updateCalls.slice(mark).map((call) => call.where.id)).toEqual(['q-pass'])
  })

  test('the admin UI offers reverify, shows the skip breakdown, and hides the button when nothing verifiable remains', () => {
    const adminUi = readFileSync('src/components/aact/AdminBooks.tsx', 'utf8')
    expect(adminUi).toContain('/questions/reverify-grounding')
    expect(adminUi).toContain('إعادة تحقق من')
    expect(adminUi).toContain('ungroundedApproved')
    expect(adminUi).toContain('verifiableRemaining')
    expect(adminUi).toContain('unitReverifyExhausted')
    expect(adminUi).toContain('بلا مصدر')
    expect(adminUi).toContain('سبق رفضه')
    // The old "approve fresh questions, they are stamped" guidance was
    // wrong for OCR books (fresh OCR questions are stripped too); the
    // box must now say OCR is covered by this button after approval.
    expect(adminUi).toContain('مشمولة بالتحقق')
    expect(adminUi).not.toContain('فهي مختومة من التوليد')
  })
})
