/// <reference types="bun-types" />
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { NextRequest } from 'next/server'

type CreateCall = { userId: string; role: string; content: string; mode: string }
const creates: CreateCall[] = []
let streamBehavior: 'cut-after-chunks' | 'fail-before-chunks' = 'cut-after-chunks'

const db: any = {
  chatMessage: {
    create: async ({ data }: { data: CreateCall }) => {
      creates.push(data)
      return { id: data.role === 'assistant' ? 'saved-partial-1' : 'user-msg-1' }
    },
    findMany: async () => [],
  },
}

mock.module('@/lib/db', () => ({ db }))
mock.module('@/lib/auth', () => ({
  requireUser: async () => ({ id: 'student-1', name: 'Test', email: 't@t', phone: null, role: 'STUDENT' }),
}))
mock.module('@/lib/rate-limit', () => ({ enforceDatabaseApiRateLimit: async () => null }))
mock.module('@/lib/platform-agent', () => ({
  platformAgentStream: async (_input: any, emit: (chunk: string) => Promise<void>) => {
    if (streamBehavior === 'cut-after-chunks') {
      await emit('السلام ')
      await emit('عليكم')
      throw new Error('quota cut mid-stream')
    }
    throw new Error('provider down before first chunk')
  },
  platformAgentComplete: async () => ({ reply: '', agent: 'SUPPORT', engine: 'LOCAL_RULE' }),
}))
mock.module('@/lib/human-handoff', () => ({
  createHumanHandoffRequest: async () => ({}),
  hadRecentHumanSupportPrompt: () => false,
  hasRecentHumanHandoffRequest: async () => false,
  getHumanHandoffConfirmationReply: async () => '',
  looksLikeHumanHandoffDetails: () => false,
  wantsHumanSupport: () => false,
  withHumanHandoffActiveNote: (reply: string) => reply,
}))
mock.module('@/lib/student-ai-access', () => ({ requireStudentAiSupervisorAccess: async () => ({}) }))
mock.module('@/lib/ai-usage-accounting', () => ({
  enforceAiUserDailyCostCap: async () => ({}),
  recordAiUsage: async () => ({}),
}))
mock.module('@/lib/supervisor-ai', () => ({ updateStudentAcademicMemory: async () => ({}) }))
mock.module('@/lib/untrusted-context', () => ({ wrapUntrustedUiContext: (c: any) => c }))
mock.module('@/lib/prod-safety', () => ({ deadlineFromNow: () => 55_000 }))

const route = await import('../../src/app/api/chat/route')

function postChat() {
  return new NextRequest('http://localhost/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'hello', mode: 'TEXT', stream: true }),
  })
}

async function readEvents(res: Response) {
  const text = await res.text()
  return text.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line))
}

beforeEach(() => {
  creates.length = 0
  streamBehavior = 'cut-after-chunks'
})

describe('chat stream partial replies', () => {
  test('a cut stream saves the partial and reports its id in the error event', async () => {
    streamBehavior = 'cut-after-chunks'
    const res = await route.POST(postChat())
    const events = await readEvents(res)
    expect(events[0]).toEqual({ type: 'chunk', text: 'السلام ' })
    expect(events[1]).toEqual({ type: 'chunk', text: 'عليكم' })
    const errorEvent = events.find((e) => e.type === 'error')
    expect(errorEvent).toBeDefined()
    expect(errorEvent.partialMessageId).toBe('saved-partial-1')
    // User message + saved partial, nothing else.
    expect(creates).toHaveLength(2)
    expect(creates[0]).toMatchObject({ role: 'user', content: 'hello' })
    expect(creates[1]).toMatchObject({ role: 'assistant', content: 'السلام عليكم' })
  })

  test('a failure before any chunk saves no partial and carries no id', async () => {
    streamBehavior = 'fail-before-chunks'
    const res = await route.POST(postChat())
    const events = await readEvents(res)
    const errorEvent = events.find((e) => e.type === 'error')
    expect(errorEvent).toBeDefined()
    expect(errorEvent.partialMessageId).toBeUndefined()
    expect(creates).toHaveLength(1)
    expect(creates[0]).toMatchObject({ role: 'user', content: 'hello' })
  })
})
