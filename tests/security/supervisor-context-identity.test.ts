/// <reference types="bun-types" />
import { describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Guard for the academic-supervisor context identity fix (owner decision
// 2026-11-09): buildSupervisorContext must carry the student's FULL name,
// admission reference and admission status — all from the student's own
// trusted database rows — so the supervisor can actually state them (the
// launch-quality PROFILE probe requires exactly these). It must never
// carry another student's identity data: every builder query is pinned to
// the caller's userId, and this suite proves the built string honors that.

const STUDENT_A = {
  id: 'student-a',
  name: 'ليان سمير الحلبي',
  reference: 'AACT-2026-A001',
  status: 'ACCEPTED',
  program: 'برنامج الطالبة الأولى',
}

const STUDENT_B = {
  id: 'student-b',
  name: 'عمر فاروق النجار',
  reference: 'AACT-2026-B999',
  status: 'PENDING_DOCS',
  program: 'برنامج الطالب الثاني',
}

const PROFILES: Record<string, any> = {
  [STUDENT_A.id]: { name: STUDENT_A.name, role: 'STUDENT', createdAt: new Date() },
  [STUDENT_B.id]: { name: STUDENT_B.name, role: 'STUDENT', createdAt: new Date() },
}

const ADMISSIONS: Record<string, any> = {
  [STUDENT_A.id]: { program: STUDENT_A.program, status: STUDENT_A.status, thesisDeadline: null, reference: STUDENT_A.reference },
  [STUDENT_B.id]: { program: STUDENT_B.program, status: STUDENT_B.status, thesisDeadline: null, reference: STUDENT_B.reference },
}

// The fakes honor Prisma's `select` projection: a field the builder does
// not select comes back undefined, exactly like the real client — so a
// regression that drops `reference` from the admission select fails the
// behavioral tests below, not only the source pins.
function project(row: any, select: any) {
  if (!row || !select) return row
  const out: any = {}
  for (const key of Object.keys(select)) if (select[key]) out[key] = row[key]
  return out
}

const db: any = {
  user: { findUnique: async (args: any) => project(PROFILES[args?.where?.id] || null, args?.select) },
  studentAcademicMemory: { findUnique: async () => null },
  chatMessage: { findMany: async () => [] },
  supervisorChannelMessage: { findMany: async () => [] },
  admissionApplication: { findFirst: async (args: any) => project(ADMISSIONS[args?.where?.userId] || null, args?.select) },
  thesisSubmission: { findFirst: async () => null },
  enrollment: { findMany: async () => [] },
  program: { findMany: async () => [] },
  examAttempt: { findMany: async () => [] },
  programExamAttempt: { findMany: async () => [] },
  assignmentSubmission: { findMany: async () => [] },
  exam: { findMany: async () => [] },
  programExam: { findMany: async () => [] },
  programAssignment: { findMany: async () => [] },
}

mock.module('@/lib/db', () => ({ db }))
mock.module('@/lib/ai-context-builder', () => ({ buildScopedProgramCatalogSnapshot: async () => '' }))
mock.module('@/lib/text-ai', () => ({ textAiCompleteJson: async () => '' }))

describe('supervisor context carries the student identity from his own rows', () => {
  test('full name, admission reference and admission status all reach the context', async () => {
    const lib = await import('@/lib/supervisor-ai')
    const context = await lib.buildSupervisorContext(STUDENT_A.id)
    expect(context.includes(STUDENT_A.name)).toBe(true)
    expect(context.includes(STUDENT_A.reference)).toBe(true)
    expect(context.includes(STUDENT_A.status)).toBe(true)
    // The identity card states the full name, not a first-name truncation.
    expect(context.includes(`الاسم الكامل ${STUDENT_A.name}`)).toBe(true)
    expect(context.includes('الرقم المرجعي')).toBe(true)
  })

  test('no other student identity leaks into the context', async () => {
    const lib = await import('@/lib/supervisor-ai')
    const contextA = await lib.buildSupervisorContext(STUDENT_A.id)
    expect(contextA.includes(STUDENT_B.name)).toBe(false)
    expect(contextA.includes(STUDENT_B.reference)).toBe(false)
    const contextB = await lib.buildSupervisorContext(STUDENT_B.id)
    expect(contextB.includes(STUDENT_B.name)).toBe(true)
    expect(contextB.includes(STUDENT_B.reference)).toBe(true)
    expect(contextB.includes(STUDENT_A.name)).toBe(false)
    expect(contextB.includes(STUDENT_A.reference)).toBe(false)
  })

  test('source pins: the builder fetches and prints the trusted fields', () => {
    const source = readFileSync(join(process.cwd(), 'src/lib/supervisor-ai.ts'), 'utf8')
    // The admission query must select the reference (it was never fetched before).
    expect(source.includes('thesisDeadline: true, reference: true')).toBe(true)
    // The admission line must print the reference from the loaded row.
    expect(source.includes('الرقم المرجعي: ${admission.reference}')).toBe(true)
    // The user card must print the full name.
    expect(source.includes('الاسم الكامل ${fullName')).toBe(true)
    // Regression pin: no first-name-only identity card may come back.
    expect(source.includes('بطاقة المستخدم: الاسم الأول')).toBe(false)
  })
})
