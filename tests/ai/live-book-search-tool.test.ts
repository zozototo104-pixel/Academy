/// <reference types="bun-types" />
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { NextRequest } from 'next/server'

type MockEnrollment = { userId: string; programId: string; status: string }

let currentUser: any = { id: 'student-1', role: 'STUDENT' }
let enrollments: MockEnrollment[] = []
let lastSnippetProgramIds: string[] = []
let lastSnippetQuery = ''

const db: any = {
  enrollment: {
    findMany: async ({ where }: any) => {
      const allowedStatuses = Array.isArray(where?.status?.in) ? where.status.in : null
      return enrollments
        .filter((row) => row.userId === where?.userId)
        .filter((row) => !allowedStatuses || allowedStatuses.includes(row.status))
        .map((row) => ({ programId: row.programId }))
    },
  },
}

mock.module('@/lib/db', () => ({ db }))
mock.module('@/lib/auth', () => ({
  requireUser: async () => {
    if (!currentUser) throw new Error('UNAUTHORIZED')
    return currentUser
  },
}))
mock.module('@/lib/rate-limit', () => ({ enforceApiRateLimit: () => null }))
mock.module('@/lib/supervisor-ai', () => ({
  buildSupervisorContext: async () => '',
  mergeContext: (...parts: unknown[]) => parts.filter(Boolean).join('\n'),
  buildRelevantSupervisorBookSnippets: async (programIds: string[], query: string | null | undefined) => {
    lastSnippetProgramIds = programIds
    lastSnippetQuery = String(query || '')
    return programIds.includes('program-b')
      ? 'مقطع من كتاب برنامج آخر'
      : 'مقطع من كتاب برنامج الطالب'
  },
}))

const { POST } = await import('../../src/app/api/ai/book-search/route')
const { buildGeminiLiveSetup } = await import('../../src/app/api/ai/gemini-live/session/route')

function bookSearchRequest(query: string) {
  return new NextRequest('http://localhost/api/ai/book-search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  })
}

beforeEach(() => {
  currentUser = { id: 'student-1', role: 'STUDENT' }
  enrollments = []
  lastSnippetProgramIds = []
  lastSnippetQuery = ''
})

describe('/api/ai/book-search', () => {
  test('rejects requests without a logged-in user', async () => {
    currentUser = null

    const response = await POST(bookSearchRequest('اشرح مفهوم الإدارة'))
    const payload = await response.json()

    expect(response.status).toBe(401)
    expect(payload).toEqual({ error: 'يجب تسجيل الدخول أولاً' })
    expect(lastSnippetProgramIds).toEqual([])
  })

  test('searches only ACTIVE or COMPLETED programs for the current student', async () => {
    enrollments = [
      { userId: 'student-1', programId: 'program-a', status: 'ACTIVE' },
      { userId: 'student-1', programId: 'program-b', status: 'CANCELLED' },
      { userId: 'student-2', programId: 'program-c', status: 'ACTIVE' },
    ]

    const response = await POST(bookSearchRequest('اشرح التخطيط الاستراتيجي'))
    const payload = await response.json()

    expect(response.status).toBe(200)
    expect(lastSnippetProgramIds).toEqual(['program-a'])
    expect(lastSnippetQuery).toBe('اشرح التخطيط الاستراتيجي')
    expect(payload.snippets).toBe('مقطع من كتاب برنامج الطالب')
    expect(payload.snippets).not.toContain('برنامج آخر')
  })
})

describe('Gemini Live book-search setup', () => {
  test('adds search_course_books tools to non-bare setup variants only', () => {
    for (const variant of ['minimal', 'generationConfig'] as const) {
      const payload = buildGeminiLiveSetup(variant, 'gemini-3.1-flash-live-preview', 'voice instructions', 'Charon', 'ar-PS') as any
      const setup = payload.setup

      expect(setup.tools?.[0]?.functionDeclarations?.[0]?.name).toBe('search_course_books')
      expect(setup.tools?.[0]?.functionDeclarations?.[0]?.parameters?.properties?.query?.type).toBe('STRING')
      expect(setup.systemInstruction.parts[0].text).toContain('عندما يسأل الطالب عن مفهوم أو محتوى من كتبه المقررة')
    }

    const barePayload = buildGeminiLiveSetup('bare', 'gemini-3.1-flash-live-preview', 'voice instructions', 'Charon', 'ar-PS') as any
    expect(barePayload.setup.tools).toBeUndefined()
    expect(barePayload.setup.systemInstruction.parts[0].text).toContain('عندما يسأل الطالب عن مفهوم أو محتوى من كتبه المقررة')
  })
})
