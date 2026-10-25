import { describe, expect, test } from 'bun:test'
import { assignmentDueAt } from '../../src/lib/assignment-due-date'

const enrolled = new Date('2026-10-01T00:00:00.000Z')

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
