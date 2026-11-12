import { describe, expect, test } from 'bun:test'
import { assignmentDueAt, assignmentWindow, semesterOpenedAtFromApproval } from '../../src/lib/assignment-due-date'

const enrolled = new Date('2026-10-01T00:00:00.000Z')

const program = { category: 'MASTERS', maxStudyDays: 60, semestersCount: 2 }
const units = [
  { id: 'u1', semester: 1, order: 1 },
  { id: 'u2', semester: 1, order: 2 },
  { id: 'u3', semester: 2, order: 1 },
]
const unitArgs = { program, units, semester: 1, unitId: 'u2', dueDays: null, dueAtFixed: null }

describe('per-enrollment assignment windows', () => {
  test('linked assignment deadline clock starts with each student’s unit date', () => {
    const early = assignmentWindow({ ...unitArgs, enrolledAt: new Date('2026-01-01T00:00:00Z') })
    const late = assignmentWindow({ ...unitArgs, enrolledAt: new Date('2026-02-01T00:00:00Z') })
    expect(early.mode).toBe('UNIT')
    expect(early.opensAt.toISOString()).toBe('2026-01-16T00:00:00.000Z')
    expect(early.dueAt?.toISOString()).toBe('2026-01-31T00:00:00.000Z')
    expect(late.opensAt.toISOString()).toBe('2026-02-16T00:00:00.000Z')
    expect(late.dueAt?.toISOString()).toBe('2026-03-03T00:00:00.000Z')
  })

  test('admin can shorten linked duration, counted from the unit opening not enrollment', () => {
    const w = assignmentWindow({ ...unitArgs, enrolledAt: new Date('2026-01-01T00:00:00Z'), dueDays: 5 })
    expect(w.mode).toBe('UNIT_DAYS')
    expect(w.opensAt.toISOString()).toBe('2026-01-16T00:00:00.000Z')
    expect(w.dueAt?.toISOString()).toBe('2026-01-21T00:00:00.000Z')
  })

  test('custom days cannot extend the deadline beyond the existing unit window', () => {
    const w = assignmentWindow({ ...unitArgs, enrolledAt: new Date('2026-01-01T00:00:00Z'), dueDays: 30 })
    expect(w.dueAt?.toISOString()).toBe('2026-01-31T00:00:00.000Z')
  })

  test('a historical fixed date cannot close a linked unit before it opens', () => {
    const w = assignmentWindow({ ...unitArgs, enrolledAt: new Date('2026-02-01T00:00:00Z'),
      dueDays: 7, dueAtFixed: '2026-01-10T00:00:00Z' })
    // Stale days from the old fixed-date rule are ignored until the admin
    // explicitly clears dueAt by editing the new day-duration field.
    expect(w.mode).toBe('UNIT')
    expect(w.opensAt.toISOString()).toBe('2026-02-16T00:00:00.000Z')
    expect(w.dueAt?.toISOString()).toBe('2026-03-03T00:00:00.000Z')
  })

  test('unlinked assignments run from enrollment, with fixed historical precedence', () => {
    const base = { ...unitArgs, enrolledAt: new Date('2026-02-01T00:00:00Z'), unitId: null, dueDays: 14 }
    expect(assignmentWindow(base).dueAt?.toISOString()).toBe('2026-02-15T00:00:00.000Z')
    const old = assignmentWindow({ ...base, dueAtFixed: '2026-01-31T23:59:59Z' })
    expect(old.mode).toBe('LEGACY_FIXED')
    expect(old.dueAt?.toISOString()).toBe('2026-01-31T23:59:59.000Z')
  })

  test('semester-three source references must not apply an unrelated prior unit window', () => {
    const w = assignmentWindow({ ...unitArgs, enrolledAt: new Date('2026-02-01T00:00:00Z'),
      semester: 3, dueDays: 14 })
    expect(w.mode).toBe('ENROLLMENT_DAYS')
    expect(w.dueAt?.toISOString()).toBe('2026-02-15T00:00:00.000Z')
  })

  test('authorized enrollment extension extends the final unit, not a global deadline', () => {
    const w = assignmentWindow({ ...unitArgs, enrolledAt: new Date('2026-01-01T00:00:00Z'), extensionDays: 10 })
    expect(w.opensAt.toISOString()).toBe('2026-01-18T00:00:00.000Z')
    expect(w.dueAt?.toISOString()).toBe('2026-02-05T00:00:00.000Z')
    const last = assignmentWindow({ ...unitArgs, enrolledAt: new Date('2026-01-01T00:00:00Z'),
      semester: 2, unitId: 'u3', extensionDays: 10 })
    expect(last.dueAt?.toISOString()).toBe('2026-03-12T00:00:00.000Z')
  })
})

describe('assignment fixed calendar deadline', () => {
  test('fixed date wins over dueDays, regardless of enrollment date', () => {
    const due = assignmentDueAt(enrolled, 14, new Date('2026-11-15T23:59:59.999Z'))
    expect(due?.toISOString()).toBe('2026-11-15T23:59:59.999Z')
    const laterEnrolled = assignmentDueAt(new Date('2026-10-20T00:00:00.000Z'), 14, new Date('2026-11-15T23:59:59.999Z'))
    expect(laterEnrolled?.toISOString()).toBe('2026-11-15T23:59:59.999Z')
  })
  test('old dueDays fallback: enrollment date + days, only when no fixed date', () => {
    const due = assignmentDueAt(enrolled, 14, null)
    expect(due?.toISOString()).toBe('2026-10-15T00:00:00.000Z')
  })
  test('no deadline at all when neither fixed date nor days is set', () => {
    expect(assignmentDueAt(enrolled, null, null)).toBeNull()
    expect(assignmentDueAt(enrolled, undefined, undefined)).toBeNull()
  })
})

describe('advanced-semester deadline anchor', () => {
  test('semester-three research deadline counts from the previous semester approval, not enrollment', () => {
    // The review's example: enrolled 1 Nov, eligible for semester 3 on
    // 25 Nov — the 14 days start at the approval, so the deadline is
    // 9 Dec, not 15 Nov (when the student could not submit yet).
    const w = assignmentWindow({
      ...unitArgs, enrolledAt: new Date('2026-11-01T00:00:00Z'),
      semester: 3, unitId: null, dueDays: 14,
      semesterOpenedAt: new Date('2026-11-25T00:00:00Z'),
    })
    expect(w.mode).toBe('SEMESTER_DAYS')
    expect(w.opensAt.toISOString()).toBe('2026-11-25T00:00:00.000Z')
    expect(w.dueAt?.toISOString()).toBe('2026-12-09T00:00:00.000Z')
  })

  test('semester-three evidence unit does not re-anchor the deadline to its old unit', () => {
    const w = assignmentWindow({
      ...unitArgs, enrolledAt: new Date('2026-11-01T00:00:00Z'),
      semester: 3, unitId: 'u1', dueDays: 14,
      semesterOpenedAt: new Date('2026-11-25T00:00:00Z'),
    })
    expect(w.mode).toBe('SEMESTER_DAYS')
    expect(w.dueAt?.toISOString()).toBe('2026-12-09T00:00:00.000Z')
  })

  test('semester-two deadline counts from the first semester approval', () => {
    const w = assignmentWindow({
      ...unitArgs, enrolledAt: new Date('2026-11-01T00:00:00Z'),
      semester: 2, unitId: null, dueDays: 14,
      semesterOpenedAt: new Date('2026-11-20T00:00:00Z'),
    })
    expect(w.mode).toBe('SEMESTER_DAYS')
    expect(w.opensAt.toISOString()).toBe('2026-11-20T00:00:00.000Z')
    expect(w.dueAt?.toISOString()).toBe('2026-12-04T00:00:00.000Z')
  })

  test('without an approval record the enrollment anchor still applies', () => {
    const w = assignmentWindow({
      ...unitArgs, enrolledAt: new Date('2026-02-01T00:00:00Z'),
      semester: 2, unitId: null, dueDays: 14, semesterOpenedAt: null,
    })
    expect(w.mode).toBe('ENROLLMENT_DAYS')
    expect(w.dueAt?.toISOString()).toBe('2026-02-15T00:00:00.000Z')
  })

  test('semester one never uses the approval anchor', () => {
    const w = assignmentWindow({
      ...unitArgs, enrolledAt: new Date('2026-02-01T00:00:00Z'),
      semester: 1, unitId: null, dueDays: 14,
      semesterOpenedAt: new Date('2026-02-20T00:00:00Z'),
    })
    expect(w.mode).toBe('ENROLLMENT_DAYS')
    expect(w.dueAt?.toISOString()).toBe('2026-02-15T00:00:00.000Z')
  })

  test('linked unit windows ignore the approval anchor', () => {
    const w = assignmentWindow({
      ...unitArgs, enrolledAt: new Date('2026-01-01T00:00:00Z'),
      semester: 2, unitId: 'u3', dueDays: null,
      semesterOpenedAt: new Date('2026-03-01T00:00:00Z'),
    })
    expect(w.mode).toBe('UNIT')
    expect(w.opensAt.toISOString()).toBe('2026-01-31T00:00:00.000Z')
    expect(w.dueAt?.toISOString()).toBe('2026-03-02T00:00:00.000Z')
  })

  test('the approval anchor prefers decidedAt, then updatedAt, then createdAt', () => {
    const decided = new Date('2026-11-25T00:00:00Z')
    expect(semesterOpenedAtFromApproval({ decidedAt: decided, updatedAt: new Date('2026-11-26T00:00:00Z'), createdAt: new Date('2026-11-01T00:00:00Z') })?.toISOString()).toBe('2026-11-25T00:00:00.000Z')
    expect(semesterOpenedAtFromApproval({ decidedAt: null, updatedAt: '2026-11-26T00:00:00Z', createdAt: '2026-11-01T00:00:00Z' })?.toISOString()).toBe('2026-11-26T00:00:00.000Z')
    expect(semesterOpenedAtFromApproval({ createdAt: '2026-11-01T00:00:00Z' })?.toISOString()).toBe('2026-11-01T00:00:00.000Z')
    expect(semesterOpenedAtFromApproval(null)).toBeNull()
    expect(semesterOpenedAtFromApproval({})).toBeNull()
    expect(semesterOpenedAtFromApproval({ decidedAt: 'not-a-date' })).toBeNull()
  })
})
