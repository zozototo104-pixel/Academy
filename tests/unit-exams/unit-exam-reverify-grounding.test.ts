import { describe, expect, test, mock } from 'bun:test'
import { NextRequest } from 'next/server'
import { readFileSync } from 'node:fs'

// Guard for the crisis-diploma stuck units (2026-10-25): 28 APPROVED
// questions, 0 SOURCE_GROUNDED, so the exam builder refused with
// "0 of 20" while the UI said complete. The reverify endpoint must stamp
// ONLY the questions the existing verifier confirms against original book
// text — never the ones without a source, without generator provenance,
// or with OCR provenance (which can never carry the stamp by construction).

const updateCalls: any[] = []
const prov = JSON.stringify({ aiProvenance: { provider: 'GROQ', model: 'llama-3' } })
const CHUNK_TEXT = 'original book chunk text that is long enough to pass the forty character threshold for verification'

const bankItems = [
  { id: 'q-pass', knowledgeItemId: 'k1', text: 'PASS question', type: 'MCQ', options: '["a","b"]', correctAnswer: '0', modelAnswer: null, sourceEvidence: 'evidence', qualityFlags: '["SOURCE_LINKED"]', reviewNotes: prov },
  { id: 'q-reject', knowledgeItemId: 'k1', text: 'REJECT question', type: 'MCQ', options: '["a","b"]', correctAnswer: '0', modelAnswer: null, sourceEvidence: 'evidence', qualityFlags: '["SOURCE_LINKED"]', reviewNotes: prov },
  { id: 'q-nosource', knowledgeItemId: null, text: 'NOSOURCE question', type: 'MCQ', options: '["a","b"]', correctAnswer: '0', modelAnswer: null, sourceEvidence: 'evidence', qualityFlags: null, reviewNotes: prov },
  { id: 'q-noprov', knowledgeItemId: 'k1', text: 'NOPROV question', type: 'MCQ', options: '["a","b"]', correctAnswer: '0', modelAnswer: null, sourceEvidence: 'evidence', qualityFlags: null, reviewNotes: '{}' },
  { id: 'q-ocr', knowledgeItemId: 'k2', text: 'OCR question', type: 'MCQ', options: '["a","b"]', correctAnswer: '0', modelAnswer: null, sourceEvidence: 'evidence', qualityFlags: null, reviewNotes: prov },
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
      ],
    },
    bookChunk: {
      findMany: async () => [{ id: 'c1', index: 3, pageStart: 10, pageEnd: 10, text: CHUNK_TEXT }],
    },
  },
}))
mock.module('@/lib/auth', () => ({ requireAdmin: async () => ({ id: 'admin-1', name: 'Admin' }) }))
mock.module('@/lib/notify', () => ({ audit: async () => undefined }))
mock.module('@/lib/question-verifier', () => ({
  verifyQuestionsWithCrossProvider: async ({ questions }: any) =>
    questions.map((q: any) =>
      String(q.text || '').includes('PASS')
        ? { ...q, qualityFlags: [...(q.qualityFlags || []), 'SOURCE_GROUNDED'], verifierProvider: 'GROQ', verifierModel: 'verifier-m', verifierReason: 'supported', verifiedAt: '2026-10-25T00:00:00.000Z' }
        : { ...q, verifierReason: 'not supported by source' },
    ),
}))

describe('unit exam reverify grounding', () => {
  test('stamps only verifier-passed items; skips sourceless, provenance-less and OCR items', async () => {
    const { POST } = await import('@/app/api/admin/units/[id]/questions/reverify-grounding/route')
    const res = await POST(new NextRequest('http://localhost/api/admin/units/u1/questions/reverify-grounding', { method: 'POST' }), {
      params: Promise.resolve({ id: 'u1' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.stamped).toBe(1)
    expect(body.rejected).toBe(1)
    expect(body.skipped).toBe(3)
    expect(body.skippedNoSource).toBe(1)
    expect(body.skippedNoProvenance).toBe(1)
    expect(body.skippedOcr).toBe(1)
    expect(body.remaining).toBe(0)
    const byId = new Map(updateCalls.map((call) => [call.where.id, call.data]))
    // Passed: stamped, other flags preserved.
    expect(String(byId.get('q-pass')?.qualityFlags || '')).toContain('SOURCE_GROUNDED')
    expect(String(byId.get('q-pass')?.qualityFlags || '')).toContain('SOURCE_LINKED')
    // Rejected: reason recorded, but never stamped.
    expect(String(byId.get('q-reject')?.qualityFlags || '')).not.toContain('SOURCE_GROUNDED')
    expect(String(byId.get('q-reject')?.reviewNotes || '')).toContain('not supported by source')
    // Skipped items are never written at all.
    expect(byId.has('q-nosource')).toBe(false)
    expect(byId.has('q-noprov')).toBe(false)
    expect(byId.has('q-ocr')).toBe(false)
  })

  test('the admin UI offers reverify, gated on ungrounded approved questions', () => {
    const adminUi = readFileSync('src/components/aact/AdminBooks.tsx', 'utf8')
    expect(adminUi).toContain('/questions/reverify-grounding')
    expect(adminUi).toContain('إعادة تحقق من')
    expect(adminUi).toContain('ungroundedApproved')
  })
})
