export const PRIVATE_STORAGE_PREFIXES = [
  'representatives-private/',
  'admissions/',
  'payment-proofs/',
  'assignments/',
  'theses/',
  'backups/',
] as const

export function normalizeStorageKeyForPolicy(value: unknown): string {
  return String(value || '')
    .trim()
    .replace(/\\+/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/+|\/+$/g, '')
}

export function isPrivateStorageKey(value: unknown): boolean {
  const key = normalizeStorageKeyForPolicy(value).toLowerCase()
  if (!key) return false
  return PRIVATE_STORAGE_PREFIXES.some((prefix) => key === prefix.slice(0, -1) || key.startsWith(prefix))
}

export function isAactTestEmail(value: unknown): boolean {
  const raw = String(value || '').trim().toLowerCase()
  const bracketMatch = raw.match(/<\s*([^<>\s]+@[^<>\s]+)\s*>/)
  const email = bracketMatch?.[1] || raw
  return email.endsWith('@aact.test')
}

export function hasAactTestRecipient(value: unknown): boolean {
  return String(value || '')
    .split(/[;,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .some(isAactTestEmail)
}

export function qaProdFixturesAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.VERCEL_ENV !== 'production' || String(env.QA_ALLOW_PROD_FIXTURES || '').toLowerCase() === 'true'
}

export function unsignedWebhookTestsAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.VERCEL_ENV !== 'production' && env.WHATSAPP_ALLOW_UNSIGNED_WEBHOOK_TESTS === '1'
}

export function deadlineFromNow(ms: number): number {
  return Date.now() + Math.max(0, Math.floor(ms))
}

export function remainingDeadlineMs(deadlineMs: number | undefined, fallbackMs: number, minUsefulMs = 1_000): number {
  if (!deadlineMs) return Math.max(0, Math.floor(fallbackMs))
  const remaining = Math.floor(deadlineMs - Date.now())
  if (remaining <= 0) return 0
  const bounded = Math.min(Math.floor(fallbackMs), remaining)
  return bounded >= minUsefulMs ? bounded : Math.max(0, bounded)
}

export function assertWithinDeadline(deadlineMs: number | undefined, label = 'DEADLINE_EXCEEDED') {
  if (deadlineMs && Date.now() >= deadlineMs) throw new Error(label)
}
