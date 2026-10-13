import { createHash, createHmac, randomUUID } from 'crypto'
import { promises as dns } from 'dns'
import { promises as fs } from 'fs'
import net from 'net'
import path from 'path'
import { isPrivateStorageKey } from '@/lib/prod-safety'

export type StoredFileProvider = 's3' | 'local' | 'external-url'

export interface StoredFileResult {
  provider: StoredFileProvider
  key: string
  url: string
  size: number
  mimeType: string
}

export interface StoreFileInput {
  buffer: Buffer
  fileName: string
  mimeType?: string | null
  namespace: string
}

export interface StoreFileAtKeyInput {
  buffer: Buffer
  fileName: string
  mimeType?: string | null
  key: string
}

interface ReadStoredFileInput {
  provider?: string | null
  key?: string | null
  url?: string | null
  data?: string | null
  mimeType?: string | null
}

function cleanSegment(value: string, fallback: string): string {
  const cleaned = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9/_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-/]+|[-/]+$/g, '')
  return cleaned || fallback
}

function cleanFileName(value: string): string {
  const cleaned = String(value || 'file')
    .trim()
    .replace(/[\\/\u0000-\u001f\u007f]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/-+/g, '-')
    .slice(0, 120)
  return cleaned || 'file'
}

function isoDateFolder(date = new Date()): string {
  return date.toISOString().slice(0, 10)
}

function sha256Hex(input: Buffer | string): string {
  return createHash('sha256').update(input).digest('hex')
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value).digest()
}

function encodeS3PathPart(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}

function encodeS3Key(key: string): string {
  return key.split('/').map(encodeS3PathPart).join('/')
}

function cleanStorageKey(value: string): string {
  const key = String(value || '')
    .trim()
    .replace(/\\+/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/+|\/+$/g, '')
  if (!key || key.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('INVALID_STORAGE_KEY')
  }
  return key
}

function isPrivateIp(address: string) {
  const family = net.isIP(address)
  if (!family) return true
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number)
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0) || (a === 192 && b === 0 && c === 2) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
  }
  const lower = address.toLowerCase()
  if (lower.startsWith('::ffff:')) {
    const mapped = lower.slice(7)
    if (net.isIP(mapped) === 4) return isPrivateIp(mapped)
    const parts = mapped.split(':')
    if (parts.length === 2 && parts.every((p) => /^[0-9a-f]{1,4}$/.test(p))) {
      const v = parts.map((p) => parseInt(p, 16))
      return isPrivateIp(`${v[0] >> 8}.${v[0] & 255}.${v[1] >> 8}.${v[1] & 255}`)
    }
    return true
  }
  // Only globally routable unicast IPv6 is eligible for remote fetches.
  return !(/^[23][0-9a-f]{3}:/.test(lower)) || lower.startsWith('2001:db8:') || lower.startsWith('2001:')
}

function configuredAllowedStorageHosts() {
  const values = [
    process.env.AACT_STORAGE_ALLOWED_HOSTS,
    process.env.AACT_STORAGE_PUBLIC_BASE_URL,
    process.env.AACT_S3_ENDPOINT,
  ].flatMap((raw) => String(raw || '').split(/[;,\s]+/)).map((raw) => raw.trim()).filter(Boolean)
  const hosts = new Set<string>()
  for (const value of values) {
    try {
      hosts.add(new URL(value.includes('://') ? value : `https://${value}`).hostname.toLowerCase())
    } catch {
      continue
    }
  }
  return hosts
}

async function assertSafeStorageFetchUrl(rawUrl: string) {
  let parsed: URL
  try { parsed = new URL(rawUrl) } catch { throw new Error('UNSAFE_STORAGE_URL') }
  if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('UNSAFE_STORAGE_URL')
  const host = parsed.hostname.toLowerCase()
  if (!configuredAllowedStorageHosts().has(host)) throw new Error('STORAGE_HOST_NOT_ALLOWED')
  const literal = net.isIP(host)
  const addresses = literal ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => [])
  if (!addresses.length || addresses.some((entry) => isPrivateIp(entry.address))) throw new Error('STORAGE_PRIVATE_HOST_REJECTED')
}

async function safeFetchStoredUrl(rawUrl: string) {
  await assertSafeStorageFetchUrl(rawUrl)
  const res = await fetch(rawUrl, { cache: 'no-store', redirect: 'manual' })
  if (res.status >= 300 && res.status < 400) throw new Error('STORAGE_REDIRECT_REJECTED')
  return res
}

function getS3Config() {
  const endpoint = process.env.AACT_S3_ENDPOINT?.trim()
  const bucket = process.env.AACT_S3_BUCKET?.trim()
  const accessKeyId = process.env.AACT_S3_ACCESS_KEY_ID?.trim()
  const secretAccessKey = process.env.AACT_S3_SECRET_ACCESS_KEY?.trim()
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null
  return {
    endpoint: endpoint.replace(/\/+$/, ''),
    bucket,
    accessKeyId,
    secretAccessKey,
    region: process.env.AACT_S3_REGION?.trim() || 'auto',
    privateRepresentativeBucket: process.env.AACT_REPRESENTATIVE_PRIVATE_S3_BUCKET?.trim() || null,
    publicBaseUrl: process.env.AACT_STORAGE_PUBLIC_BASE_URL?.trim().replace(/\/+$/, '') || null,
  }
}

function signS3Request(args: {
  method: 'GET' | 'PUT'
  key: string
  payloadHash: string
  extraHeaders?: Record<string, string>
  privateRepresentative?: boolean
}) {
  const cfg = getS3Config()
  if (!cfg) return null

  const endpoint = new URL(cfg.endpoint)
  const privateRepresentative = args.privateRepresentative || args.key.startsWith('representatives-private/')
  const bucket = privateRepresentative ? cfg.privateRepresentativeBucket : cfg.bucket
  if (!bucket || (privateRepresentative && bucket === cfg.bucket)) {
    throw new Error('PRIVATE_FILE_STORAGE_NOT_CONFIGURED')
  }
  const encodedKey = encodeS3Key(args.key)
  const canonicalUri = `/${encodeS3PathPart(bucket)}/${encodedKey}`
  const url = `${endpoint.origin}${canonicalUri}`
  const now = new Date()
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
  const dateStamp = amzDate.slice(0, 8)
  const headers: Record<string, string> = {
    host: endpoint.host,
    'x-amz-content-sha256': args.payloadHash,
    'x-amz-date': amzDate,
    ...(args.extraHeaders || {}),
  }

  const signedHeaders = Object.keys(headers)
    .map((h) => h.toLowerCase())
    .sort()
    .join(';')
  const canonicalHeaders = signedHeaders
    .split(';')
    .map((h) => `${h}:${headers[h]}\n`)
    .join('')
  const canonicalRequest = [
    args.method,
    canonicalUri,
    '',
    canonicalHeaders,
    signedHeaders,
    args.payloadHash,
  ].join('\n')
  const scope = `${dateStamp}/${cfg.region}/s3/aws4_request`
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n')
  const kDate = hmac(`AWS4${cfg.secretAccessKey}`, dateStamp)
  const kRegion = hmac(kDate, cfg.region)
  const kService = hmac(kRegion, 's3')
  const kSigning = hmac(kService, 'aws4_request')
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex')
  const authorization = `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  const requestHeaders = Object.fromEntries(Object.entries(headers).filter(([key]) => key !== 'host'))

  return {
    url,
    publicUrl: privateRepresentative || isPrivateStorageKey(args.key) ? '' : cfg.publicBaseUrl ? `${cfg.publicBaseUrl}/${encodedKey}` : url,
    headers: { ...requestHeaders, authorization },
  }
}

export function getStorageDownloadPathForKey(key: string): string {
  return `/api/files/${encodeS3Key(cleanStorageKey(key))}`
}

function signedDownloadSecret() {
  const secret = process.env.AACT_FILE_SIGNING_SECRET || process.env.NEXTAUTH_SECRET || process.env.JWT_SECRET || process.env.SESSION_SECRET || process.env.AUTH_SECRET || ''
  if (!secret && process.env.NODE_ENV === 'production') throw new Error('FILE_SIGNING_SECRET_NOT_CONFIGURED')
  return secret || 'aact-local-file-signing-secret'
}

export function signLocalStorageDownloadPath(key: string, expiresAtMs: number): string {
  const cleanKey = cleanStorageKey(key)
  const expires = String(Math.floor(expiresAtMs))
  const signature = createHmac('sha256', signedDownloadSecret()).update(`${cleanKey}.${expires}`).digest('hex')
  return `${getStorageDownloadPathForKey(cleanKey)}?download=1&expires=${encodeURIComponent(expires)}&signature=${signature}`
}

export function verifyLocalStorageDownloadSignature(key: string, expires: string | null, signature: string | null): boolean {
  const cleanKey = cleanStorageKey(key)
  const expiresMs = Number(expires || 0)
  if (!Number.isFinite(expiresMs) || expiresMs <= Date.now() || !signature) return false
  const expected = createHmac('sha256', signedDownloadSecret()).update(`${cleanKey}.${Math.floor(expiresMs)}`).digest('hex')
  return createHash('sha256').update(signature).digest('hex') === createHash('sha256').update(expected).digest('hex')
}

export function createSignedStorageUrlForKey(key: string, expiresSeconds = 300): string | null {
  const cleanKey = cleanStorageKey(key)
  const cfg = getS3Config()
  if (!cfg) return signLocalStorageDownloadPath(cleanKey, Date.now() + Math.max(1, Math.min(300, expiresSeconds)) * 1000)

  const endpoint = new URL(cfg.endpoint)
  const privateRepresentative = cleanKey.startsWith('representatives-private/')
  const bucket = privateRepresentative ? cfg.privateRepresentativeBucket : cfg.bucket
  if (!bucket || (privateRepresentative && bucket === cfg.bucket)) throw new Error('PRIVATE_FILE_STORAGE_NOT_CONFIGURED')
  const encodedKey = encodeS3Key(cleanKey)
  const canonicalUri = `/${encodeS3PathPart(bucket)}/${encodedKey}`
  const now = new Date()
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
  const dateStamp = amzDate.slice(0, 8)
  const scope = `${dateStamp}/${cfg.region}/s3/aws4_request`
  const signedHeaders = 'host'
  const query: Array<[string, string]> = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${cfg.accessKeyId}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(Math.max(1, Math.min(300, Math.floor(expiresSeconds))))],
    ['X-Amz-SignedHeaders', signedHeaders],
  ]
  const canonicalQuery = query.map(([k, v]) => `${encodeS3PathPart(k)}=${encodeS3PathPart(v)}`).sort().join('&')
  const canonicalRequest = ['GET', canonicalUri, canonicalQuery, `host:${endpoint.host}\n`, signedHeaders, 'UNSIGNED-PAYLOAD'].join('\n')
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n')
  const kDate = hmac(`AWS4${cfg.secretAccessKey}`, dateStamp)
  const kRegion = hmac(kDate, cfg.region)
  const kService = hmac(kRegion, 's3')
  const kSigning = hmac(kService, 'aws4_request')
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex')
  return `${endpoint.origin}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`
}

async function putToS3CompatibleStorage(input: { buffer: Buffer }, key: string, mimeType: string): Promise<StoredFileResult | null> {
  const signed = signS3Request({
    method: 'PUT',
    key,
    payloadHash: sha256Hex(input.buffer),
    extraHeaders: { 'content-type': mimeType },
  })
  if (!signed) return null

  const res = await fetch(signed.url, {
    method: 'PUT',
    headers: signed.headers,
    body: new Uint8Array(input.buffer),
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`S3_UPLOAD_FAILED:${res.status}:${detail.slice(0, 180)}`)
  }

  return {
    provider: 's3',
    key,
    url: signed.publicUrl || (isPrivateStorageKey(key) ? getStorageDownloadPathForKey(key) : ''),
    size: input.buffer.byteLength,
    mimeType,
  }
}

async function getFromS3CompatibleStorage(key: string, mimeType: string): Promise<{ buffer: Buffer; mimeType: string } | null> {
  const signed = signS3Request({ method: 'GET', key, payloadHash: 'UNSIGNED-PAYLOAD' })
  if (!signed) return null

  const res = await fetch(signed.url, {
    method: 'GET',
    headers: signed.headers,
    cache: 'no-store',
  })
  if (!res.ok) return null
  return {
    buffer: Buffer.from(await res.arrayBuffer()),
    mimeType: res.headers.get('content-type') || mimeType,
  }
}

async function putToLocalStorage(input: { buffer: Buffer }, key: string, mimeType: string): Promise<StoredFileResult> {
  if (process.env.NODE_ENV === 'production' && process.env.AACT_ALLOW_LOCAL_UPLOADS !== 'true') {
    throw new Error('FILE_STORAGE_NOT_CONFIGURED')
  }
  const privateKey = isPrivateStorageKey(key)
  const root = privateKey ? path.join(process.cwd(), '.data', 'private-uploads') : path.join(process.cwd(), 'public', 'uploads')
  const absolutePath = path.join(root, key)
  await fs.mkdir(path.dirname(absolutePath), { recursive: true })
  await fs.writeFile(absolutePath, input.buffer)
  return {
    provider: 'local',
    key,
    url: privateKey ? getStorageDownloadPathForKey(key) : `/uploads/${key}`,
    size: input.buffer.byteLength,
    mimeType,
  }
}

export function storageErrorMessage(error: unknown): string {
  const raw = String((error as any)?.message || error || '')
  if (raw.includes('FILE_STORAGE_NOT_CONFIGURED')) {
    return 'لم يتم ضبط تخزين الملفات الخارجي. يرجى إضافة إعدادات AACT_S3_ENDPOINT وAACT_S3_BUCKET وAACT_S3_ACCESS_KEY_ID وAACT_S3_SECRET_ACCESS_KEY، أو تفعيل AACT_ALLOW_LOCAL_UPLOADS=true للتجارب فقط.'
  }
  if (raw.includes('S3_UPLOAD_FAILED')) {
    return 'تعذر رفع الملف إلى التخزين الخارجي. تحقق من مفاتيح التخزين والصلاحيات واسم الحاوية.'
  }
  if (raw.includes('EMPTY_FILE')) return 'الملف فارغ أو غير صالح للرفع.'
  return 'تعذر حفظ الملف خارج قاعدة البيانات. حاول مرة أخرى أو راجع إعدادات التخزين.'
}

export function getPublicStorageUrlForKey(key: string): string | null {
  const cleanKey = cleanStorageKey(key)
  if (isPrivateStorageKey(cleanKey)) return null
  const cfg = getS3Config()
  if (!cfg?.publicBaseUrl) return null
  return `${cfg.publicBaseUrl}/${encodeS3Key(cleanKey)}`
}

export async function storeFileBuffer(input: StoreFileInput): Promise<StoredFileResult> {
  if (!Buffer.isBuffer(input.buffer) || input.buffer.byteLength === 0) throw new Error('EMPTY_FILE')

  const mimeType = String(input.mimeType || 'application/octet-stream').slice(0, 160)
  const digest = sha256Hex(input.buffer).slice(0, 16)
  const namespace = cleanSegment(input.namespace, 'uploads')
  const key = `${namespace}/${isoDateFolder()}/${randomUUID()}-${digest}-${cleanFileName(input.fileName)}`

  if (isPrivateStorageKey(key)) {
    // Private platform files must never be written to a public webroot or public S3 endpoint.
    const cfg = getS3Config()
    if (namespace.startsWith('representatives-private/') && cfg && (!cfg.privateRepresentativeBucket || cfg.privateRepresentativeBucket === cfg.bucket)) {
      throw new Error('PRIVATE_FILE_STORAGE_NOT_CONFIGURED')
    }
    const s3 = await putToS3CompatibleStorage(input, key, mimeType)
    if (s3) return { ...s3, url: namespace.startsWith('representatives-private/') ? '' : getStorageDownloadPathForKey(key) }
    if (process.env.NODE_ENV === 'production') throw new Error('PRIVATE_FILE_STORAGE_NOT_CONFIGURED')
    return putToLocalStorage(input, key, mimeType)
  }
  const s3 = await putToS3CompatibleStorage(input, key, mimeType)
  if (s3) return s3

  return putToLocalStorage(input, key, mimeType)
}

export async function storeFileBufferAtKey(input: StoreFileAtKeyInput): Promise<StoredFileResult> {
  if (!Buffer.isBuffer(input.buffer) || input.buffer.byteLength === 0) throw new Error('EMPTY_FILE')

  const mimeType = String(input.mimeType || 'application/octet-stream').slice(0, 160)
  const key = cleanStorageKey(input.key)

  const s3 = await putToS3CompatibleStorage(input, key, mimeType)
  if (s3) return s3

  return putToLocalStorage(input, key, mimeType)
}

export function externalStoredFile(url: string, fileName: string, mimeType?: string | null, size?: number | null): StoredFileResult {
  return {
    provider: 'external-url',
    key: url,
    url,
    size: Number(size || 0),
    mimeType: String(mimeType || 'application/octet-stream'),
  }
}

export async function readStoredFile(input: ReadStoredFileInput): Promise<{ buffer: Buffer; mimeType: string } | null> {
  const mimeType = String(input.mimeType || 'application/octet-stream')
  const provider = String(input.provider || '')
  const key = String(input.key || '').trim()
  const url = String(input.url || '').trim()

  if (provider === 's3' && key) {
    const stored = await getFromS3CompatibleStorage(key, mimeType)
    if (stored) return stored
  }

  if (provider === 'local' && key) {
    const root = isPrivateStorageKey(key)
      ? path.join(process.cwd(), '.data', 'private-uploads')
      : path.join(process.cwd(), 'public', 'uploads')
    const absolutePath = path.join(root, key)
    try {
      return { buffer: await fs.readFile(absolutePath), mimeType }
    } catch {
      return null
    }
  }

  if (url && /^https?:\/\//i.test(url)) {
    const res = await safeFetchStoredUrl(url)
    if (!res.ok) return null
    return {
      buffer: Buffer.from(await res.arrayBuffer()),
      mimeType: res.headers.get('content-type') || mimeType,
    }
  }

  return null
}

export async function getFileBufferFromStorageOrBase64(input: ReadStoredFileInput): Promise<{ buffer: Buffer; mimeType: string } | null> {
  const stored = await readStoredFile(input)
  if (stored) return stored
  if (input.data) {
    return { buffer: Buffer.from(input.data, 'base64'), mimeType: String(input.mimeType || 'application/octet-stream') }
  }
  return null
}
