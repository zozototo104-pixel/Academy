// رمز ترحيل وثائق الوكالة/الاعتماد — يربط مفتاح التخزين المرحّل بصاحبه
// ونوع وثيقته (HMAC-SHA256، نفس نمط رمز رفع القبول admission-upload-token):
// نقطة الترحيل تصدر الرمز مع المفتاح، ومسار التقديم يتحقق منه قبل ربط
// المفتاح بالطلب الجديد — فلا يستطيع مستخدم تمرير مفتاح غيره. الصلاحية
// 24 ساعة. السر من AACT_UPLOAD_TOKEN_SECRET أو AUTH_SECRET أو
// NEXTAUTH_SECRET، وبلا سر في الإنتاج يُرفض الترحيل صراحةً.

import { createHmac, timingSafeEqual } from 'crypto'

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000

type TokenPayload = {
  userId: string
  docType: string
  storageKey: string
  storageProvider: 's3' | 'local'
  fileName: string
  mimeType: string
  size: number
  exp: number
}

export type AgentUploadMetadata = Pick<TokenPayload, 'storageProvider' | 'fileName' | 'mimeType' | 'size'>
type TokenIdentity = Pick<TokenPayload, 'userId' | 'docType' | 'storageKey'>

function envSecret(name: string): string | null {
  const value = process.env[name]?.trim()
  return value || null
}

function isProductionRuntime(): boolean {
  if (process.env.VERCEL_ENV) return process.env.VERCEL_ENV === 'production'
  if (['1', 'true', 'yes'].includes(String(process.env.CI || process.env.GITHUB_ACTIONS || '').toLowerCase())) return false
  return process.env.NODE_ENV === 'production'
}

function tokenSecret() {
  const secret =
    envSecret('AACT_UPLOAD_TOKEN_SECRET') ||
    envSecret('AUTH_SECRET') ||
    envSecret('NEXTAUTH_SECRET')
  if (secret) return secret
  if (isProductionRuntime()) {
    throw new Error('AACT_UPLOAD_TOKEN_SECRET_REQUIRED')
  }
  return 'aact-upload-token-dev-secret'
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

export function createAgentUploadToken(
  input: TokenIdentity & AgentUploadMetadata,
  ttlMs = TOKEN_TTL_MS
) {
  const payload: TokenPayload = {
    userId: String(input.userId),
    docType: String(input.docType).toUpperCase(),
    storageKey: String(input.storageKey),
    storageProvider: input.storageProvider,
    fileName: input.fileName,
    mimeType: input.mimeType,
    size: input.size,
    exp: Date.now() + ttlMs,
  }
  const encoded = base64Url(JSON.stringify(payload))
  return `${encoded}.${signPayload(encoded)}`
}

export function readAgentUploadToken(
  token: string | null | undefined,
  input: TokenIdentity
): TokenPayload | null {
  const raw = String(token || '').trim()
  if (!raw || !raw.includes('.')) return null
  const [encoded, signature] = raw.split('.', 2)
  if (!encoded || !signature) return null
  if (!safeEqual(signature, signPayload(encoded))) return null
  let payload: TokenPayload
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (
    !payload || !Number.isFinite(payload.exp) || payload.exp <= Date.now() ||
    !['s3', 'local'].includes(payload.storageProvider) ||
    typeof payload.fileName !== 'string' || !payload.fileName ||
    typeof payload.mimeType !== 'string' || !payload.mimeType ||
    !Number.isFinite(payload.size) || payload.size <= 0 || payload.size > 4 * 1024 * 1024
  ) return null
  const matches = (
    payload.userId === String(input.userId) &&
    payload.docType === String(input.docType).toUpperCase() &&
    payload.storageKey === String(input.storageKey)
  )
  return matches ? payload : null
}

export function verifyAgentUploadToken(token: string | null | undefined, input: TokenIdentity) {
  return readAgentUploadToken(token, input) !== null
}

// Expired, unclaimed uploads are temporary objects, not application documents.
// The cancellation claim races safely against submit's one-time row deletion:
// whichever commits first wins. Never delete a key linked to a saved document.
export async function cleanupExpiredAgentUploads(now = new Date(), limit = 100) {
  const { db } = await import('@/lib/db')
  const { deleteStoredFile } = await import('@/lib/storage')
  const expiredBefore = new Date(now.getTime() - TOKEN_TTL_MS)
  const candidates = await db.agentPendingUpload.findMany({
    where: { createdAt: { lt: expiredBefore } },
    orderBy: { createdAt: 'asc' },
    take: Math.min(Math.max(limit, 1), 200),
    select: { storageKey: true, cancelled: true },
  })
  let removed = 0
  let failed = 0
  let linked = 0
  for (const candidate of candidates) {
    try {
      if (!candidate.cancelled) {
        const claim = await db.agentPendingUpload.updateMany({
          where: { storageKey: candidate.storageKey, cancelled: false, createdAt: { lt: expiredBefore } },
          data: { cancelled: true },
        })
        if (!claim.count) continue // A submission or explicit cancellation won.
      }
      const linkedDoc = await db.agentDocument.findFirst({
        where: { storageKey: candidate.storageKey }, select: { id: true },
      })
      if (linkedDoc) {
        linked++
      } else if (await deleteStoredFile(candidate.storageKey)) {
        removed++
      } else {
        failed++
        continue // Keep the cancelled row for a later retry.
      }
      await db.agentPendingUpload.deleteMany({ where: { storageKey: candidate.storageKey, cancelled: true } })
    } catch (error) {
      failed++
      console.error('[agent-upload] expired upload cleanup failed', error)
    }
  }
  return { checked: candidates.length, removed, linked, failed }
}
