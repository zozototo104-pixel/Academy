import * as XLSX from 'xlsx'
import { db } from '@/lib/db'
import { isValidLegacyGraduateEmail, normalizeLegacyGraduateEmail } from '@/lib/legacy-graduates'

export const LEGACY_GRADUATE_IMPORT_MAX_BYTES = 5 * 1024 * 1024
export const LEGACY_GRADUATE_IMPORT_MAX_ROWS = 2000

export type LegacyImportRow = {
  rowNumber: number
  name?: string | null
  nameEn?: string | null
  email?: string | null
  phone?: string | null
  country?: string | null
  program?: string | null
  programId?: string | null
  programEn?: string | null
  grade?: string | null
  gradeEn?: string | null
  finalScore?: number | null
  issuedAt?: Date | null
  legacySerial?: string | null
  errors: string[]
  programSuggestion?: string | null
}

type ProgramOption = { id: string; slug: string; titleAr: string; titleEn: string | null }

const HEADER_ALIASES: Record<string, string[]> = {
  name: ['name', 'full name', 'holder name', 'الاسم', 'اسم', 'اسم الخريج'],
  nameEn: ['name en', 'english name', 'holder name en', 'الاسم بالإنجليزي'],
  email: ['email', 'e-mail', 'mail', 'البريد', 'الإيميل', 'ايميل', 'البريد الإلكتروني'],
  phone: ['phone', 'mobile', 'الجوال', 'الهاتف', 'رقم الجوال'],
  country: ['country', 'الدولة', 'البلد'],
  program: ['program', 'program slug', 'program title', 'البرنامج', 'اسم البرنامج'],
  grade: ['grade', 'التقدير', 'تقدير'],
  finalScoreText: ['finalscore', 'final score', 'score', 'المعدل', 'الدرجة', 'النسبة'],
  issuedAtText: ['issuedat', 'issued at', 'graduation date', 'تاريخ التخرج', 'تاريخ الشهادة'],
  legacySerial: ['legacyserial', 'legacy serial', 'certificate no', 'certificate number', 'old certificate number', 'رقم الشهادة', 'رقم الشهادة الورقية', 'رقم الشهادة القديم'],
}

function cleanString(value: unknown) {
  return String(value ?? '').trim().replace(/\s+/g, ' ')
}

function cleanOptional(value: unknown) {
  const text = cleanString(value)
  return text || null
}

function normalizeHeader(value: unknown) {
  return cleanString(value).toLowerCase().replace(/[\s_\-.]+/g, '')
}

function canonicalHeader(value: unknown) {
  const normalized = normalizeHeader(value)
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    if (aliases.some((alias) => normalizeHeader(alias) === normalized)) return field
  }
  return null
}

export function parseLegacyGraduateFinalScore(value: unknown) {
  if (value == null || value === '') return null
  const n = typeof value === 'number' ? value : Number(String(value).replace(',', '.'))
  if (!Number.isFinite(n)) return Number.NaN
  return n
}

function excelSerialToDate(serial: number) {
  const utcDays = Math.floor(serial - 25569)
  const utcValue = utcDays * 86400
  const dateInfo = new Date(utcValue * 1000)
  return new Date(Date.UTC(dateInfo.getUTCFullYear(), dateInfo.getUTCMonth(), dateInfo.getUTCDate()))
}

function utcDateOrNull(year: number, month: number, day: number) {
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null
  return date
}

export function parseLegacyGraduateDate(value: unknown) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  if (typeof value === 'number' && Number.isFinite(value)) return excelSerialToDate(value)
  const text = cleanString(value)
  if (!text) return null
  const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (iso) return utcDateOrNull(Number(iso[1]), Number(iso[2]), Number(iso[3]))
  const dmy = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (dmy) return utcDateOrNull(Number(dmy[3]), Number(dmy[2]), Number(dmy[1]))
  const parsed = new Date(text)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function isEmptySheetRow(row: unknown[]) {
  return !row.some((cell) => cleanString(cell))
}

function rowToObject(headers: (string | null)[], row: unknown[]) {
  const out: Record<string, unknown> = {}
  headers.forEach((header, index) => {
    if (header) out[header] = row[index]
  })
  return out
}

function levenshtein(a: string, b: string) {
  const aa = a.toLowerCase()
  const bb = b.toLowerCase()
  const dp = Array.from({ length: aa.length + 1 }, (_, i) => Array(bb.length + 1).fill(0))
  for (let i = 0; i <= aa.length; i++) dp[i][0] = i
  for (let j = 0; j <= bb.length; j++) dp[0][j] = j
  for (let i = 1; i <= aa.length; i++) {
    for (let j = 1; j <= bb.length; j++) {
      dp[i][j] = aa[i - 1] === bb[j - 1]
        ? dp[i - 1][j - 1]
        : Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]) + 1
    }
  }
  return dp[aa.length][bb.length]
}

function resolveProgram(value: string | null | undefined, programs: ProgramOption[]) {
  const text = cleanString(value)
  if (!text) return { programId: null, suggestion: null }
  const normalized = text.toLowerCase()
  const exact = programs.find((program) => (
    program.id.toLowerCase() === normalized
    || program.slug.toLowerCase() === normalized
    || program.titleAr.trim().toLowerCase() === normalized
    || String(program.titleEn || '').trim().toLowerCase() === normalized
  ))
  if (exact) return { programId: exact.id, suggestion: null }

  let best: { program: ProgramOption; score: number } | null = null
  for (const program of programs) {
    const candidates = [program.slug, program.titleAr, program.titleEn || ''].filter(Boolean)
    const score = Math.min(...candidates.map((candidate) => levenshtein(normalized, candidate.toLowerCase())))
    if (!best || score < best.score) best = { program, score }
  }
  const suggestion = best ? `${best.program.titleAr} (${best.program.slug})` : null
  return { programId: null, suggestion }
}

export function parseLegacyGraduateWorkbook(buffer: Buffer, fileName: string) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true })
  const firstSheetName = workbook.SheetNames[0]
  if (!firstSheetName) throw new Error('EMPTY_WORKBOOK')
  const sheet = workbook.Sheets[firstSheetName]
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: '' })
  const headerRow = rows[0] || []
  const headers = headerRow.map(canonicalHeader)
  const dataRows = rows.slice(1).filter((row) => !isEmptySheetRow(row))
  if (dataRows.length > LEGACY_GRADUATE_IMPORT_MAX_ROWS) throw new Error('TOO_MANY_ROWS')
  return dataRows.map((row, index) => ({ rowNumber: index + 2, raw: rowToObject(headers, row), sourceFile: fileName }))
}

export async function validateLegacyGraduateImportRows(parsedRows: { rowNumber: number; raw: Record<string, unknown> }[]): Promise<LegacyImportRow[]> {
  const programs = await db.program.findMany({ select: { id: true, slug: true, titleAr: true, titleEn: true } })
  const legacySerials = parsedRows.map((row) => cleanOptional(row.raw.legacySerial)).filter(Boolean) as string[]
  const existingSerials = legacySerials.length
    ? new Set((await db.certificate.findMany({ where: { legacySerial: { in: legacySerials } }, select: { legacySerial: true } })).map((row) => row.legacySerial).filter(Boolean) as string[])
    : new Set<string>()
  const seenLegacySerial = new Map<string, number>()
  const seenEmailProgram = new Map<string, number>()

  return parsedRows.map((parsed) => {
    const raw = parsed.raw
    const email = normalizeLegacyGraduateEmail(raw.email)
    const programText = cleanOptional(raw.program)
    const resolved = resolveProgram(programText, programs)
    const finalScore = parseLegacyGraduateFinalScore(raw.finalScoreText)
    const issuedAt = parseLegacyGraduateDate(raw.issuedAtText)
    const legacySerial = cleanOptional(raw.legacySerial)
    const errors: string[] = []

    if (!email || !isValidLegacyGraduateEmail(email)) errors.push('إيميل غلط')
    if (!programText) errors.push('البرنامج مطلوب')
    if (programText && !resolved.programId) errors.push('برنامج مش موجود')
    if (!issuedAt) errors.push('تاريخ غلط')
    if (Number.isNaN(finalScore)) errors.push('المعدل غير صالح')
    if (legacySerial && existingSerials.has(legacySerial)) errors.push('رقم الشهادة القديم مستخدم مسبقاً')
    if (legacySerial) {
      const firstRow = seenLegacySerial.get(legacySerial)
      if (firstRow) errors.push(`رقم الشهادة مكرر داخل الملف مع السطر ${firstRow}`)
      else seenLegacySerial.set(legacySerial, parsed.rowNumber)
    }
    if (email && resolved.programId) {
      const key = `${email}::${resolved.programId}`
      const firstRow = seenEmailProgram.get(key)
      if (firstRow) errors.push(`تكرار نفس الإيميل والبرنامج داخل الملف مع السطر ${firstRow}`)
      else seenEmailProgram.set(key, parsed.rowNumber)
    }

    return {
      rowNumber: parsed.rowNumber,
      name: cleanOptional(raw.name),
      email,
      phone: cleanOptional(raw.phone),
      country: cleanOptional(raw.country),
      program: programText,
      programId: resolved.programId,
      grade: cleanOptional(raw.grade),
      finalScore,
      issuedAt,
      legacySerial,
      errors,
      programSuggestion: resolved.suggestion,
    }
  })
}

export function createLegacyGraduatesTemplateBuffer() {
  const rows = [
    ['الاسم', 'الإيميل', 'الجوال', 'الدولة', 'البرنامج', 'التقدير', 'المعدل', 'تاريخ التخرج', 'رقم الشهادة القديم'],
    ['أحمد محمد', 'ahmad@example.com', '+970599000000', 'فلسطين', 'program-slug-or-titleAr', 'امتياز', 95, '2024-06-30', 'OLD-2024-001'],
  ]
  const worksheet = XLSX.utils.aoa_to_sheet(rows)
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, worksheet, 'الخريجون السابقون')
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer
}
