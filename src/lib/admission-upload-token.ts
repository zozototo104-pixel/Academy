import { createHmac, timingSafeEqual } from 'crypto'

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000

type TokenPayload = {
  appId: string
  reference: string
  email: string
  exp: number
}

function tokenSecret() {
  return (
    process.env.AACT_UPLOAD_TOKEN_SECRET ||
    process.env.AUTH_SECRET ||
    process.env.NEXTAUTH_SECRET ||
    process.env.DATABASE_URL ||
    'aact-upload-token-dev-secret'
  )
}

function base64Url(input: Buffer | string) {
  return Buffer.from(input).toString('base64url')
}

function signPayload(payload: string) {
  return createHmac('sha256', tokenSecret()).update(payload).digest('base64url')
}

function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

export function createAdmissionUploadToken(app: { id: string; reference: string; email: string }, ttlMs = TOKEN_TTL_MS) {
  const payload: TokenPayload = {
    appId: app.id,
    reference: app.reference,
    email: String(app.email || '').trim().toLowerCase(),
    exp: Date.now() + ttlMs,
  }
  const encoded = base64Url(JSON.stringify(payload))
  return `${encoded}.${signPayload(encoded)}`
}

export function verifyAdmissionUploadToken(
  token: string | null | undefined,
  app: { id: string; reference: string; email: string }
) {
  const raw = String(token || '').trim()
  if (!raw || !raw.includes('.')) return false
  const [encoded, signature] = raw.split('.', 2)
  if (!encoded || !signature) return false
  if (!safeEqual(signature, signPayload(encoded))) return false
  let payload: TokenPayload
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  } catch {
    return false
  }
  if (!payload || payload.exp < Date.now()) return false
  return (
    payload.appId === app.id &&
    payload.reference === app.reference &&
    String(payload.email || '').toLowerCase() === String(app.email || '').toLowerCase()
  )
}
