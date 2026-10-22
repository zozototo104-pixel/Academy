// Lecture-video storage helpers: independent SigV4 signing for lecture
// videos ONLY. The platform signer in src/lib/storage.ts clamps signed
// URLs to 300 seconds and is shared by other features, so it is left
// completely untouched; lecture playback needs one-hour URLs, direct
// browser uploads (presigned PUT) and server-side verification (HEAD).
// Configuration comes from the same AACT_S3_* environment variables.

import { createHash, createHmac, randomUUID } from 'crypto'
import { createSignedStorageUrlForKey } from '@/lib/storage'

export const LECTURE_VIDEO_URL_TTL_SEC = 3600
export const LECTURE_UPLOAD_PREFIX = 'lectures/videos/'
export const DEFAULT_LECTURE_VIDEO_MAX_BYTES = 2 * 1024 * 1024 * 1024 // 2 GiB

export const LECTURE_UPLOAD_TYPES: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
}

type S3Config = {
  endpoint: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  region: string
}

function getLectureS3Config(): S3Config | null {
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
  }
}

export function isLectureStorageConfigured(): boolean {
  return getLectureS3Config() !== null
}

export function lectureVideoMaxBytes(): number {
  const raw = Number(process.env.AACT_LECTURE_VIDEO_MAX_BYTES ?? '')
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_LECTURE_VIDEO_MAX_BYTES
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value).digest()
}

function encodePart(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
}

function encodeKey(key: string): string {
  return key.split('/').map(encodePart).join('/')
}

function signingKey(cfg: S3Config, dateStamp: string): Buffer {
  const kDate = hmac(`AWS4${cfg.secretAccessKey}`, dateStamp)
  const kRegion = hmac(kDate, cfg.region)
  const kService = hmac(kRegion, 's3')
  return hmac(kService, 'aws4_request')
}

function amzDates(now: Date): { amzDate: string; dateStamp: string } {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
  return { amzDate, dateStamp: amzDate.slice(0, 8) }
}

function canonicalUri(cfg: S3Config, key: string): string {
  return `/${encodePart(cfg.bucket)}/${encodeKey(key)}`
}

// Presigned query-string URL for GET (playback, 1h) or PUT (direct upload).
export function presignLectureObject(args: {
  method: 'GET' | 'PUT'
  key: string
  expiresSec: number
}): string | null {
  const cfg = getLectureS3Config()
  if (!cfg) return null
  const endpoint = new URL(cfg.endpoint)
  const { amzDate, dateStamp } = amzDates(new Date())
  const scope = `${dateStamp}/${cfg.region}/s3/aws4_request`
  const uri = canonicalUri(cfg, args.key)
  const query: Array<[string, string]> = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${cfg.accessKeyId}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(Math.max(1, Math.floor(args.expiresSec)))],
    ['X-Amz-SignedHeaders', 'host'],
  ]
  const canonicalQuery = query
    .map(([k, v]) => `${encodePart(k)}=${encodePart(v)}`)
    .sort()
    .join('&')
  const canonicalRequest = [args.method, uri, canonicalQuery, `host:${endpoint.host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n')
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n')
  const signature = createHmac('sha256', signingKey(cfg, dateStamp)).update(stringToSign).digest('hex')
  return `${endpoint.origin}${uri}?${canonicalQuery}&X-Amz-Signature=${signature}`
}

// One-hour playback URL for a lecture video file. Falls back to the
// platform's short-lived local download path when S3 is not configured
// (local development files); storage keys are never exposed either way.
export function createLectureVideoSignedUrl(key: string): string | null {
  if (!isLectureStorageConfigured()) {
    return createSignedStorageUrlForKey(key)
  }
  return presignLectureObject({ method: 'GET', key, expiresSec: LECTURE_VIDEO_URL_TTL_SEC })
}

export function createLectureUploadUrl(key: string): string | null {
  return presignLectureObject({ method: 'PUT', key, expiresSec: LECTURE_VIDEO_URL_TTL_SEC })
}

export function newLectureUploadKey(mimeType: string): string | null {
  const ext = LECTURE_UPLOAD_TYPES[mimeType]
  if (!ext) return null
  return `${LECTURE_UPLOAD_PREFIX}${randomUUID()}.${ext}`
}

// A row created by the upload flow counts as confirmed only after the
// server verified the object and recorded its real size.
export function isUnconfirmedLectureUpload(video: { storageKey: string | null; sizeBytes: bigint | number | null }): boolean {
  return Boolean(video.storageKey?.startsWith(LECTURE_UPLOAD_PREFIX)) && video.sizeBytes == null
}

// Server-side object verification (header-signed HEAD request).
export async function headLectureObject(
  key: string,
): Promise<{ sizeBytes: number; contentType: string | null } | null> {
  const cfg = getLectureS3Config()
  if (!cfg) return null
  const endpoint = new URL(cfg.endpoint)
  const { amzDate, dateStamp } = amzDates(new Date())
  const scope = `${dateStamp}/${cfg.region}/s3/aws4_request`
  const uri = canonicalUri(cfg, key)
  const emptyHash = sha256Hex('')
  const headers: Record<string, string> = {
    host: endpoint.host,
    'x-amz-content-sha256': emptyHash,
    'x-amz-date': amzDate,
  }
  const signedHeaders = Object.keys(headers).sort().join(';')
  const canonicalHeaders = signedHeaders
    .split(';')
    .map((h) => `${h}:${headers[h]}\n`)
    .join('')
  const canonicalRequest = ['HEAD', uri, '', canonicalHeaders, signedHeaders, emptyHash].join('\n')
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n')
  const signature = createHmac('sha256', signingKey(cfg, dateStamp)).update(stringToSign).digest('hex')
  const authorization = `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  try {
    const res = await fetch(`${endpoint.origin}${uri}`, {
      method: 'HEAD',
      headers: { 'x-amz-content-sha256': emptyHash, 'x-amz-date': amzDate, authorization },
    })
    if (!res.ok) return null
    const size = Number(res.headers.get('content-length') ?? '')
    if (!Number.isFinite(size)) return null
    return { sizeBytes: size, contentType: res.headers.get('content-type') }
  } catch {
    return null
  }
}
