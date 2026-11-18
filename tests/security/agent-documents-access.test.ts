// حارس وصول وثائق الوكالة والاعتماد (فحص 2026-11-18):
// إضافة «agent-documents/» للبادئات الخاصة وحدها كانت ستقفل الباب على
// صاحب الطلب نفسه — سياسة الوصول هنا هي التي تثبت الملكية، بـ userId
// أولاً وبالبريد للطلبات التاريخية بلا userId — والبريد لا يُقبل إلا إذا
// كان userId فارغاً: طلب جديد بـ userId مختلف لا يفتحه البريد وحده (شرط 2026-11-18).
import { describe, expect, test, mock } from 'bun:test'

// عميل Prisma في الصندوق الرملي قديم ولا يُحمَّل — نفس نمط بقية
// الاختبارات: اعتراضه واعتراض @/lib/db قبل استيراد الوحدات تحت الفحص.
mock.module('@/lib/db', () => ({ db: {} }))
mock.module('@prisma/client', () => ({ Prisma: {} }))

const { canAccessStorageKeyWithClient } = await import('@/lib/file-access-policy')
const { collectPrivateFileCandidates } = await import('@/lib/private-files-maintenance')

const AGENT_KEY = 'agent-documents/id/2026-11-18/abc-id.png'

function makeClient(agentDoc: any) {
  const none = { findFirst: async () => null }
  return {
    admissionDocument: none,
    serviceDeliverable: none,
    paymentProof: none,
    assignmentSubmission: none,
    thesisSubmission: none,
    agentDocument: { findFirst: async () => agentDoc },
  }
}

describe('وصول صاحب وثيقة الوكالة والاعتماد', () => {
  test('صاحب الطلب بـ userId يفتح وثيقته', async () => {
    const client = makeClient({ agent: { userId: 'u1', email: 'rep@test.com' } })
    expect(await canAccessStorageKeyWithClient(client as any, AGENT_KEY, { id: 'u1', email: 'other@test.com', role: 'STUDENT' })).toBe(true)
  })

  test('صاحب الطلب بالبريد يفتح وثيقته (طلب تاريخي بلا userId)', async () => {
    const client = makeClient({ agent: { userId: null, email: 'rep@test.com' } })
    expect(await canAccessStorageKeyWithClient(client as any, AGENT_KEY, { id: 'u2', email: 'rep@test.com', role: 'VISITOR' })).toBe(true)
  })

  test('شخص غريب لا يفتح وثيقة غيره', async () => {
    const client = makeClient({ agent: { userId: 'u1', email: 'rep@test.com' } })
    expect(await canAccessStorageKeyWithClient(client as any, AGENT_KEY, { id: 'u9', email: 'stranger@test.com', role: 'STUDENT' })).toBe(false)
  })

  test('نفس البريد مع userId مختلف لا يفتح الوثيقة (البريد للطلبات التاريخية بلا userId فقط)', async () => {
    const client = makeClient({ agent: { userId: 'u1', email: 'rep@test.com' } })
    expect(await canAccessStorageKeyWithClient(client as any, AGENT_KEY, { id: 'u9', email: 'rep@test.com', role: 'STUDENT' })).toBe(false)
  })

  test('الإدارة تفتح أي وثيقة', async () => {
    const client = makeClient(null)
    expect(await canAccessStorageKeyWithClient(client as any, AGENT_KEY, { id: 'admin1', email: 'admin@aact.academy', role: 'ADMIN' })).toBe(true)
  })
})

describe('جرد الصيانة يشمل وثائق الوكالة والاعتماد', () => {
  test('collectPrivateFileCandidates يلتقط AgentDocument', async () => {
    const empty = { findMany: async () => [] }
    const db: any = {
      admissionDocument: { findMany: async () => [{ id: 'adm1', storageKey: 'admissions/r1/id.pdf', fileUrl: '' }] },
      paymentProof: empty,
      assignmentSubmission: empty,
      thesisSubmission: empty,
      serviceDeliverable: empty,
      agentDocument: { findMany: async () => [{ id: 'agd1', storageKey: AGENT_KEY, fileUrl: '' }] },
    }
    const rows = await collectPrivateFileCandidates(db)
    const agent = rows.find((r) => r.source === 'AgentDocument')
    expect(agent).toBeTruthy()
    expect(agent!.id).toBe('agd1')
    expect(agent!.key).toBe(AGENT_KEY)
    expect(agent!.storageField).toBe('storageKey')
    expect(agent!.hasStorageKey).toBe(true)
    expect(rows.some((r) => r.source === 'AdmissionDocument')).toBe(true)
  })
})
