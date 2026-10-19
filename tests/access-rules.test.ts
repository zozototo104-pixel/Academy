/// <reference types="bun-types" />
import { beforeEach, describe, expect, mock, test } from 'bun:test'

type ProgramRow = { id: string; price: number; category: string; semestersCount?: number | null }
type EnrollmentRow = { userId: string; programId: string; status: string }
type PaymentRow = {
  id: string
  purpose: string
  status: string
  amount: number
  amountCents?: number | null
  waiverType?: string | null
  waiverStatus?: string | null
  waivedAmount?: number | null
  waivedAmountCents?: number | null
  originalAmount?: number | null
  originalAmountCents?: number | null
  enrollmentUserId?: string | null
  enrollmentProgramId?: string | null
}
type AdmissionRow = { id: string; userId: string; programId: string; status: string; payments: PaymentRow[] }

let programs: ProgramRow[] = []
let enrollments: EnrollmentRow[] = []
let admissions: AdmissionRow[] = []
let enrollmentPayments: PaymentRow[] = []

function selectedProgram(row: ProgramRow | null, select: any) {
  if (!row || !select) return row
  const out: any = {}
  for (const key of Object.keys(select)) if (select[key]) out[key] = (row as any)[key]
  return out
}

function matchesStatus(status: string, where: any) {
  if (!where?.status) return true
  if (Array.isArray(where.status.in)) return where.status.in.includes(status)
  return status === where.status
}

function isNonServiceEnrollment(row: EnrollmentRow, where: any) {
  const program = programs.find((item) => item.id === row.programId)
  const notCategory = where?.program?.is?.category?.not
  return !notCategory || program?.category !== notCategory
}

const db: any = {
  enrollment: {
    findFirst: async ({ where }: any) => enrollments.find((row) =>
      row.userId === where?.userId
      && matchesStatus(row.status, where)
      && isNonServiceEnrollment(row, where)
    ) || null,
  },
  program: {
    findUnique: async ({ where, select }: any) => selectedProgram(programs.find((row) => row.id === where?.id) || null, select),
  },
  admissionApplication: {
    findFirst: async ({ where }: any) => {
      const row = admissions.find((item) => item.userId === where?.userId && (!where?.programId || item.programId === where.programId))
      if (!row) return null
      return {
        ...row,
        reference: row.id,
        program: 'برنامج أكاديمي',
        supervisionMode: 'AI',
        supervisorAt: new Date(),
        programRef: programs.find((program) => program.id === row.programId) || null,
      }
    },
    findMany: async ({ where }: any) => admissions.filter((row) => row.userId === where?.userId && row.programId === where?.programId),
  },
  payment: {
    findMany: async ({ where }: any) => enrollmentPayments.filter((row) =>
      row.enrollmentUserId === where?.enrollment?.is?.userId
      && row.enrollmentProgramId === where?.enrollment?.is?.programId
    ),
  },
  tuitionInstallmentAppeal: {
    findFirst: async () => null,
  },
}

mock.module('@/lib/db', () => ({ db }))

const { getStudentAiSupervisorAccess } = await import('../src/lib/student-ai-access')
const { enforceSemesterTuitionGate, computeTuitionCoverage } = await import('../src/lib/tuition-installments')

function resetRows() {
  programs = [
    { id: 'program-a', price: 100, category: 'DIPLOMA', semestersCount: 2 },
    { id: 'service-a', price: 100, category: 'SERVICE', semestersCount: 2 },
  ]
  enrollments = []
  admissions = []
  enrollmentPayments = []
}

function enroll(programId = 'program-a', status = 'ACTIVE', userId = 'student-1') {
  enrollments = [{ userId, programId, status }]
}

function admit(payments: PaymentRow[], programId = 'program-a', userId = 'student-1') {
  admissions = [{ id: 'adm-1', userId, programId, status: 'AWAITING_TUITION', payments }]
}

function tuitionPayment(partial: Partial<PaymentRow>): PaymentRow {
  return {
    id: partial.id || `pay-${Math.random()}`,
    purpose: partial.purpose || 'TUITION',
    status: partial.status || 'UNPAID',
    amount: partial.amount ?? 0,
    amountCents: partial.amountCents,
    waiverType: partial.waiverType ?? null,
    waiverStatus: partial.waiverStatus ?? null,
    waivedAmount: partial.waivedAmount ?? null,
    waivedAmountCents: partial.waivedAmountCents ?? null,
    originalAmount: partial.originalAmount ?? null,
    originalAmountCents: partial.originalAmountCents ?? null,
    enrollmentUserId: partial.enrollmentUserId ?? null,
    enrollmentProgramId: partial.enrollmentProgramId ?? null,
  }
}

async function semesterGate(semester: number) {
  return enforceSemesterTuitionGate('student-1', 'program-a', semester)
}

beforeEach(resetRows)

describe('student supervisor access by enrollment', () => {
  test('ACTIVE academic enrollment opens supervisor even with no payment, but exams stay locked', async () => {
    enroll('program-a', 'ACTIVE')

    const access = await getStudentAiSupervisorAccess('student-1')
    const gate = await semesterGate(1)

    expect(access.allowed).toBe(true)
    expect(gate.ok).toBe(false)
    expect((gate as any).code).toBe('TUITION_HALF_REQUIRED')
  })

  test('SERVICE enrollment does not open supervisor through enrollment rule', async () => {
    enroll('service-a', 'ACTIVE')

    const access = await getStudentAiSupervisorAccess('student-1')

    expect(access.allowed).toBe(false)
  })
})

describe('tuition coverage exam gates', () => {
  test('approved full scholarship gives 100% coverage and opens supervisor plus both exams', async () => {
    enroll()
    admit([tuitionPayment({ status: 'WAIVED', amount: 0, originalAmount: 100, waivedAmount: 100, waiverType: 'FULL_SCHOLARSHIP', waiverStatus: 'APPROVED' })])

    expect((await getStudentAiSupervisorAccess('student-1')).allowed).toBe(true)
    expect((await semesterGate(1)).ok).toBe(true)
    expect((await semesterGate(2)).ok).toBe(true)
  })

  test('approved 50% partial scholarship opens first semester and locks second', async () => {
    enroll()
    admit([tuitionPayment({ status: 'UNPAID', amount: 50, originalAmount: 100, waivedAmount: 50, waiverType: 'PARTIAL_TUITION', waiverStatus: 'APPROVED' })])

    expect((await semesterGate(1)).ok).toBe(true)
    const second = await semesterGate(2)
    expect(second.ok).toBe(false)
    expect((second as any).code).toBe('TUITION_FULL_REQUIRED')
  })

  test('approved 50% scholarship plus paid remainder opens both exams', async () => {
    enroll()
    admit([tuitionPayment({ status: 'PAID', amount: 50, originalAmount: 100, waivedAmount: 50, waiverType: 'PARTIAL_TUITION', waiverStatus: 'APPROVED' })])

    expect((await semesterGate(1)).ok).toBe(true)
    expect((await semesterGate(2)).ok).toBe(true)
  })

  test('approved 30% scholarship keeps exams locked but supervisor remains open', async () => {
    enroll()
    admit([tuitionPayment({ status: 'UNPAID', amount: 70, originalAmount: 100, waivedAmount: 30, waiverType: 'PARTIAL_TUITION', waiverStatus: 'APPROVED' })])

    const access = await getStudentAiSupervisorAccess('student-1')
    const first = await semesterGate(1)

    expect(access.allowed).toBe(true)
    expect(first.ok).toBe(false)
    expect((await computeTuitionCoverage('student-1', 'program-a')).ratio).toBe(0.3)
  })

  test('approved 30% scholarship plus paid 20% installment opens first semester', async () => {
    enroll()
    admit([
      tuitionPayment({ id: 'tuition-1', status: 'UNPAID', amount: 70, originalAmount: 100, waivedAmount: 30, waiverType: 'PARTIAL_TUITION', waiverStatus: 'APPROVED' }),
      tuitionPayment({ id: 'installment-1', purpose: 'TUITION_INSTALLMENT', status: 'PAID', amount: 20 }),
    ])

    const gate = await semesterGate(1)

    expect(gate.ok).toBe(true)
    expect((await computeTuitionCoverage('student-1', 'program-a')).covered).toBe(50)
  })

  test('REQUESTED scholarship does not count toward coverage', async () => {
    enroll()
    admit([tuitionPayment({ status: 'UNPAID', amount: 50, originalAmount: 100, waivedAmount: 50, waiverType: 'PARTIAL_TUITION', waiverStatus: 'REQUESTED' })])

    const gate = await semesterGate(1)

    expect(gate.ok).toBe(false)
    expect((await computeTuitionCoverage('student-1', 'program-a')).covered).toBe(0)
  })

  test('paid application fee alone does not open any exam', async () => {
    enroll()
    admit([tuitionPayment({ id: 'app-fee-1', purpose: 'APPLICATION_FEE', status: 'PAID', amount: 30 })])

    expect((await semesterGate(1)).ok).toBe(false)
    expect((await semesterGate(2)).ok).toBe(false)
    expect((await computeTuitionCoverage('student-1', 'program-a')).covered).toBe(0)
  })
})
