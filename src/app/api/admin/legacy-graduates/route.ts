import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { requireAdmin } from '@/lib/auth'
import {
  createLegacyGraduate,
  isValidLegacyGraduateEmail,
  LegacyGraduateError,
  normalizeLegacyGraduateEmail,
  sendLegacyGraduatePasswordSetup,
} from '@/lib/legacy-graduates'

function cleanString(value: unknown) {
  return String(value ?? '').trim().replace(/\s+/g, ' ')
}

function cleanOptional(value: unknown) {
  const text = cleanString(value)
  return text || null
}

function parseScore(value: unknown) {
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

function parseIssuedAt(value: unknown) {
  if (value instanceof Date) return value
  if (typeof value === 'number' && Number.isFinite(value)) return excelSerialToDate(value)
  const text = cleanString(value)
  if (!text) return null
  const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (iso) return new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])))
  const dmy = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (dmy) return new Date(Date.UTC(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1])))
  const parsed = new Date(text)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function isUniqueConflict(error: unknown, field: string) {
  return error instanceof Prisma.PrismaClientKnownRequestError
    && error.code === 'P2002'
    && String(error.meta?.target || '').includes(field)
}

// POST /api/admin/legacy-graduates — إضافة خريج سابق واحد
export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const body = await req.json().catch(() => ({}))

    const email = normalizeLegacyGraduateEmail(body.email)
    if (!email || !isValidLegacyGraduateEmail(email)) {
      return NextResponse.json({ error: 'البريد الإلكتروني مطلوب وبصيغة صحيحة', code: 'INVALID_EMAIL' }, { status: 400 })
    }

    const issuedAt = parseIssuedAt(body.issuedAt)
    if (!issuedAt) {
      return NextResponse.json({ error: 'تاريخ التخرج مطلوب وبصيغة صحيحة', code: 'INVALID_ISSUED_AT' }, { status: 400 })
    }

    const finalScore = parseScore(body.finalScore)
    if (Number.isNaN(finalScore)) {
      return NextResponse.json({ error: 'المعدل يجب أن يكون رقماً صحيحاً', code: 'INVALID_FINAL_SCORE' }, { status: 400 })
    }

    const result = await createLegacyGraduate({
      name: cleanOptional(body.name),
      email,
      phone: cleanOptional(body.phone),
      country: cleanOptional(body.country),
      programId: cleanString(body.programId),
      grade: cleanOptional(body.grade),
      finalScore,
      issuedAt,
      legacySerial: cleanOptional(body.legacySerial),
    }, admin)

    const emailStatus = await sendLegacyGraduatePasswordSetup(req, result.user.id)
    return NextResponse.json({
      ok: true,
      emailStatus,
      userCreated: result.userCreated,
      user: { id: result.user.id, email: result.user.email, name: result.user.name },
      enrollment: result.enrollment,
      certificate: result.certificate,
    }, { status: result.userCreated ? 201 : 200 })
  } catch (error: any) {
    if (error?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    }
    if (error instanceof LegacyGraduateError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status })
    }
    if (isUniqueConflict(error, 'legacySerial')) {
      return NextResponse.json({ error: 'رقم الشهادة الورقية مستخدم مسبقاً', code: 'LEGACY_SERIAL_DUPLICATE' }, { status: 409 })
    }
    console.error('admin legacy-graduates POST error:', error)
    return NextResponse.json({ error: 'تعذر إضافة الخريج السابق' }, { status: 500 })
  }
}
