import { createHash } from 'crypto'
import { decryptSecret, encryptSecret, hasSecretEncryptionKey, isEncryptedSecret } from '@/lib/secret-crypto'

function digitsOnly(value?: string | null) {
  return String(value || '').replace(/\D/g, '')
}

export function whatsappHashSecret() {
  return process.env.WHATSAPP_HASH_SECRET || process.env.NEXTAUTH_SECRET || 'aact-whatsapp-local-hash'
}

export function isWhatsAppHashSecretExplicitlyConfigured() {
  return Boolean(String(process.env.WHATSAPP_HASH_SECRET || '').trim())
}

export function normalizeWhatsAppIdForHash(from: string) {
  return digitsOnly(from) || String(from || '').trim()
}

export function hashWhatsAppId(from: string) {
  return createHash('sha256').update(`${whatsappHashSecret()}:${normalizeWhatsAppIdForHash(from)}`).digest('hex')
}

// Backward-compatible alias; new code should import hashWhatsAppId so there is one canonical implementation.
export const whatsappWaIdHash = hashWhatsAppId

/** Match an existing conversation hash using the current or an explicitly known old salt.
 * Never infer a WhatsApp recipient solely from its masked number.
 */
export function matchesWhatsAppWaIdHash(from: string, expectedHash: string) {
  const expected = String(expectedHash || '').toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(expected)) return false
  const salts = new Set([
    whatsappHashSecret(),
    process.env.WHATSAPP_HASH_SECRET_PREVIOUS,
    process.env.NEXTAUTH_SECRET,
    'aact-whatsapp-local-hash',
  ].filter((salt): salt is string => Boolean(salt)))
  return [...salts].some((salt) => createHash('sha256').update(`${salt}:${from}`).digest('hex') === expected)
}

export function maskWhatsAppPhone(value?: string | null) {
  const raw = String(value || '').replace(/\D/g, '')
  if (!raw) return ''
  return raw.length <= 4 ? `****${raw}` : `${raw.slice(0, 3)}****${raw.slice(-4)}`
}

export function encryptWhatsAppPhone(rawPhone?: string | null) {
  const raw = String(rawPhone || '').trim()
  if (!raw || !hasSecretEncryptionKey()) return ''
  try { return encryptSecret(raw) } catch { return '' }
}

export function decryptWhatsAppPhone(encrypted?: string | null) {
  const value = String(encrypted || '').trim()
  if (!value || !isEncryptedSecret(value)) return ''
  try { return decryptSecret(value) } catch { return '' }
}
