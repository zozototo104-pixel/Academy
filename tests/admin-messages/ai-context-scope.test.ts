/// <reference types="bun-types" />
import { describe, expect, mock, test } from 'bun:test'

// ===== حالة الاختبار القابلة للتبديل =====
const channelWhere: any[] = []

const channelRows: any[] = [
  { senderRole: 'STUDENT', audience: 'AI', content: 'سؤال موجّه للذكي فقط', createdAt: new Date() },
  { senderRole: 'STUDENT', audience: 'HUMAN', content: 'رسالة موجّهة للبشري', createdAt: new Date() },
  { senderRole: 'SUPERVISOR', audience: 'ALL', content: 'توجيه المشرف البشري', createdAt: new Date() },
  { senderRole: 'ADMIN', audience: 'ALL', content: 'رسالة إدارة سرية يجب ألا تدخل سياق الذكاء', createdAt: new Date() },
]

const db: any = {
  user: { findUnique: async () => ({ name: 'طالب', role: 'STUDENT', createdAt: new Date() }) },
  studentAcademicMemory: { findUnique: async () => null },
  chatMessage: { findMany: async () => [] },
  supervisorChannelMessage: {
    findMany: async (args: any) => {
      channelWhere.push(args?.where)
      // Substantive scope filter: the mock only returns rows matching the query's scope,
      // mirroring what Prisma would return for the real query.
      const scope = args?.where?.scope
      return channelRows.filter((m) => (scope === 'SUPERVISION' ? m.senderRole !== 'ADMIN' : true))
    },
  },
  admissionApplication: { findFirst: async () => null },
  thesisSubmission: { findFirst: async () => null },
  enrollment: { findMany: async () => [] },
  program: { findMany: async () => [] },
}

mock.module('@/lib/db', () => ({ db }))
mock.module('@/lib/ai-context-builder', () => ({ buildScopedProgramCatalogSnapshot: async () => '' }))
mock.module('@/lib/text-ai', () => ({ textAiCompleteJson: async () => '' }))

describe('AI supervisor context — supervision channel history, admin scope excluded', () => {
  test('context includes AI-audience AND HUMAN-audience supervision messages, excludes admin-scope', async () => {
    const lib = await import('@/lib/supervisor-ai')
    const context = await lib.buildSupervisorContext('student-1')
    expect(channelWhere[0].scope).toBe('SUPERVISION')
    expect(context).toContain('سؤال موجّه للذكي فقط')
    expect(context).toContain('رسالة موجّهة للبشري')
    expect(context).toContain('توجيه المشرف البشري')
    expect(context).not.toContain('رسالة إدارة سرية يجب ألا تدخل سياق الذكاء')
  })

  test('channel messages are labeled by sender role', async () => {
    const lib = await import('@/lib/supervisor-ai')
    const context = await lib.buildSupervisorContext('student-1')
    expect(context).toContain('المشرف البشري: توجيه المشرف البشري')
    expect(context).toContain('الطالب: سؤال موجّه للذكي فقط')
  })
})
