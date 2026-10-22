import { describe, expect, test } from 'bun:test'
import { dueReminders, selectDueReminders } from '../../src/lib/lectures/reminders'

const start = new Date('2026-10-23T18:00:00.000Z')
const at = (iso: string) => new Date(iso)
const session = (over: Partial<Parameters<typeof dueReminders>[0]> = {}) => ({
  id: 's1',
  status: 'SCHEDULED',
  startsAt: start,
  reminder24hSentAt: null,
  reminder15mSentAt: null,
  ...over,
})

describe('reminder windows', () => {
  test('24h reminder fires inside its window only', () => {
    expect(dueReminders(session(), at('2026-10-22T17:59:00Z'))).toEqual([]) // 24h01m before
    expect(dueReminders(session(), at('2026-10-22T18:00:00Z'))).toEqual(['BEFORE_24H']) // exactly 24h
    expect(dueReminders(session(), at('2026-10-23T10:00:00Z'))).toEqual(['BEFORE_24H'])
    expect(dueReminders(session(), at('2026-10-23T16:00:00Z'))).toEqual(['BEFORE_24H']) // exactly 2h before
    expect(dueReminders(session(), at('2026-10-23T16:01:00Z'))).toEqual([]) // too late for the 24h one
  })

  test('15m reminder fires from -15m until +10m', () => {
    expect(dueReminders(session(), at('2026-10-23T17:44:00Z'))).toEqual([])
    expect(dueReminders(session(), at('2026-10-23T17:45:00Z'))).toEqual(['BEFORE_15M'])
    expect(dueReminders(session(), at('2026-10-23T18:10:00Z'))).toEqual(['BEFORE_15M'])
    expect(dueReminders(session(), at('2026-10-23T18:11:00Z'))).toEqual([])
  })

  test('a session created 30 minutes ahead only gets the 15m reminder', () => {
    expect(dueReminders(session(), at('2026-10-23T17:30:00Z'))).toEqual([])
    expect(dueReminders(session(), at('2026-10-23T17:50:00Z'))).toEqual(['BEFORE_15M'])
  })
})

describe('reminder idempotency and exclusions', () => {
  test('already-sent reminders never fire again on re-run', () => {
    const sent = session({ reminder24hSentAt: at('2026-10-22T18:00:00Z'), reminder15mSentAt: at('2026-10-23T17:45:00Z') })
    expect(dueReminders(sent, at('2026-10-22T19:00:00Z'))).toEqual([])
    expect(dueReminders(sent, at('2026-10-23T17:50:00Z'))).toEqual([])
  })

  test('cancelled, rescheduled and ended sessions never remind', () => {
    for (const status of ['CANCELLED', 'RESCHEDULED', 'ENDED', 'LIVE']) {
      expect(dueReminders(session({ status }), at('2026-10-22T18:00:00Z'))).toEqual([])
      expect(dueReminders(session({ status }), at('2026-10-23T17:50:00Z'))).toEqual([])
    }
  })

  test('selection flattens kinds per session', () => {
    const due = selectDueReminders(
      [session(), session({ id: 's2', startsAt: new Date('2026-10-23T17:50:00.000Z') })],
      at('2026-10-23T17:45:00Z'),
    )
    expect(due).toEqual([
      { sessionId: 's1', kind: 'BEFORE_15M' },
      { sessionId: 's2', kind: 'BEFORE_15M' },
    ])
  })
})
