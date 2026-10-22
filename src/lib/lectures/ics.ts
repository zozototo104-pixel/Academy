// Minimal RFC 5545 calendar file for a single lecture session.
// The meeting link is intentionally NOT embedded: it stays behind the
// time-gated join endpoint inside the academy.

function formatIcsUtc(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '')
}

function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n')
}

export function buildLectureIcs(input: {
  sessionId: string
  title: string
  description?: string | null
  startsAt: Date
  endsAt: Date
  now?: Date
}): string {
  const now = input.now ?? new Date()
  const description =
    (input.description?.trim() ? `${input.description.trim()}\n\n` : '') +
    'رابط الانضمام يظهر داخل الأكاديمية قبل بدء المحاضرة بـ 15 دقيقة.'
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//AACT Academy//Lectures//AR',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:lecture-${input.sessionId}@aact.academy`,
    `DTSTAMP:${formatIcsUtc(now)}`,
    `DTSTART:${formatIcsUtc(input.startsAt)}`,
    `DTEND:${formatIcsUtc(input.endsAt)}`,
    `SUMMARY:${escapeIcsText(input.title)}`,
    `DESCRIPTION:${escapeIcsText(description)}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ]
  return lines.join('\r\n') + '\r\n'
}
