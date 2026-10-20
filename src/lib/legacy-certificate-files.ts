import { inflateRawSync } from 'zlib'
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib'
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

function qrPointSize(size: QrSize) {
  if (size === 'S') return 92
  if (size === 'L') return 156
  return 124
}

function placement(pageWidth: number, pageHeight: number, size: number, position: QrPosition) {
  const margin = Math.max(28, Math.round(size * 0.22))
  const textSize = Math.max(8, Math.round(size * 0.09))
  const gap = Math.max(4, Math.round(size * 0.04))
  const x = position.endsWith('RIGHT') ? pageWidth - margin - size : margin
  const qrY = position.startsWith('TOP') ? pageHeight - margin - size : margin + textSize + gap
  const textY = position.startsWith('TOP') ? qrY - gap - textSize : margin
  return { x, qrY, textY, textSize }
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
  qrPosition?: QrPosition | null
  qrSize?: QrSize | null
}) {
  const pdf = input.mime === 'application/pdf'
    ? await PDFDocument.load(input.buffer)
    : await createPdfFromImage(input.buffer, input.mime)
  const [page] = pdf.getPages()
  if (!page) throw new Error('EMPTY_PDF')

  const position = normalizeQrPosition(input.qrPosition)
  const size = normalizeQrSize(input.qrSize)
  const qrSize = qrPointSize(size)
  const { width, height } = page.getSize()
  const effectiveQrSize = Math.min(qrSize, Math.max(64, Math.min(width, height) * 0.28))
  const qrPng = await QRCode.toBuffer(certificateVerificationUrl({ qrToken: input.qrToken }), {
    type: 'png',
    width: Math.round(effectiveQrSize * 3),
    margin: 1,
    errorCorrectionLevel: 'M',
  })
  const qrImage = await pdf.embedPng(qrPng)
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const place = placement(width, height, effectiveQrSize, position)
  const serial = String(input.serial || '').trim()
  const textWidth = font.widthOfTextAtSize(serial, place.textSize)
  const textX = Math.min(Math.max(8, place.x + (effectiveQrSize - textWidth) / 2), Math.max(8, width - textWidth - 8))

  page.drawImage(qrImage, { x: place.x, y: place.qrY, width: effectiveQrSize, height: effectiveQrSize })
  page.drawText(serial, { x: textX, y: place.textY, size: place.textSize, font, color: rgb(0.05, 0.05, 0.05) })
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
