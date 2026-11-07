import { beforeEach, describe, expect, mock, test } from 'bun:test'

// Guard U11/M9: /api/ai/live-token must enforce the same AI-supervisor
// entitlement gate as /api/ai/gemini-live/session for STUDENT +
// SUPERVISOR purpose. DISCUSSION keeps its own (thesis) rules.

let currentUser: any = { id: 'stu-1', role: 'STUDENT', name: 'طالب' }
let supervisorLocked = true
let tokensMinted = 0
let reservesMade = 0

mock.module('@/lib/auth', () => ({ requireUser: async () => currentUser }))
mock.module('@/lib/rate-limit', () => ({ enforceApiRateLimit: () => null }))
mock.module('@/lib/gemini', () => ({
  ensureGeminiKey: async () => {},
  createGeminiLiveEphemeralToken: async () => { tokensMinted++; return { token: 'tok', expiresAt: null } },
}))
mock.module('@/lib/live-usage-guard', () => ({
  getGeminiLiveAllowance: async () => ({ ok: true, sessionLimitMinutes: 10, status: 200 }),
  reserveGeminiLiveUsage: async ({ sessionId }: any) => { reservesMade++; return { ok: true, sessionId, status: 200 } },
}))
mock.module('@/lib/defense-agent-context', () => ({
  buildDefenseOnlyContextForStudent: async () => ({ context: {} }),
  buildDefenseLiveSystemInstruction: () => 'تعليمات المناقشة',
}))
mock.module('@/lib/student-ai-access', () => ({
  requireStudentAiSupervisorAccess: async (user: any) => {
    if (user.role !== 'STUDENT') return { allowed: true, reason: null, admissionId: null }
    if (supervisorLocked) {
      const err: any = new Error('AI_SUPERVISOR_LOCKED')
      err.status = 403
      err.reason = 'المشرف الذكي مقفل لحين استكمال خطوات القبول'
      throw err
    }
    return { allowed: true, reason: null, admissionId: 'adm-1' }
  },
}))

const route = await import('@/app/api/ai/live-token/route')
const { NextRequest } = await import('next/server')

const post = (body: any) => new NextRequest('http://localhost/api/ai/live-token', { method: 'POST', body: JSON.stringify(body) })

beforeEach(() => {
  currentUser = { id: 'stu-1', role: 'STUDENT', name: 'طالب' }
  supervisorLocked = true
  tokensMinted = 0
  reservesMade = 0
})

describe('live-token supervisor gate (U11)', () => {
  test('locked STUDENT asking for SUPERVISOR purpose gets 403 AI_SUPERVISOR_LOCKED and no token/reserve', async () => {
    const res = await route.POST(post({ purpose: 'SUPERVISOR' }))
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.code).toBe('AI_SUPERVISOR_LOCKED')
    expect(tokensMinted).toBe(0)
    expect(reservesMade).toBe(0)
  })

  test('unlocked STUDENT asking for SUPERVISOR purpose is minted a token', async () => {
    supervisorLocked = false
    const res = await route.POST(post({ purpose: 'SUPERVISOR' }))
    expect(res.status).toBe(200)
    expect(tokensMinted).toBe(1)
    expect(reservesMade).toBe(1)
  })

  test('locked STUDENT asking for DISCUSSION is not blocked by the supervisor gate', async () => {
    const res = await route.POST(post({ purpose: 'DISCUSSION', thesisId: 'th-1' }))
    expect(res.status).toBe(200)
    expect(tokensMinted).toBe(1)
  })

  test('staff (SUPERVISOR role) SUPERVISOR purpose is unaffected by the student gate', async () => {
    currentUser = { id: 'sup-1', role: 'SUPERVISOR', name: 'مشرف' }
    const res = await route.POST(post({ purpose: 'SUPERVISOR' }))
    expect(res.status).toBe(200)
    expect(tokensMinted).toBe(1)
  })
})
