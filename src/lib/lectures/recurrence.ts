// Weekly recurrence for lecture series, computed in the series' own IANA
// timezone. Wall-clock time stays fixed across DST transitions (an 18:00
// Gaza lecture remains 18:00 local; only its UTC instant shifts), which is
// what students and supervisors expect. Pure functions, Intl-based, no
// external dependencies.

export const MAX_OCCURRENCES = 52

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

export function isValidDateYmd(value: string): boolean {
  if (!DATE_RE.test(value)) return false
  const [y, m, d] = value.split('-').map(Number)
  const probe = new Date(Date.UTC(y, m - 1, d))
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d
}

export function isValidTimeHm(value: string): boolean {
  return TIME_RE.test(value)
}

export function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value })
    return true
  } catch {
    return false
  }
}

// 0 = Sunday .. 6 = Saturday, for a calendar date (timezone-independent).
export function weekdayOf(dateYmd: string): number {
  const [y, m, d] = dateYmd.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

export function addDaysYmd(dateYmd: string, days: number): string {
  const [y, m, d] = dateYmd.split('-').map(Number)
  const next = new Date(Date.UTC(y, m - 1, d + days))
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`
}

function tzOffsetMs(timeZone: string, utcInstant: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(utcInstant)
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0)
  const wallAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
  return wallAsUtc - Math.floor(utcInstant.getTime() / 1000) * 1000
}

// Convert a local wall-clock date+time in `timeZone` to the UTC instant.
export function zonedTimeToUtc(dateYmd: string, timeHm: string, timeZone: string): Date {
  const [y, m, d] = dateYmd.split('-').map(Number)
  const [hh, mm] = timeHm.split(':').map(Number)
  const guess = Date.UTC(y, m - 1, d, hh, mm)
  let utc = guess - tzOffsetMs(timeZone, new Date(guess))
  // Re-evaluate the offset at the corrected instant: near a DST transition
  // the first guess can land on the other side of the change.
  utc = guess - tzOffsetMs(timeZone, new Date(utc))
  return new Date(utc)
}

export type WeeklyOccurrenceInput = {
  startDate: string // first occurrence date, 'YYYY-MM-DD' in the series timezone
  timeOfDay: string // 'HH:mm' local wall time
  timeZone: string
  endDate?: string // last allowed local date, inclusive
  count?: number // or a fixed number of occurrences
  max?: number
}

// Bounded weekly occurrences as UTC instants. Stops at endDate or count,
// whichever comes first, and never exceeds the hard cap.
export function generateWeeklyOccurrences(input: WeeklyOccurrenceInput): Date[] {
  const cap = Math.min(input.max ?? MAX_OCCURRENCES, MAX_OCCURRENCES)
  const out: Date[] = []
  let date = input.startDate
  while (out.length < cap) {
    if (input.endDate && date > input.endDate) break
    if (input.count !== undefined && out.length >= input.count) break
    out.push(zonedTimeToUtc(date, input.timeOfDay, input.timeZone))
    date = addDaysYmd(date, 7)
  }
  return out
}
