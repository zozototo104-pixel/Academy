import { inflateRawSync } from 'zlib'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { PDFDocument } from 'pdf-lib'
import QRCode from 'qrcode'
import sharp from 'sharp'
import { certificateVerificationUrl } from '@/lib/w3c/certificate-credential'
import { readStoredFile, storeFileBuffer } from '@/lib/storage'
import { STAMP_FONT_BUNDLES } from './stamp-fonts-data'

// Fonts embedded with the app (see stamp-fonts-data.ts) so stamp text
// renders even on servers with no system fonts (production previews
// rendered every stamp field as tofu boxes when the renderer found no
// usable font). The SVG asks for Arial and Noto Naskh Arabic; this config
// maps them onto the embedded files.

// Decode the embedded fonts to a temp directory (once per container) and
// return it. The directory is stable for the lifetime of the temp area, so
// a later call reuses the decoded files instead of rewriting them.
export function bundledStampFontsDir() {
  const fontsDir = path.join(os.tmpdir(), 'aact-stamp-fonts', 'fonts')
  mkdirSync(fontsDir, { recursive: true })
  for (const bundle of STAMP_FONT_BUNDLES) {
    const target = path.join(fontsDir, bundle.name)
    if (!existsSync(target)) {
      writeFileSync(target, Buffer.from(bundle.data, 'base64'))
    }
  }
  return fontsDir
}

export function stampFontsConfContent(fontsDir: string) {
  return `<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig>\n  <dir>${escXml(fontsDir)}</dir>\n  <alias><family>Arial</family><prefer><family>Liberation Sans</family></prefer></alias>\n  <alias><family>sans-serif</family><prefer><family>Liberation Sans</family></prefer></alias>\n</fontconfig>\n`
}

// Point fontconfig at the embedded fonts before the first stamp render in
// this process. Respects an explicitly configured FONTCONFIG_FILE (operator
// or test isolation) and never throws: if setup fails the renderer falls
// back to its previous system-font behavior.
export function ensureStampFonts() {
  if (process.env.FONTCONFIG_FILE) return
  try {
    const fontsDir = bundledStampFontsDir()
    const confDir = path.join(os.tmpdir(), 'aact-stamp-fonts')
    mkdirSync(confDir, { recursive: true })
    const confPath = path.join(confDir, 'fonts.conf')
    const content = stampFontsConfContent(fontsDir)
    if (!existsSync(confPath) || readFileSync(confPath, 'utf8') !== content) {
      writeFileSync(confPath, content)
    }
    process.env.FONTCONFIG_FILE = confPath
    if (!process.env.XDG_CACHE_HOME) process.env.XDG_CACHE_HOME = path.join(confDir, 'cache')
  } catch (error) {
    console.warn('stamp fonts setup failed, using system fonts', error)
  }
}

export type LegacyCertificateMime = 'application/pdf' | 'image/png' | 'image/jpeg'
export type QrPosition = 'BOTTOM_LEFT' | 'BOTTOM_RIGHT' | 'TOP_LEFT' | 'TOP_RIGHT'
export type QrSize = 'S' | 'M' | 'L'
export type StampLang = 'en' | 'ar'
export type StampTextField = {
  x: number
  y: number
  width: number
  fontSize: number
  color?: string
  align?: 'left' | 'center' | 'right'
  fontFamily?: string
  lang?: StampLang
  visible?: boolean
}
export type LegacyStampLayout = {
  holderName: StampTextField
  program: StampTextField
  grade: StampTextField
  issuedAt: StampTextField
  serial: StampTextField
  qr: { x: number; y: number; size: number; visible?: boolean }
}
export type StampValues = {
  holderName?: string | null
  holderNameEn?: string | null
  program?: string | null
  programEn?: string | null
  grade?: string | null
  gradeEn?: string | null
  issuedAt?: Date | string | null
  serial?: string | null
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

const TEXT_FIELDS = ['holderName', 'program', 'grade', 'issuedAt', 'serial'] as const

function textField(x: number, y: number, width = 70, fontSize = 2.2, extra: Partial<StampTextField> = {}): StampTextField {
  return { x, y, width, fontSize, color: '#0f2b46', align: 'center', fontFamily: 'Arial', lang: 'en', visible: true, ...extra }
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
    holderName: textField(50, 36, 72, 4.2, { visible: false }),
    program: textField(50, 51, 76, 2.5, { color: '#a8841a', visible: false }),
    grade: textField(50, 62, 44, 1.7, { visible: false }),
    issuedAt: textField(18, 90, 26, 1.15, { align: 'left', visible: false }),
    serial: textField(x, serialY, Math.max(20, qrSize * 1.8), size === 'L' ? 1.6 : size === 'S' ? 1.0 : 1.25),
    qr: { x, y: qrY, size: qrSize, visible: true },
  }
}

function normalizeTextField(raw: any, fallback: StampTextField): StampTextField {
  if (!raw || typeof raw !== 'object') return { ...fallback }
  const lang = raw.lang === 'ar' ? 'ar' : fallback.lang || 'en'
  const align = raw.align === 'left' || raw.align === 'right' || raw.align === 'center' ? raw.align : fallback.align || 'center'
  return {
    x: clampNumber(raw.x, 1, 99, fallback.x),
    y: clampNumber(raw.y, 1, 99, fallback.y),
    width: clampNumber(raw.width, 6, 95, fallback.width),
    fontSize: clampNumber(raw.fontSize, 0.5, 8, fallback.fontSize),
    color: String(raw.color || fallback.color || '#0f2b46'),
    align,
    fontFamily: String(raw.fontFamily || fallback.fontFamily || (lang === 'ar' ? 'Noto Naskh Arabic' : 'Arial')),
    lang,
    visible: typeof raw.visible === 'boolean' ? raw.visible : fallback.visible,
  }
}

function normalizeQrField(raw: any, fallback: LegacyStampLayout['qr']): LegacyStampLayout['qr'] {
  if (!raw || typeof raw !== 'object') return { ...fallback }
  return {
    x: clampNumber(raw.x, 1, 99, fallback.x),
    y: clampNumber(raw.y, 1, 99, fallback.y),
    size: clampNumber(raw.size, 4, 45, fallback.size),
    visible: typeof raw.visible === 'boolean' ? raw.visible : fallback.visible,
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
  if (!raw || typeof raw !== 'object') return fallback
  return {
    holderName: normalizeTextField(raw.holderName, fallback.holderName),
    program: normalizeTextField(raw.program, fallback.program),
    grade: normalizeTextField(raw.grade, fallback.grade),
    issuedAt: normalizeTextField(raw.issuedAt, fallback.issuedAt),
    serial: normalizeTextField(raw.serial, fallback.serial),
    qr: normalizeQrField(raw.qr, fallback.qr),
  }
}

export function serializeStampLayout(layout: LegacyStampLayout) {
  return JSON.stringify(normalizeStampLayout(layout))
}

function escXml(value: unknown) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

function cssAnchor(align?: string) {
  if (align === 'left') return 'start'
  if (align === 'right') return 'end'
  return 'middle'
}

function stampDate(value: Date | string | null | undefined, lang: StampLang) {
  const d = value ? new Date(value) : new Date()
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString(lang === 'ar' ? 'ar-EG' : 'en-US', { year: 'numeric', month: 'long', day: 'numeric' })
}

function gradeArabicToEnglish(value?: string | null) {
  const text = String(value || '').trim()
  if (!text) return ''
  if (text.includes('امتياز')) return text.replace(/امتياز/g, 'Excellent').replace(/—\s*Excellent/, '— Excellent')
  if (text.includes('جيد جداً') || text.includes('جيد جدا')) return text.replace(/جيد جداً|جيد جدا/g, 'Very Good').replace(/—\s*Very Good/, '— Very Good')
  if (text.includes('جيد')) return text.replace(/جيد/g, 'Good').replace(/—\s*Good/, '— Good')
  if (text.includes('ناجح') || text.includes('مقبول')) return text.replace(/ناجح|مقبول/g, 'Pass').replace(/—\s*Pass/, '— Pass')
  if (text.includes('غير مجتاز')) return text.replace(/غير مجتاز/g, 'Not Passed').replace(/—\s*Not Passed/, '— Not Passed')
  return text
}

export function stampValue(field: typeof TEXT_FIELDS[number], cfg: StampTextField, values: StampValues) {
  const lang = cfg.lang === 'ar' ? 'ar' : 'en'
  if (field === 'holderName') return lang === 'en' ? (values.holderNameEn || values.holderName || '') : (values.holderName || '')
  if (field === 'program') return lang === 'en' ? (values.programEn || values.program || '') : (values.program || '')
  if (field === 'grade') return lang === 'en' ? (values.gradeEn || gradeArabicToEnglish(values.grade) || '') : (values.grade || '')
  if (field === 'issuedAt') return stampDate(values.issuedAt, lang)
  return values.serial || ''
}

export function certificateStampOverlayScale(width: number, height: number) {
  return width < 2000 || height < 2000 ? 4 : 1
}

export async function renderCertificateStampTextOverlayPng(input: {
  width: number
  height: number
  layout: LegacyStampLayout
  values: StampValues
}) {
  ensureStampFonts()
  const { width, height, layout, values } = input
  const minDimension = Math.min(width, height)
  const textNodes = TEXT_FIELDS.map((field) => {
    const cfg = layout[field]
    const value = stampValue(field, cfg, values)
    if (cfg.visible === false || !value) return ''
    const fontSize = Math.max(6, Math.min(90, minDimension * (cfg.fontSize / 100)))
    const x = width * (cfg.x / 100)
    const y = height * (cfg.y / 100)
    const maxWidth = width * (cfg.width / 100)
    const dir = cfg.lang === 'ar' ? 'rtl' : 'ltr'
    const family = cfg.fontFamily || (dir === 'rtl' ? 'Noto Naskh Arabic' : 'Arial')
    return `<text x="${x}" y="${y}" text-anchor="${cssAnchor(cfg.align)}" direction="${dir}" unicode-bidi="plaintext" style="font-family:${escXml(family)},Arial,sans-serif;font-size:${fontSize}px;font-weight:900;fill:${escXml(cfg.color || '#0f2b46')};dominant-baseline:middle">${escXml(value)}</text><rect x="${x - maxWidth / 2}" y="${y - fontSize}" width="0" height="0" fill="none"/>`
  }).join('')
  if (!textNodes) return null
  const scale = certificateStampOverlayScale(width, height)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width * scale}" height="${height * scale}" viewBox="0 0 ${width} ${height}">${textNodes}</svg>`
  return sharp(Buffer.from(svg)).png().toBuffer()
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
  values?: StampValues
}) {
  const pdf = input.mime === 'application/pdf'
    ? await PDFDocument.load(input.buffer)
    : await createPdfFromImage(input.buffer, input.mime)
  const [page] = pdf.getPages()
  if (!page) throw new Error('EMPTY_PDF')

  const { width, height } = page.getSize()
  const minDimension = Math.min(width, height)
  const layout = normalizeStampLayout(input.stampLayout || input.qrPosition || 'BOTTOM_LEFT', input.qrSize || 'M')
  const values: StampValues = { serial: input.serial, ...(input.values || {}) }
  const margin = 4
  if (layout.qr.visible !== false) {
    const effectiveQrSize = Math.max(28, Math.min(minDimension * 0.45, minDimension * (layout.qr.size / 100)))
    const qrPng = await QRCode.toBuffer(certificateVerificationUrl({ qrToken: input.qrToken }), {
      type: 'png',
      width: Math.round(effectiveQrSize * 3),
      margin: 1,
      errorCorrectionLevel: 'M',
    })
    const qrImage = await pdf.embedPng(qrPng)
    const qrCenterX = width * (layout.qr.x / 100)
    const qrCenterY = height * ((100 - layout.qr.y) / 100)
    const qrX = Math.max(margin, Math.min(width - effectiveQrSize - margin, qrCenterX - effectiveQrSize / 2))
    const qrY = Math.max(margin, Math.min(height - effectiveQrSize - margin, qrCenterY - effectiveQrSize / 2))
    page.drawImage(qrImage, { x: qrX, y: qrY, width: effectiveQrSize, height: effectiveQrSize })
  }

  const overlay = await renderCertificateStampTextOverlayPng({ width, height, layout, values })
  if (overlay) {
    const overlayImage = await pdf.embedPng(overlay)
    page.drawImage(overlayImage, { x: 0, y: 0, width, height })
  }
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
