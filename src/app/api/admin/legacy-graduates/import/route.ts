import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { requireAdmin } from '@/lib/auth'
import {
  createLegacyGraduate,
  LegacyGraduateError,
  sendLegacyGraduatePasswordSetup,
} from '@/lib/legacy-graduates'
import {
  LEGACY_GRADUATE_IMPORT_MAX_BYTES,
  parseLegacyGraduateWorkbook,
  validateLegacyGraduateImportRows,
} from '@/lib/legacy-graduates-import'

export const maxDuration = 60

const ALLOWED_EXTENSIONS = new Set(['.xlsx', '.xls', '.csv'])
const DEFAULT_BATCH_LIMIT = 50
const MAX_BATCH_LIMIT = 50

function extensionOf(fileName: string) {
  const i = fileName.lastIndexOf('.')
  return i >= 0 ? fileName.slice(i).toLowerCase() : ''
}

function isUniqueConflict(error: unknown, field: string) {
  return error instanceof Prisma.PrismaClientKnownRequestError
    && error.code === 'P2002'
    && String(error.meta?.target || '').includes(field)
}

function errorMessage(error: unknown) {
  if (error instanceof LegacyGraduateError) return error.message
  if (isUniqueConflict(error, 'legacySerial')) return 'legacySerial مكرر'
  if (error instanceof Error) return error.message
  return 'تعذر حفظ السطر'
}

function parseBatchNumber(value: unknown, fallback: number) {
  const parsed = Number(String(value ?? '').trim())
  return Number.isFinite(parsed) ? Math.floor(parsed) : fallback
}

type LegacyGraduateImportResult = {
  rowNumber: number
  ok: boolean
  errors?: string[]
  emailStatus?: string
  userCreated?: boolean
  userId?: string
  enrollmentId?: string
  certificateId?: string
  serial?: string
}

// POST /api/admin/legacy-graduates/import — استيراد دفعة من Excel/CSV
export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const dryRun = req.nextUrl.searchParams.get('dryRun') === 'true'
    const form = await req.formData()
    const file = form.get('file')
    const dryRunFromForm = String(form.get('dryRun') || '').toLowerCase() === 'true'
    const shouldDryRun = dryRun || dryRunFromForm
    const offset = Math.max(0, parseBatchNumber(form.get('offset') ?? req.nextUrl.searchParams.get('offset'), 0))
    const requestedLimit = parseBatchNumber(form.get('limit') ?? req.nextUrl.searchParams.get('limit'), DEFAULT_BATCH_LIMIT)
    const limit = Math.min(MAX_BATCH_LIMIT, Math.max(1, requestedLimit))

    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'ملف Excel أو CSV مطلوب' }, { status: 400 })
    }
    if (file.size > LEGACY_GRADUATE_IMPORT_MAX_BYTES) {
      return NextResponse.json({ error: 'حجم الملف يتجاوز 5MB' }, { status: 413 })
    }
    const ext = extensionOf(file.name)
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return NextResponse.json({ error: 'الصيغة المسموحة: xlsx أو xls أو csv' }, { status: 400 })
    }

    let parsedRows
    try {
      parsedRows = parseLegacyGraduateWorkbook(Buffer.from(await file.arrayBuffer()), file.name)
    } catch (error: any) {
      if (error?.message === 'TOO_MANY_ROWS') return NextResponse.json({ error: 'الحد الأقصى 2000 سطر' }, { status: 400 })
      if (error?.message === 'EMPTY_WORKBOOK') return NextResponse.json({ error: 'الملف فارغ' }, { status: 400 })
      console.error('legacy graduates import parse error:', error)
      return NextResponse.json({ error: 'تعذر قراءة الملف' }, { status: 400 })
    }

    const rows = await validateLegacyGraduateImportRows(parsedRows)
    const invalidRows = rows.filter((row) => row.errors.length > 0)
    if (shouldDryRun) {
      return NextResponse.json({
        ok: true,
        dryRun: true,
        totalRows: rows.length,
        validRows: rows.length - invalidRows.length,
        invalidRows: invalidRows.length,
        rows,
      })
    }

    const rowsToProcess = rows.slice(offset, offset + limit)
    const nextOffset = offset + rowsToProcess.length < rows.length ? offset + rowsToProcess.length : null
    const results: LegacyGraduateImportResult[] = []
    for (const row of rowsToProcess) {
      if (row.errors.length > 0 || !row.email || !row.programId || !row.issuedAt) {
        results.push({ rowNumber: row.rowNumber, ok: false, errors: row.errors.length ? row.errors : ['بيانات ناقصة'] })
        continue
      }
      try {
        const saved = await createLegacyGraduate({
          name: row.name,
          email: row.email,
          phone: row.phone,
          country: row.country,
          programId: row.programId,
          grade: row.grade,
          finalScore: row.finalScore,
          issuedAt: row.issuedAt,
          legacySerial: row.legacySerial,
        }, admin)
        const emailStatus = await sendLegacyGraduatePasswordSetup(req, saved.user.id)
        results.push({
          rowNumber: row.rowNumber,
          ok: true,
          emailStatus,
          userCreated: saved.userCreated,
          userId: saved.user.id,
          enrollmentId: saved.enrollment.id,
          certificateId: saved.certificate.id,
          serial: saved.certificate.serial,
        })
      } catch (error) {
        results.push({ rowNumber: row.rowNumber, ok: false, errors: [errorMessage(error)] })
      }
    }

    const successful = results.filter((row) => row.ok).length
    return NextResponse.json({
      ok: true,
      dryRun: false,
      totalRows: rows.length,
      successful,
      failed: results.length - successful,
      results,
    })
  } catch (error: any) {
    if (error?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    }
    console.error('admin legacy-graduates import error:', error)
    return NextResponse.json({ error: 'تعذر استيراد الخريجين السابقين' }, { status: 500 })
  }
}
