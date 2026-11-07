import { beforeEach, describe, expect, mock, test } from 'bun:test'

// Guard U05/M3: deleting a program exam cascades (schema) to its
// questions AND every student attempt. The admin DELETE must refuse
// (409) when attempts exist, and an allowed delete must be audited.

let exams: any[] = []
let attempts: any[] = []
let audits: any[] = []

mock.module('@/lib/db', () => ({
  db: {
    programExam: {
      findUnique: async ({ where }: any) => exams.find((e) => e.id === where.id) || null,
      delete: async ({ where }: any) => {
        const i = exams.findIndex((e) => e.id === where.id)
        if (i < 0) throw new Error('missing')
        const [row] = exams.splice(i, 1)
        return row
      },
    },
    programExamAttempt: {
      count: async ({ where }: any = {}) => attempts.filter((a) => !where?.examId || a.examId === where.examId).length,
    },
  },
}))

mock.module('@/lib/auth', () => ({
  requireAdmin: async () => ({ id: 'admin-1', name: 'الأدمن', role: 'ADMIN' }),
}))

mock.module('@/lib/notify', () => ({
  audit: async (actor: any, action: string, entity: string, entityId: any, details: any) => { audits.push({ actor, action, entity, entityId, details }) },
}))

mock.module('@/lib/books-ai', () => ({ fallbackExamQuestionBatch: () => [] }))

const route = await import('@/app/api/admin/program-exams/route')
const { NextRequest } = await import('next/server')

const del = (id?: string) => new NextRequest(`http://localhost/api/admin/program-exams${id ? `?id=${id}` : ''}`, { method: 'DELETE' })

beforeEach(() => {
  exams = [
    { id: 'EX-USED', title: 'امتحان له محاولات' },
    { id: 'EX-EMPTY', title: 'امتحان بلا محاولات' },
  ]
  attempts = [{ id: 'ATT-1', examId: 'EX-USED', userId: 'stu-1', status: 'GRADED' }]
  audits = []
})

describe('admin program-exam DELETE guard (U05)', () => {
  test('exam WITH student attempts is refused 409 and survives', async () => {
    const res = await route.DELETE(del('EX-USED'))
    expect(res.status).toBe(409)
    expect(exams.find((e) => e.id === 'EX-USED')).toBeDefined()
    expect(audits.length).toBe(0)
  })

  test('exam WITHOUT attempts deletes and writes an audit record', async () => {
    const res = await route.DELETE(del('EX-EMPTY'))
    expect(res.status).toBe(200)
    expect(exams.find((e) => e.id === 'EX-EMPTY')).toBeUndefined()
    expect(audits.length).toBe(1)
    expect(audits[0].action).toBe('DELETE_PROGRAM_EXAM')
    expect(audits[0].entity).toBe('ProgramExam')
    expect(audits[0].entityId).toBe('EX-EMPTY')
  })

  test('unknown exam id is 404, not a 500 cascade delete', async () => {
    const res = await route.DELETE(del('EX-MISSING'))
    expect(res.status).toBe(404)
  })
})
