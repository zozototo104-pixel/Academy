import { inflateRawSync } from 'zlib'
import { PDFDocument } from 'pdf-lib'
import QRCode from 'qrcode'
import sharp from 'sharp'
import { certificateVerificationUrl } from '@/lib/w3c/certificate-credential'
import { readStoredFile, storeFileBuffer } from '@/lib/storage'

export type LegacyCertificateMime = 'application/pdf' | 'image/png' | 'image/jpeg'
export type QrPosition = 'BOTTOM_LEFT' | 'BOTTOM_RIGHT' | 'TOP_LEFT' | 'TOP_RIGHT'
export type QrSize = 'S' | 'M' | 'L'
export type LegacyStampLayout = {
  qr: { x: number; y: number; size: number; visible?: boolean }
  serial: { x: number; y: number; width: number; fontSize: number; visible?: boolean }
}

export const LEGACY_CERTIFICATE_UPLOAD_MAX_BYTES = 10 * 1024 * 1024
export const LEGACY_CERTIFICATE_ZIP_MAX_BYTES = 50 * 1024 * 1024
export const LEGACY_CERTIFICATE_ZIP_MAX_FILES = 300
export const LEGACY_CERTIFICATE_ZIP_MAX_UNCOMPRESSED_BYTES = 200 * 1024 * 1024

type ParsedZipEntry = { fileName: string; buffer: Buffer; error?: undefined } | { fileName: string; buffer?: undefined; error: string }

export function sniffLegacyCertificateMime(buffer: Buffer): LegacyCertificateMime | null {
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf'
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  return null
}

export function normalizeQrPosition(value: unknown): QrPosition {
  const v = String(value || '').trim().toUpperCase()
  return v === 'BOTTOM_RIGHT' || v === 'TOP_LEFT' || v === 'TOP_RIGHT' ? v : 'BOTTOM_LEFT'
}

export function normalizeQrSize(value: unknown): QrSize {
  const v = String(value || '').trim().toUpperCase()
  return v === 'S' || v === 'L' ? v : 'M'
}

function clampNumber(value: unknown, min: number, max: number, fallback: number) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback
}

function legacySizePercent(size: QrSize) {
  if (size === 'S') return 12
  if (size === 'L') return 20
  return 16
}

function legacyLayoutFromPosition(positionValue: unknown, sizeValue: unknown): LegacyStampLayout {
  const position = normalizeQrPosition(positionValue)
  const size = normalizeQrSize(sizeValue)
  const qrSize = legacySizePercent(size)
  const isRight = position.endsWith('RIGHT')
  const isTop = position.startsWith('TOP')
  const x = isRight ? 100 - (7 + qrSize / 2) : 7 + qrSize / 2
  const qrY = isTop ? 7 + qrSize / 2 : 100 - (10 + qrSize / 2)
  const serialY = isTop ? Math.min(96, qrY + qrSize / 2 + 4) : 95
  return {
    qr: { x, y: qrY, size: qrSize, visible: true },
    serial: { x, y: serialY, width: Math.max(20, qrSize * 1.8), fontSize: size === 'L' ? 1.6 : size === 'S' ? 1.0 : 1.25, visible: true },
  }
}

export function normalizeStampLayout(value: unknown, sizeValue: unknown = 'M'): LegacyStampLayout {
  let raw: any = value
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.startsWith('{')) {
      try { raw = JSON.parse(trimmed) } catch { raw = null }
    }
  }
  const fallback = legacyLayoutFromPosition(typeof value === 'string' ? value : 'BOTTOM_LEFT', sizeValue)
  if (!raw || typeof raw !== 'object' || !raw.qr || !raw.serial) return fallback
  return {
    qr: {
      x: clampNumber(raw.qr?.x, 1, 99, fallback.qr.x),
      y: clampNumber(raw.qr?.y, 1, 99, fallback.qr.y),
      size: clampNumber(raw.qr?.size, 4, 45, fallback.qr.size),
      visible: raw.qr?.visible !== false,
    },
    serial: {
      x: clampNumber(raw.serial?.x, 1, 99, fallback.serial.x),
      y: clampNumber(raw.serial?.y, 1, 99, fallback.serial.y),
      width: clampNumber(raw.serial?.width, 6, 95, fallback.serial.width),
      fontSize: clampNumber(raw.serial?.fontSize, 0.5, 8, fallback.serial.fontSize),
      visible: raw.serial?.visible !== false,
    },
  }
}

export function serializeStampLayout(layout: LegacyStampLayout) {
  return JSON.stringify(normalizeStampLayout(layout))
}

async function createPdfFromImage(buffer: Buffer, mime: LegacyCertificateMime) {
  const metadata = await sharp(buffer).metadata()
  const width = Number(metadata.width || 0)
  const height = Number(metadata.height || 0)
  if (!width || !height) throw new Error('INVALID_IMAGE_DIMENSIONS')
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([width, height])
  const image = mime === 'image/png' ? await pdf.embedPng(buffer) : await pdf.embedJpg(buffer)
  page.drawImage(image, { x: 0, y: 0, width, height })
  return pdf
}

export async function stampLegacyCertificatePdf(input: {
  buffer: Buffer
  mime: LegacyCertificateMime
  serial: string
  qrToken: string
  qrPosition?: QrPosition | string | null
  qrSize?: QrSize | string | null
  stampLayout?: LegacyStampLayout | string | null
}) {
  const pdf = input.mime === 'application/pdf'
    ? await PDFDocument.load(input.buffer)
    : await createPdfFromImage(input.buffer, input.mime)
  const [page] = pdf.getPages()
  if (!page) throw new Error('EMPTY_PDF')

  const { width, height } = page.getSize()
  const minDimension = Math.min(width, height)
  const layout = normalizeStampLayout(input.stampLayout || input.qrPosition || 'BOTTOM_LEFT', input.qrSize || 'M')
  const effectiveQrSize = Math.max(28, Math.min(minDimension * 0.45, minDimension * (layout.qr.size / 100)))
  const qrPng = await QRCode.toBuffer(certificateVerificationUrl({ qrToken: input.qrToken }), {
    type: 'png',
    width: Math.round(effectiveQrSize * 3),
    margin: 1,
    errorCorrectionLevel: 'M',
  })
  const qrImage = await pdf.embedPng(qrPng)
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const margin = 4
  const qrCenterX = width * (layout.qr.x / 100)
  const qrCenterY = height * ((100 - layout.qr.y) / 100)
  const qrX = Math.max(margin, Math.min(width - effectiveQrSize - margin, qrCenterX - effectiveQrSize / 2))
  const qrY = Math.max(margin, Math.min(height - effectiveQrSize - margin, qrCenterY - effectiveQrSize / 2))
  const serial = String(input.serial || '').trim()
  const textSize = Math.max(6, Math.min(72, minDimension * (layout.serial.fontSize / 100)))
  const textWidth = font.widthOfTextAtSize(serial, textSize)
  const serialCenterX = width * (layout.serial.x / 100)
  const serialCenterY = height * ((100 - layout.serial.y) / 100)
  const textX = Math.max(margin, Math.min(width - textWidth - margin, serialCenterX - textWidth / 2))
  const textY = Math.max(margin, Math.min(height - textSize - margin, serialCenterY - textSize / 2))

  if (layout.qr.visible !== false) page.drawImage(qrImage, { x: qrX, y: qrY, width: effectiveQrSize, height: effectiveQrSize })
  if (layout.serial.visible !== false && serial) page.drawText(serial, { x: textX, y: textY, size: textSize, font, color: rgb(0.05, 0.05, 0.05) })
  return Buffer.from(await pdf.save())
}

export async function readLegacyCertificateStoredFile(key: string, mimeType?: string | null) {
  const mime = String(mimeType || 'application/octet-stream')
  return (await readStoredFile({ provider: 's3', key, mimeType: mime, maxBytes: LEGACY_CERTIFICATE_UPLOAD_MAX_BYTES }).catch(() => null))
    || (await readStoredFile({ provider: 'local', key, mimeType: mime, maxBytes: LEGACY_CERTIFICATE_UPLOAD_MAX_BYTES }).catch(() => null))
}

export async function storeLegacyCertificateOriginal(buffer: Buffer, fileName: string, mimeType: LegacyCertificateMime) {
  return storeFileBuffer({ buffer, fileName, mimeType, namespace: 'certificates/legacy-originals' })
}

export async function storeLegacyCertificateStamped(buffer: Buffer, fileName: string) {
  return storeFileBuffer({ buffer, fileName, mimeType: 'application/pdf', namespace: 'certificates/legacy-stamped' })
}

function readUInt16(buffer: Buffer, offset: number) {
  return buffer.readUInt16LE(offset)
}

function readUInt32(buffer: Buffer, offset: number) {
  return buffer.readUInt32LE(offset)
}

export function parseZipEntries(buffer: Buffer) {
  const min = Math.max(0, buffer.length - 65557)
  let eocd = -1
  for (let i = buffer.length - 22; i >= min; i--) {
    if (readUInt32(buffer, i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('INVALID_ZIP')
  const entriesCount = readUInt16(buffer, eocd + 10)
  const centralOffset = readUInt32(buffer, eocd + 16)
  const entries: ParsedZipEntry[] = []
  let acceptedFileCount = 0
  let totalUncompressedBytes = 0
  let offset = centralOffset
  for (let index = 0; index < entriesCount; index++) {
    if (readUInt32(buffer, offset) !== 0x02014b50) throw new Error('INVALID_ZIP_CENTRAL_DIRECTORY')
    const method = readUInt16(buffer, offset + 10)
    const compressedSize = readUInt32(buffer, offset + 20)
    const uncompressedSize = readUInt32(buffer, offset + 24)
    const fileNameLength = readUInt16(buffer, offset + 28)
    const extraLength = readUInt16(buffer, offset + 30)
    const commentLength = readUInt16(buffer, offset + 32)
    const localHeaderOffset = readUInt32(buffer, offset + 42)
    const fileName = buffer.subarray(offset + 46, offset + 46 + fileNameLength).toString('utf8')
    offset += 46 + fileNameLength + extraLength + commentLength
    if (!fileName || fileName.endsWith('/') || fileName.includes('__MACOSX/')) continue
    acceptedFileCount += 1
    if (acceptedFileCount > LEGACY_CERTIFICATE_ZIP_MAX_FILES) {
      entries.push({ fileName, error: 'ZIP_TOO_MANY_FILES' })
      continue
    }
    if (uncompressedSize > LEGACY_CERTIFICATE_UPLOAD_MAX_BYTES) {
      entries.push({ fileName, error: 'FILE_TOO_LARGE' })
      continue
    }
    if (totalUncompressedBytes + uncompressedSize > LEGACY_CERTIFICATE_ZIP_MAX_UNCOMPRESSED_BYTES) {
      entries.push({ fileName, error: 'ZIP_TOTAL_TOO_LARGE' })
      continue
    }
    if (readUInt32(buffer, localHeaderOffset) !== 0x04034b50) throw new Error('INVALID_ZIP_LOCAL_HEADER')
    const localNameLength = readUInt16(buffer, localHeaderOffset + 26)
    const localExtraLength = readUInt16(buffer, localHeaderOffset + 28)
    const dataOffset = localHeaderOffset + 30 + localNameLength + localExtraLength
    const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize)
    let data: Buffer | null = null
    try {
      data = method === 0
        ? compressed
        : method === 8
          ? inflateRawSync(compressed, { maxOutputLength: LEGACY_CERTIFICATE_UPLOAD_MAX_BYTES } as any)
          : null
    } catch {
      entries.push({ fileName, error: 'FILE_TOO_LARGE' })
      continue
    }
    if (!data) continue
    if (data.byteLength > LEGACY_CERTIFICATE_UPLOAD_MAX_BYTES) {
      entries.push({ fileName, error: 'FILE_TOO_LARGE' })
      continue
    }
    if (totalUncompressedBytes + data.byteLength > LEGACY_CERTIFICATE_ZIP_MAX_UNCOMPRESSED_BYTES) {
      entries.push({ fileName, error: 'ZIP_TOTAL_TOO_LARGE' })
      continue
    }
    if (data.byteLength !== uncompressedSize && uncompressedSize > 0) throw new Error('ZIP_SIZE_MISMATCH')
    totalUncompressedBytes += data.byteLength
    entries.push({ fileName, buffer: Buffer.from(data) })
  }
  return entries
}
