// Audit details are a plain record serialized to JSON. Secret-bearing keys
// are stripped here so no caller can accidentally log a meeting link or
// passcode into the audit trail. Pure and unit-tested.
const SECRET_KEY = /url|passcode|password|token|secret/i

export function safeAuditDetails(record: Record<string, unknown>): string {
  const safe: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    if (SECRET_KEY.test(key)) continue
    safe[key] = value
  }
  return JSON.stringify(safe)
}
