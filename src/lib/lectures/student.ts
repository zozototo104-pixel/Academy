// Pure lecture-domain logic for the student side: no database or environment
// access here, so every rule stays unit-testable in isolation.

// Students may reveal the meeting link starting 15 minutes before the
// session starts, until the session ends.
export const JOIN_WINDOW_MINUTES = 15

export type EffectiveLectureStatus = 'SCHEDULED' | 'LIVE' | 'ENDED' | 'CANCELLED' | 'RESCHEDULED'

type SessionTimes = {
  status: string
  startsAt: Date
  endsAt: Date
}

// The stored status only carries explicit overrides (CANCELLED / RESCHEDULED).
// SCHEDULED / LIVE / ENDED are derived from the clock so no background job has
// to flip rows for a session to appear live or finished.
export function deriveEffectiveStatus(session: SessionTimes, now: Date = new Date()): EffectiveLectureStatus {
  if (session.status === 'CANCELLED') return 'CANCELLED'
  if (session.status === 'RESCHEDULED') return 'RESCHEDULED'
  const t = now.getTime()
  if (t < session.startsAt.getTime()) return 'SCHEDULED'
  if (t <= session.endsAt.getTime()) return 'LIVE'
  return 'ENDED'
}

export function joinOpensAt(session: SessionTimes): Date {
  return new Date(session.startsAt.getTime() - JOIN_WINDOW_MINUTES * 60_000)
}

export function isJoinWindowOpen(session: SessionTimes, now: Date = new Date()): boolean {
  // R-02: الملغاة والمؤجلة (المُعاد جدولتها) لا تُفتح أبدًا — اللقاء
  // المؤجل سجل تاريخي وبديله يحمل الرابط والموعد الجديدين.
  if (session.status === 'CANCELLED' || session.status === 'RESCHEDULED') return false
  const t = now.getTime()
  return t >= joinOpensAt(session).getTime() && t <= session.endsAt.getTime()
}

type SessionWithSeries = SessionTimes & {
  id: string
  seriesId: string
  title: string
  description: string | null
  deliveryMode: string
  provider: string
  series: {
    programId: string
    unitId: string | null
    timezone: string
    supervisor: { name: string } | null
    program: { titleAr: string } | null
  }
}

// Public projection of a session for students. Meeting credentials are never
// part of this shape; they are only revealed by the join endpoint inside the
// allowed window.
export function toPublicSession(session: SessionWithSeries, now: Date = new Date()) {
  return {
    id: session.id,
    seriesId: session.seriesId,
    title: session.title,
    description: session.description,
    programId: session.series.programId,
    programTitle: session.series.program?.titleAr ?? null,
    unitId: session.series.unitId,
    supervisorName: session.series.supervisor?.name ?? null,
    startsAt: session.startsAt.toISOString(),
    endsAt: session.endsAt.toISOString(),
    timezone: session.series.timezone,
    deliveryMode: session.deliveryMode,
    provider: session.provider,
    status: deriveEffectiveStatus(session, now),
    canJoin: session.deliveryMode === 'EXTERNAL_LINK' && isJoinWindowOpen(session, now),
    joinOpensAt: joinOpensAt(session).toISOString(),
  }
}

export type PublicSession = ReturnType<typeof toPublicSession>
