// Comprehensive exam — publish gate: exactly 100 approved questions.
import { describe, expect, test } from 'bun:test'
import {
  COMPREHENSIVE_EXAM_QUESTION_COUNT,
  checkComprehensivePublishGate,
  comprehensiveQuestionCounts,
} from '../../src/lib/comprehensive-exam'

describe('checkComprehensivePublishGate', () => {
  test('100 approved publishes', () => {
    expect(checkComprehensivePublishGate(100)).toEqual({ ok: true, approved: 100 })
  })

  test('99 approved is refused with needed = 1', () => {
    const r = checkComprehensivePublishGate(99)
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('expected refusal')
    expect(r.needed).toBe(1)
    expect(r.reason).toContain('ينقص 1')
  })

  test('0 approved needs all 100', () => {
    const r = checkComprehensivePublishGate(0)
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('expected refusal')
    expect(r.needed).toBe(100)
  })

  test('101 approved is refused with excess = 1 — the system never picks for the admin', () => {
    const r = checkComprehensivePublishGate(101)
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('expected refusal')
    expect(r.excess).toBe(1)
    expect(r.reason).toContain('يتجاوز')
  })

  test('the target is exactly 100', () => {
    expect(COMPREHENSIVE_EXAM_QUESTION_COUNT).toBe(100)
  })
})

describe('comprehensiveQuestionCounts', () => {
  test('counts by review status', () => {
    const counts = comprehensiveQuestionCounts([
      { status: 'APPROVED' },
      { status: 'APPROVED' },
      { status: 'PENDING_REVIEW' },
      { status: 'REJECTED' },
    ])
    expect(counts).toEqual({ total: 4, approved: 2, pending: 1, rejected: 1 })
  })
})
