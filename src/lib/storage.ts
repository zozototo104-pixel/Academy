import { createHash, createHmac, randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import path from 'path'

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
    publicBaseUrl: process.env.AACT_STORAGE_PUBLIC_BASE_URL?.trim().replace(/\/+$/, '') || null,
  }
}

function signS3Request(args: {
  method: 'GET' | 'PUT'
  key: string
  payloadHash: string
  extraHeaders?: Record<string, string>
}) {
  const cfg = getS3Config()
  if (!cfg) return null

  const endpoint = new URL(cfg.endpoint)
  const encodedKey = encodeS3Key(args.key)
  const canonicalUri = `/${encodeS3PathPart(cfg.bucket)}/${encodedKey}`
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
    publicUrl: cfg.publicBaseUrl ? `${cfg.publicBaseUrl}/${encodedKey}` : url,
    headers: { ...requestHeaders, authorization },
  }
}

async function putToS3CompatibleStorage(input: StoreFileInput, key: string, mimeType: string): Promise<StoredFileResult | null> {
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
    url: signed.publicUrl,
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

async function putToLocalStorage(input: StoreFileInput, key: string, mimeType: string): Promise<StoredFileResult> {
  if (process.env.NODE_ENV === 'production' && process.env.AACT_ALLOW_LOCAL_UPLOADS !== 'true') {
    throw new Error('FILE_STORAGE_NOT_CONFIGURED')
  }
  const root = path.join(process.cwd(), 'public', 'uploads')
  const absolutePath = path.join(root, key)
  await fs.mkdir(path.dirname(absolutePath), { recursive: true })
  await fs.writeFile(absolutePath, input.buffer)
  return {
    provider: 'local',
    key,
    url: `/uploads/${key}`,
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

export async function storeFileBuffer(input: StoreFileInput): Promise<StoredFileResult> {
  if (!Buffer.isBuffer(input.buffer) || input.buffer.byteLength === 0) throw new Error('EMPTY_FILE')

  const mimeType = String(input.mimeType || 'application/octet-stream').slice(0, 160)
  const digest = sha256Hex(input.buffer).slice(0, 16)
  const namespace = cleanSegment(input.namespace, 'uploads')
  const key = `${namespace}/${isoDateFolder()}/${randomUUID()}-${digest}-${cleanFileName(input.fileName)}`

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
    const root = path.join(process.cwd(), 'public', 'uploads')
    const absolutePath = path.join(root, key)
    try {
      return { buffer: await fs.readFile(absolutePath), mimeType }
    } catch {
      return null
    }
  }

  if (url && /^https?:\/\//i.test(url)) {
    const res = await fetch(url, { cache: 'no-store' })
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
