import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { audit, notify } from '@/lib/notify'
import { emailCertificateIssued } from '@/lib/mailer'
import { adminPaginationMeta, cleanAdminQuery, parseAdminPagination } from '@/lib/admin-query'
import { completeEnrollmentIfEligible } from '@/lib/enrollment-completion'

function cleanOptional(value: unknown) {
  const text = String(value ?? '').trim().replace(/\s+/g, ' ')
  return text || null
}

function cleanEnglishName(value: unknown) {
  const text = cleanOptional(value)
  if (!text) return null
  if (!/^[A-Za-z .'-]+$/.test(text)) throw new Error('INVALID_ENGLISH_NAME')
  return text
}

// GET /api/admin/certificates — كل الشهادات الصادرة
export async function GET(req: NextRequest) {
  try {
    await requireAdmin()
    const sp = req.nextUrl.searchParams
    const { page, pageSize, skip, take } = parseAdminPagination(sp, { pageSize: 25, maxPageSize: 100 })
    const search = cleanAdminQuery(sp.get('search'))
    const type = cleanAdminQuery(sp.get('type'))
    const status = cleanAdminQuery(sp.get('status'))
    const where: any = {
      ...(type && type !== 'ALL' ? { type } : {}),
      ...(status === 'VALID' ? { valid: true } : status === 'REVOKED' ? { valid: false } : {}),
      ...(search
        ? {
            OR: [
              { serial: { contains: search, mode: 'insensitive' } },
              { qrToken: { contains: search, mode: 'insensitive' } },
              { holderName: { contains: search, mode: 'insensitive' } },
              { program: { contains: search, mode: 'insensitive' } },
              { grade: { contains: search, mode: 'insensitive' } },
              { country: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    }
    const [certificates, total] = await Promise.all([
      db.certificate.findMany({
        where,
        orderBy: { issuedAt: 'desc' },
        skip,
        take,
      }),
      db.certificate.count({ where }),
    ])
    return NextResponse.json({ certificates, total, pagination: adminPaginationMeta(page, pageSize, total) })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    }
    console.error('admin certificates GET error:', e)
    return NextResponse.json({ error: 'تعذر تحميل الشهادات' }, { status: 500 })
  }
}

// PATCH /api/admin/certificates — إلغاء شهادة بسبب إلزامي
export async function PATCH(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const body = await req.json().catch(() => ({}))
    const { id, reason } = body
    const certId = String(id || '').trim()
    const revocationReason = String(reason || '').trim().slice(0, 1000)
    if (!certId) return NextResponse.json({ error: 'معرّف الشهادة مطلوب' }, { status: 400 })

    const cert = await db.certificate.findUnique({ where: { id: certId } })
    if (!cert) return NextResponse.json({ error: 'الشهادة غير موجودة' }, { status: 404 })

    if (body.action === 'update') {
      const updated = await db.certificate.update({
        where: { id: certId },
        data: {
          holderNameEn: cleanEnglishName(body.holderNameEn),
          programEn: cleanOptional(body.programEn),
          gradeEn: cleanOptional(body.gradeEn),
        },
      })
      await audit(admin, 'UPDATE_CERTIFICATE_ENGLISH_FIELDS', 'Certificate', certId, `${cert.serial} — ${cert.holderName}`)
      return NextResponse.json({ ok: true, certificate: updated })
    }

    if (!revocationReason) return NextResponse.json({ error: 'سبب إلغاء الشهادة إلزامي' }, { status: 400 })
    if (!cert.valid) return NextResponse.json({ error: 'الشهادة ملغاة مسبقاً' }, { status: 409 })

    const revokedAt = new Date()
    const updated = await db.certificate.update({
      where: { id: certId },
      data: { valid: false, revokedAt, revokedReason: revocationReason, revokedById: admin.id },
    })

    await audit(admin, 'REVOKE_CERTIFICATE', 'Certificate', certId, `${cert.serial} — ${cert.holderName} — ${revocationReason}`)
    return NextResponse.json({ ok: true, certificate: updated })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    }
    console.error('admin certificates PATCH error:', e)
    return NextResponse.json({ error: 'تعذر إلغاء الشهادة' }, { status: 500 })
  }
}

// POST /api/admin/certificates — إصدار شهادة برنامج من مسار الإكمال المركزي فقط
export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const { admissionId, holderName, program, country, userId, enrollmentId } = await req.json()

    const app = admissionId
      ? await db.admissionApplication.findUnique({ where: { id: admissionId } })
      : null
    if (admissionId && !app) {
      return NextResponse.json({ error: 'طلب الالتحاق المرتبط بالشهادة غير موجود' }, { status: 404 })
    }

    const resolvedHolderName = (app?.fullName || holderName || '').trim()
    const resolvedProgramTitle = (app?.program || program || '').trim()
    const resolvedUserId = app?.userId || userId || null
    const resolvedProgram = app?.programId
      ? { id: app.programId }
      : resolvedProgramTitle
        ? await db.program.findFirst({
            where: { OR: [{ titleAr: resolvedProgramTitle }, { titleAr: { contains: resolvedProgramTitle, mode: 'insensitive' } }, { titleEn: { contains: resolvedProgramTitle, mode: 'insensitive' } }] },
            select: { id: true },
          })
        : null

    const result = await completeEnrollmentIfEligible({
      enrollmentId: enrollmentId || null,
      userId: resolvedUserId,
      programId: resolvedProgram?.id || null,
      admissionId: app?.id || null,
      holderName: resolvedHolderName,
      programTitle: resolvedProgramTitle,
      country: app?.country || country || null,
      requireEligible: true,
    })

    if (!result.ok || !result.certificate) {
      return NextResponse.json(
        { error: result.error || 'لا يمكن إصدار الشهادة قبل اكتمال التسجيل والدفع وشروط النجاح.', eligibility: result.eligibility, missing: result.missing, code: result.code },
        { status: result.httpStatus || 422 }
      )
    }

    const cert = result.certificate
    const linkedUser = await db.user.findUnique({ where: { id: cert.userId }, select: { email: true, name: true } })
    await notify(cert.userId, 'CERTIFICATE', 'تم إصدار شهادتك', `أُصدرت شهادتك لبرنامج «${cert.program}» برقم ${cert.serial} — متاحة في بوابة الطالب.`, 'dashboard')
    const email = app?.email || linkedUser?.email
    if (email && result.certificateIssued) await emailCertificateIssued(email, linkedUser?.name || cert.holderName, cert.program, cert.serial)

    await audit(
      admin,
      result.certificateIssued ? 'ISSUE_CERTIFICATE' : 'COMPLETE_ENROLLMENT_EXISTING_CERTIFICATE',
      'Certificate',
      cert.id,
      `${cert.serial} — ${cert.holderName} (${cert.program}) — enrollment=${result.enrollmentId || 'unknown'}`
    )
    return NextResponse.json({ ok: true, certificate: cert, eligibility: result.eligibility, completed: result.completed })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    }
    console.error('admin certificates POST error:', e)
    return NextResponse.json({ error: 'تعذر إصدار الشهادة' }, { status: 500 })
  }
}
