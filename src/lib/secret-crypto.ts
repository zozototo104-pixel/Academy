import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto'

const PREFIX = 'enc:v1:'
let decryptedCache = new Map<string, { value: string; at: number }>()

function keyFromEnv(name: string): Buffer | null {
  const raw = process.env[name]
  if (!raw) return null
  try {
    const key = Buffer.from(raw, 'base64')
    return key.length === 32 ? key : null
  } catch {
    return null
  }
}

export function hasSecretEncryptionKey() {
  return !!keyFromEnv('AACT_SECRETS_KEY')
}

export function isEncryptedSecret(value: unknown): boolean {
  return String(value || '').startsWith(PREFIX)
}

export function secretLast4(value: unknown): string {
  const plain = String(value || '').trim()
  return plain.slice(-4)
}

export function encryptSecret(plain: string): string {
  const key = keyFromEnv('AACT_SECRETS_KEY')
  if (!key) throw new Error('AACT_SECRETS_KEY_MISSING')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${PREFIX}${iv.toString('base64url')}:${tag.toString('base64url')}:${data.toString('base64url')}`
}

export function decryptSecret(value: string): string {
  const raw = String(value || '')
  if (!raw.startsWith(PREFIX)) return raw
  const cached = decryptedCache.get(raw)
  if (cached && Date.now() - cached.at < 60_000) return cached.value
  const parts = raw.slice(PREFIX.length).split(':')
  if (parts.length !== 3) throw new Error('SECRET_DECRYPT_INVALID_FORMAT')
  const tryKey = (key: Buffer | null) => {
    if (!key) return null
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parts[0], 'base64url'))
      decipher.setAuthTag(Buffer.from(parts[1], 'base64url'))
      return Buffer.concat([decipher.update(Buffer.from(parts[2], 'base64url')), decipher.final()]).toString('utf8')
    } catch {
      return null
    }
  }
  const valueOut = tryKey(keyFromEnv('AACT_SECRETS_KEY')) ?? tryKey(keyFromEnv('AACT_SECRETS_KEY_PREVIOUS'))
  if (valueOut == null) throw new Error('SECRET_DECRYPT_FAILED')
  decryptedCache.set(raw, { value: valueOut, at: Date.now() })
  return valueOut
}

export function clearSecretCache() {
  decryptedCache = new Map()
}

export function isSecretKeyName(key: string) {
  return /(?:^|_)(?:KEY|KEYS|SECRET|TOKEN)(?:_|$)/i.test(key) || /KEY|SECRET|TOKEN/i.test(key)
}

export function isMaskedSecret(value: unknown) {
  const text = String(value || '')
  return !text.trim() || /[•*]{2,}/.test(text)
}

export function redactSecrets(text: unknown, knownSecrets: string[] = []) {
  let out = String(text || '')
  for (const secret of knownSecrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
    if (secret.length >= 6) out = out.split(secret).join(`[redacted:${secret.slice(-4)}]`)
  }
  out = out.replace(/sk-[A-Za-z0-9_\-]{12,}/g, 'sk-[redacted]')
  out = out.replace(/AIza[0-9A-Za-z_\-]{16,}/g, 'AIza[redacted]')
  out = out.replace(/Bearer\s+[A-Za-z0-9._\-]{12,}/gi, 'Bearer [redacted]')
  out = out.replace(/([A-Za-z0-9_]*API[_-]?KEY[A-Za-z0-9_]*\s*[:=]\s*)[^\s,;"']{8,}/gi, '$1[redacted]')
  return out
}

export function keyHashForRateLimit(key: string) {
  return createHash('sha256').update(key).digest('hex').slice(0, 12)
}
