import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { adminPaginationMeta, cleanAdminQuery, parseAdminPagination } from '@/lib/admin-query'
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

function hasOwn(obj: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(obj, key)
}

// GET /api/admin/legacy-graduates — قائمة الخريجين السابقين مع بحث
export async function GET(req: NextRequest) {
  try {
    await requireAdmin()
    const sp = req.nextUrl.searchParams
    const { page, pageSize, skip, take } = parseAdminPagination(sp, { pageSize: 25, maxPageSize: 100 })
    const search = cleanAdminQuery(sp.get('search'))
    const userIds = search
      ? (await db.user.findMany({
          where: {
            OR: [
              { email: { contains: search, mode: 'insensitive' } },
              { name: { contains: search, mode: 'insensitive' } },
              { phone: { contains: search, mode: 'insensitive' } },
            ],
          },
          select: { id: true },
          take: 100,
        })).map((user) => user.id)
      : []

    const where: Prisma.CertificateWhereInput = {
      legacy: true,
      ...(search
        ? {
            OR: [
              { serial: { contains: search, mode: 'insensitive' } },
              { legacySerial: { contains: search, mode: 'insensitive' } },
              { holderName: { contains: search, mode: 'insensitive' } },
              { program: { contains: search, mode: 'insensitive' } },
              { grade: { contains: search, mode: 'insensitive' } },
              { country: { contains: search, mode: 'insensitive' } },
              ...(userIds.length ? [{ userId: { in: userIds } }] : []),
            ],
          }
        : {}),
    }

    const [certificates, total] = await Promise.all([
      db.certificate.findMany({
        where,
        include: {
          user: { select: { id: true, email: true, name: true, phone: true, country: true } },
          enrollment: { select: { id: true, status: true, finalScore: true, certificateNo: true, programId: true } },
        },
        orderBy: { issuedAt: 'desc' },
        skip,
        take,
      }),
      db.certificate.count({ where }),
    ])

    return NextResponse.json({ certificates, total, pagination: adminPaginationMeta(page, pageSize, total) })
  } catch (error: any) {
    if (error?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    }
    console.error('admin legacy-graduates GET error:', error)
    return NextResponse.json({ error: 'تعذر تحميل الخريجين السابقين' }, { status: 500 })
  }
}

// PATCH /api/admin/legacy-graduates — تعديل بيانات شهادة قديمة أو إلغاؤها دون تغيير qrToken
export async function PATCH(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const body = await req.json().catch(() => ({} as Record<string, unknown>))
    const certId = cleanString(body.id || body.certificateId)
    if (!certId) return NextResponse.json({ error: 'معرّف الشهادة مطلوب' }, { status: 400 })

    const cert = await db.certificate.findUnique({ where: { id: certId }, include: { enrollment: { select: { id: true } } } })
    if (!cert || !cert.legacy) return NextResponse.json({ error: 'شهادة الخريج السابق غير موجودة' }, { status: 404 })

    if (body.action === 'revoke' || body.valid === false) {
      const reason = cleanOptional(body.reason || body.revokedReason) || 'إلغاء إداري'
      const updated = await db.certificate.update({
        where: { id: cert.id },
        data: { valid: false, revokedAt: new Date(), revokedReason: reason, revokedById: admin.id },
      })
      await db.auditLog.create({ data: { actorId: admin.id, actorName: admin.name || 'Admin', action: 'REVOKE_LEGACY_GRADUATE', entity: 'Certificate', entityId: cert.id, details: `${cert.serial} — ${cert.holderName} — ${reason}` } })
      return NextResponse.json({ ok: true, certificate: updated })
    }

    const data: Prisma.CertificateUncheckedUpdateInput = {}
    const holderName = cleanOptional(body.holderName || body.name)
    if (holderName) data.holderName = holderName
    if (hasOwn(body, 'program')) data.program = cleanString(body.program)
    if (hasOwn(body, 'grade')) data.grade = cleanOptional(body.grade)
    if (hasOwn(body, 'country')) data.country = cleanOptional(body.country)
    if (hasOwn(body, 'issuedAt')) {
      const issuedAt = parseIssuedAt(body.issuedAt)
      if (!issuedAt) return NextResponse.json({ error: 'تاريخ التخرج غير صالح' }, { status: 400 })
      data.issuedAt = issuedAt
    }
    if (hasOwn(body, 'legacySerial')) {
      const legacySerial = cleanOptional(body.legacySerial)
      if (legacySerial) {
        const duplicate = await db.certificate.findUnique({ where: { legacySerial } })
        if (duplicate && duplicate.id !== cert.id) {
          return NextResponse.json({ error: 'رقم الشهادة الورقية مستخدم مسبقاً', code: 'LEGACY_SERIAL_DUPLICATE' }, { status: 409 })
        }
      }
      data.legacySerial = legacySerial
    }

    const finalScoreProvided = hasOwn(body, 'finalScore')
    const finalScore = finalScoreProvided ? parseScore(body.finalScore) : undefined
    if (Number.isNaN(finalScore)) return NextResponse.json({ error: 'المعدل يجب أن يكون رقماً صحيحاً' }, { status: 400 })
    if (!Object.keys(data).length && !finalScoreProvided) return NextResponse.json({ error: 'لا توجد بيانات للتعديل' }, { status: 400 })

    const updated = await db.$transaction(async (tx) => {
      const certificate = Object.keys(data).length
        ? await tx.certificate.update({ where: { id: cert.id }, data })
        : cert
      if (finalScoreProvided && cert.enrollment?.id) {
        await tx.enrollment.update({ where: { id: cert.enrollment.id }, data: { finalScore: finalScore as number | null } })
      }
      await tx.auditLog.create({
        data: {
          actorId: admin.id,
          actorName: admin.name || 'Admin',
          action: 'UPDATE_LEGACY_GRADUATE',
          entity: 'Certificate',
          entityId: cert.id,
          details: `${cert.serial} — ${certificate.holderName}`,
        },
      })
      return certificate
    })

    return NextResponse.json({ ok: true, certificate: updated })
  } catch (error: any) {
    if (error?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    }
    if (isUniqueConflict(error, 'legacySerial')) {
      return NextResponse.json({ error: 'رقم الشهادة الورقية مستخدم مسبقاً', code: 'LEGACY_SERIAL_DUPLICATE' }, { status: 409 })
    }
    console.error('admin legacy-graduates PATCH error:', error)
    return NextResponse.json({ error: 'تعذر تعديل شهادة الخريج السابق' }, { status: 500 })
  }
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
