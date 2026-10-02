type FileKind = 'jpeg' | 'png' | 'webp' | 'heic' | 'pdf' | 'docx' | 'xlsx' | 'xls' | 'txt' | 'csv'

type SignatureValidationResult =
  | { ok: true; kind: FileKind; mimeType: string }
  | { ok: false; error: string }

const EXTENSIONS_BY_KIND: Record<FileKind, string[]> = {
  jpeg: ['jpg', 'jpeg'],
  png: ['png'],
  webp: ['webp'],
  heic: ['heic', 'heif'],
  pdf: ['pdf'],
  docx: ['docx'],
  xlsx: ['xlsx'],
  xls: ['xls'],
  txt: ['txt'],
  csv: ['csv'],
}

const MIMES_BY_KIND: Record<FileKind, string[]> = {
  jpeg: ['image/jpeg'],
  png: ['image/png'],
  webp: ['image/webp'],
  heic: ['image/heic', 'image/heif'],
  pdf: ['application/pdf'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  xls: ['application/vnd.ms-excel'],
  txt: ['text/plain'],
  csv: ['text/csv', 'application/csv', 'application/vnd.ms-excel'],
}

const CANONICAL_MIME_BY_KIND: Record<FileKind, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  txt: 'text/plain',
  csv: 'text/csv',
}

function extensionOf(fileName: string): string {
  const match = String(fileName || '').trim().toLowerCase().match(/\.([a-z0-9]+)$/)
  return match?.[1] || ''
}

function normalizedMime(mimeType?: string | null): string {
  return String(mimeType || '').split(';')[0].trim().toLowerCase()
}

function startsWithBytes(buffer: Buffer, bytes: number[]) {
  if (buffer.byteLength < bytes.length) return false
  return bytes.every((value, index) => buffer[index] === value)
}

function isZip(buffer: Buffer) {
  return startsWithBytes(buffer, [0x50, 0x4b, 0x03, 0x04]) ||
    startsWithBytes(buffer, [0x50, 0x4b, 0x05, 0x06]) ||
    startsWithBytes(buffer, [0x50, 0x4b, 0x07, 0x08])
}

function bufferIncludesAscii(buffer: Buffer, value: string) {
  return buffer.includes(Buffer.from(value, 'ascii'))
}

function isIsoBaseMedia(buffer: Buffer) {
  return buffer.byteLength >= 12 && buffer.toString('ascii', 4, 8) === 'ftyp'
}

function detectImageOrPdfOrOffice(buffer: Buffer): FileKind | null {
  if (startsWithBytes(buffer, [0xff, 0xd8, 0xff])) return 'jpeg'
  if (startsWithBytes(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png'
  if (buffer.byteLength >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp'
  if (startsWithBytes(buffer, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'pdf'
  if (startsWithBytes(buffer, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'xls'
  if (isIsoBaseMedia(buffer)) {
    const brandWindow = buffer.toString('ascii', 8, Math.min(buffer.byteLength, 64))
    if (/(heic|heix|hevc|hevx|heif|mif1|msf1)/.test(brandWindow)) return 'heic'
  }
  if (isZip(buffer)) {
    if (bufferIncludesAscii(buffer, 'word/')) return 'docx'
    if (bufferIncludesAscii(buffer, 'xl/')) return 'xlsx'
  }
  return null
}

function isLikelyUtf8Text(buffer: Buffer) {
  if (buffer.byteLength === 0) return false
  const sample = buffer.subarray(0, Math.min(buffer.byteLength, 4096))
  if (sample.includes(0x00)) return false
  let control = 0
  for (const byte of sample) {
    const allowedControl = byte === 0x09 || byte === 0x0a || byte === 0x0d
    if (byte < 0x20 && !allowedControl) control += 1
  }
  if (control > 0) return false
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample)
    return true
  } catch {
    return false
  }
}

function mimeLooksCompatible(kind: FileKind, mime: string) {
  if (!mime || mime === 'application/octet-stream') return true
  return MIMES_BY_KIND[kind].includes(mime)
}

function extensionLooksCompatible(kind: FileKind, ext: string) {
  if (!ext) return true
  return EXTENSIONS_BY_KIND[kind].includes(ext)
}

function kindFromTextRequest(ext: string, mime: string): FileKind | null {
  if (ext === 'csv') return 'csv'
  if (ext === 'txt') return 'txt'
  if (MIMES_BY_KIND.csv.includes(mime)) return 'csv'
  if (MIMES_BY_KIND.txt.includes(mime)) return 'txt'
  return null
}

export function validateAdmissionFileSignature(input: {
  buffer: Buffer
  fileName: string
  mimeType?: string | null
}): SignatureValidationResult {
  const { buffer, fileName } = input
  if (!Buffer.isBuffer(buffer) || buffer.byteLength === 0) {
    return { ok: false, error: 'الملف فارغ أو غير صالح.' }
  }

  const ext = extensionOf(fileName)
  const mime = normalizedMime(input.mimeType)
  const detected = detectImageOrPdfOrOffice(buffer)
  const requestedTextKind = kindFromTextRequest(ext, mime)
  const kind = detected || (requestedTextKind && isLikelyUtf8Text(buffer) ? requestedTextKind : null)

  if (!kind) {
    return { ok: false, error: 'محتوى الملف لا يطابق صيغ الصور أو PDF أو Word/Excel أو TXT/CSV المسموحة.' }
  }

  if (!extensionLooksCompatible(kind, ext)) {
    return { ok: false, error: 'امتداد الملف لا يطابق محتواه الحقيقي.' }
  }

  if (!mimeLooksCompatible(kind, mime)) {
    return { ok: false, error: 'نوع الملف المعلن لا يطابق محتواه الحقيقي.' }
  }

  return { ok: true, kind, mimeType: CANONICAL_MIME_BY_KIND[kind] }
}
