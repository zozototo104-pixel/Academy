// Which lecture reminders are due at a given moment. Pure and unit-tested;
// the cron route claims each due reminder atomically before sending, so
// re-runs and overlapping executions can never send it twice.
//
// Windows (chosen to tolerate cron delays without sending stale reminders):
// - 24h reminder: from 24h before the start until 2h before the start.
// - 15m reminder: from 15 minutes before the start until 10 minutes after
//   it (a late cron still catches a just-started lecture, then stops).
// Cancelled and rescheduled rows never remind: a rescheduled session is
// inert history and its replacement carries the new time.

export type ReminderKind = 'BEFORE_24H' | 'BEFORE_15M'

export type ReminderCandidate = {
  id: string
  status: string
  startsAt: Date
  reminder24hSentAt: Date | null
  reminder15mSentAt: Date | null
}

const HOUR_MS = 3_600_000
const MIN_MS = 60_000

export function dueReminders(session: ReminderCandidate, now: Date): ReminderKind[] {
  if (session.status !== 'SCHEDULED') return []
  const t = now.getTime()
  const start = session.startsAt.getTime()
  const due: ReminderKind[] = []
  if (!session.reminder24hSentAt && t >= start - 24 * HOUR_MS && t <= start - 2 * HOUR_MS) {
    due.push('BEFORE_24H')
  }
  if (!session.reminder15mSentAt && t >= start - 15 * MIN_MS && t <= start + 10 * MIN_MS) {
    due.push('BEFORE_15M')
  }
  return due
}

export function selectDueReminders(
  sessions: ReminderCandidate[],
  now: Date,
): { sessionId: string; kind: ReminderKind }[] {
  const out: { sessionId: string; kind: ReminderKind }[] = []
  for (const session of sessions) {
    for (const kind of dueReminders(session, now)) {
      out.push({ sessionId: session.id, kind })
    }
  }
  return out
}
