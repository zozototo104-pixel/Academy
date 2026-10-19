/// <reference types="bun-types" />
import { beforeEach, describe, expect, mock, test } from 'bun:test'

type EnrollmentRow = {
  id: string
  userId: string
  status: string
  program: { titleAr: string; category: string }
  grantPercent?: number | null
}

type CertificateRow = {
  id: string
  userId: string
  type: string
  enrollmentId?: string | null
  program: string
  legacy?: boolean
}

let enrollments: EnrollmentRow[] = []
let certificates: CertificateRow[] = []
let admissionLookups = 0

const db: any = {
  enrollment: {
    findMany: async ({ where }: any) => enrollments.filter((enrollment) => (
      enrollment.userId === where.userId
      && where.status.in.includes(enrollment.status)
      && enrollment.program.category !== 'SERVICE'
    )).map((enrollment) => ({
      id: enrollment.id,
      status: enrollment.status,
      program: { titleAr: enrollment.program.titleAr },
    })),
  },
  certificate: {
    findMany: async ({ where }: any) => certificates.filter((certificate) => {
      if (certificate.userId !== where.userId) return false
      if (certificate.type !== where.type) return false
      return where.OR.some((clause: any) => (
        (clause.enrollmentId?.in && clause.enrollmentId.in.includes(certificate.enrollmentId))
        || (clause.program?.in && clause.program.in.includes(certificate.program))
      ))
    }).map((certificate) => ({ enrollmentId: certificate.enrollmentId || null, program: certificate.program })),
  },
  admissionApplication: {
    findFirst: async () => { admissionLookups += 1; return null },
  },
}

mock.module('@/lib/db', () => ({ db }))

const { getStudentAiSupervisorAccess } = await import('../../src/lib/student-ai-access')

beforeEach(() => {
  enrollments = []
  certificates = []
  admissionLookups = 0
})

describe('student AI supervisor access after graduation', () => {
  test('ACTIVE academic enrollment keeps supervisor open', async () => {
    enrollments = [{ id: 'enr-active', userId: 'student-1', status: 'ACTIVE', program: { titleAr: 'دبلوم القيادة', category: 'DIPLOMA' } }]
    const access = await getStudentAiSupervisorAccess('student-1')
    expect(access.allowed).toBe(true)
    expect(admissionLookups).toBe(0)
  })

  test('COMPLETED enrollment without issued certificate keeps supervisor open', async () => {
    enrollments = [{ id: 'enr-completed', userId: 'student-1', status: 'COMPLETED', program: { titleAr: 'دبلوم القيادة', category: 'DIPLOMA' } }]
    const access = await getStudentAiSupervisorAccess('student-1')
    expect(access.allowed).toBe(true)
    expect(admissionLookups).toBe(0)
  })

  test('COMPLETED enrollment with issued certificate locks supervisor', async () => {
    enrollments = [{ id: 'enr-completed', userId: 'student-1', status: 'COMPLETED', program: { titleAr: 'دبلوم القيادة', category: 'DIPLOMA' } }]
    certificates = [{ id: 'cert-1', userId: 'student-1', type: 'PROGRAM_COMPLETION', enrollmentId: 'enr-completed', program: 'دبلوم القيادة' }]
    const access = await getStudentAiSupervisorAccess('student-1')
    expect(access.allowed).toBe(false)
    expect(access.reason).toContain('بعد التخرج')
    expect(admissionLookups).toBe(0)
  })

  test('legacy graduate with completed enrollment and legacy certificate is locked', async () => {
    enrollments = [{ id: 'enr-legacy', userId: 'student-1', status: 'COMPLETED', program: { titleAr: 'دبلوم القيادة', category: 'DIPLOMA' } }]
    certificates = [{ id: 'cert-legacy', userId: 'student-1', type: 'PROGRAM_COMPLETION', enrollmentId: null, program: 'دبلوم القيادة', legacy: true }]
    const access = await getStudentAiSupervisorAccess('student-1')
    expect(access.allowed).toBe(false)
    expect(admissionLookups).toBe(0)
  })

  test('legacy graduate with another ACTIVE academic program stays open', async () => {
    enrollments = [
      { id: 'enr-legacy', userId: 'student-1', status: 'COMPLETED', program: { titleAr: 'دبلوم القيادة', category: 'DIPLOMA' } },
      { id: 'enr-active', userId: 'student-1', status: 'ACTIVE', program: { titleAr: 'ماجستير الإدارة', category: 'MASTER' } },
    ]
    certificates = [{ id: 'cert-legacy', userId: 'student-1', type: 'PROGRAM_COMPLETION', enrollmentId: null, program: 'دبلوم القيادة', legacy: true }]
    const access = await getStudentAiSupervisorAccess('student-1')
    expect(access.allowed).toBe(true)
    expect(admissionLookups).toBe(0)
  })

  test('full grant ACTIVE student stays open', async () => {
    enrollments = [{ id: 'enr-grant', userId: 'student-1', status: 'ACTIVE', grantPercent: 100, program: { titleAr: 'دبلوم القيادة', category: 'DIPLOMA' } }]
    const access = await getStudentAiSupervisorAccess('student-1')
    expect(access.allowed).toBe(true)
    expect(admissionLookups).toBe(0)
  })
})
