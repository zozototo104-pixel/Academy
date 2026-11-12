/// <reference types="bun-types" />
import { describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NextRequest } from 'next/server'

// زر التماس إعادة الفتح على شاشة امتحان الوحدة المغلق:
// الطالب الذي يأتي ليقدّم امتحان وحدة انتهت نافذتها كان يرى رسالة
// الرفض فقط، بلا أي زر يقدّم منه الالتماس — والزر الوحيد كان على
// بطاقة الواجب (التماس مختلف بمكانه، وإن كان الالتماس نفسه على
// مستوى الوحدة). هذا الملف يثبّت: مسار التفاصيل يرفق سياق الوحدة
// مع رفض UNIT_WINDOW_ENDED، وشاشة الامتحان تركّب زر الالتماس
// من ذلك السياق، وبطاقة الواجب تبقى كما هي بلا أي تغيير.
// التشغيل: bun test tests/academic/unit-exam-window-appeal.test.ts (منفردًا)

const PROGRAM = { category: 'DIPLOMA', maxStudyDays: 90, semestersCount: 2 }
const UNITS = [
  { id: 'u1a', semester: 1, order: 1 },
  { id: 'u1b', semester: 1, order: 2 },
  { id: 'u2', semester: 2, order: 1 },
]

const state = { grant: false }

function makeDb() {
  const enrollment = {
    id: 'enr1',
    userId: 'u1',
    programId: 'p1',
    status: 'ACTIVE',
    // قبل 30 يومًا: نافذة الوحدة الأولى (22 يومًا) انتهت قبل 8 أيام،
    // وفترة الفصل الأول (45 يومًا) ما زالت قائمة 15 يومًا — فيكون
    // الرفض من الوحدة وحدها، والمنحة ترفعه دون فتح فصل منتهٍ.
    createdAt: new Date(Date.now() - 30 * 24 * 3600 * 1000),
    extensionDays: 0,
    program: PROGRAM,
  }
  const exam = {
    id: 'ex1',
    status: 'READY',
    unitId: 'u1a',
    unit: { id: 'u1a', programId: 'p1', semester: 1, program: { id: 'p1', titleAr: 'برنامج' } },
  }
  return {
    exam: { findUnique: async () => exam },
    enrollment: { findUnique: async () => enrollment },
    examAttempt: { findFirst: async () => null },
    unit: { findMany: async () => UNITS },
    enrollmentSemesterState: { findUnique: async () => null },
    reopenAppeal: { findFirst: async () => (state.grant ? { id: 'grant-1' } : null) },
    question: { findMany: async () => [] },
  } as any
}

const db = makeDb()
mock.module('@/lib/db', () => ({ db }))
mock.module('@/lib/auth', () => ({ requireUser: async () => ({ id: 'u1', name: 'طالب' }) }))
mock.module('@/lib/exam-attempt-policy', () => ({
  DEFAULT_EXAM_MAX_ATTEMPTS: 3,
  EXAM_ATTEMPT_POLICY_SINCE: new Date('2026-10-17T00:00:00Z'),
  getExamMaxAttempts: async () => 3,
}))
mock.module('@/lib/exam-attempt-notifications', () => ({ notifyAttemptNeedsReview: async () => {} }))

const { GET } = await import('../../src/app/api/exam/detail/route')

function getDetail() {
  return GET(new NextRequest('http://localhost/api/exam/detail?examId=ex1'))
}

describe('التماس إعادة فتح امتحان الوحدة من شاشته المغلقة', () => {
  test('نافذة الوحدة المنتهية: 403 مع سياق الوحدة للالتماس', async () => {
    state.grant = false
    const res = await getDetail()
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.code).toBe('UNIT_WINDOW_ENDED')
    expect(body.data).toEqual({ programId: 'p1', semester: 1, unitId: 'u1a' })
  })

  test('مع منحة معتمدة: يمرّ حارس النافذة ولا يُرفق سياق التماس', async () => {
    state.grant = true
    const res = await getDetail()
    // تجاوز الحارس ثم توقف عند غياب الأسئلة المنشورة — لا رفض نافذة هنا.
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe('EXAM_HAS_NO_QUESTIONS')
    expect(body.data).toBeUndefined()
  })

  test('شاشة الامتحان تركّب زر الالتماس من سياق الرفض فقط', () => {
    const root = join(import.meta.dir, '..', '..')
    const read = (p: string) => readFileSync(join(root, p), 'utf8')
    const view = read('src/components/aact/ExamView.tsx')
    expect(view).toContain("import { ReopenAppeal } from '@/components/aact/ReopenAppeal'")
    expect(view).toContain("if (e.code === 'UNIT_WINDOW_ENDED' && e.data?.unitId)")
    expect(view).toContain('setWindowEnded(')
    expect(view).toContain('<ReopenAppeal context="exam"')
    expect(view).toContain('if (windowEnded) {')
    const route = read('src/app/api/exam/detail/route.ts')
    expect(route).toContain("verdict.code === 'UNIT_WINDOW_ENDED'")
    expect(route).toContain('data: { programId: exam.unit.programId, semester: exam.unit.semester, unitId: exam.unitId }')
  })

  test('مكوّن الالتماس: نسخة الامتحان بنصها، ونسخة الواجب بلا أي تغيير', () => {
    const root = join(import.meta.dir, '..', '..')
    const read = (p: string) => readFileSync(join(root, p), 'utf8')
    const appeal = read('src/components/aact/ReopenAppeal.tsx')
    expect(appeal).toContain('التماس إعادة فتح الامتحان')
    expect(appeal).toContain('يمكنك تقديم هذا الامتحان الآن رغم انتهاء نافذته')
    expect(appeal).toContain("'/api/reopen-appeals'")
    expect(appeal).toContain('التماس إعادة فتح التسليم')
    expect(appeal).toContain('يمكنك تسليم هذا الواجب الآن رغم انتهاء موعده')
    expect(appeal).toContain('export const AssignmentReopenAppeal = ReopenAppeal')
    const dash = read('src/components/aact/DashboardView.tsx')
    expect(dash).toContain("import { AssignmentReopenAppeal } from '@/components/aact/ReopenAppeal'")
    expect(dash).toContain('<AssignmentReopenAppeal programId={a.programId} semester={a.semester} unitId={a.unitId ?? null} />')
  })
})
