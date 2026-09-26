import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { nextCertSerial } from '@/lib/settings'
import { audit, notify } from '@/lib/notify'
import { emailCertificateIssued } from '@/lib/mailer'
import { adminPaginationMeta, cleanAdminQuery, parseAdminPagination } from '@/lib/admin-query'
import { evaluateProgramCertificateEligibility } from '@/lib/certificate-eligibility'
import { randomBytes } from 'crypto'

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

// POST /api/admin/certificates — إصدار شهادة برنامج بعد التحقق من الاستحقاق الأكاديمي والمالي
export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const { admissionId, holderName, program, country, userId } = await req.json()

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
        ? await db.program.findFirst({ where: { titleAr: resolvedProgramTitle }, select: { id: true } })
        : null

    if (!resolvedHolderName || !resolvedProgramTitle) {
      return NextResponse.json({ error: 'اسم صاحب الشهادة والبرنامج مطلوبان' }, { status: 400 })
    }
    if (!resolvedUserId || !resolvedProgram?.id) {
      return NextResponse.json({ error: 'لا يمكن إصدار شهادة برنامج يدوياً دون ربطها بطالب وبرنامج دراسي للتحقق من النجاح الأكاديمي.' }, { status: 400 })
    }

    const eligibility = await evaluateProgramCertificateEligibility({
      userId: resolvedUserId,
      programId: resolvedProgram.id,
      admissionId: app?.id || null,
    })
    if (!eligibility.ok) {
      return NextResponse.json(
        { error: eligibility.error || 'لا يمكن إصدار الشهادة قبل اكتمال شروط النجاح الأكاديمي.', eligibility },
        { status: 400 }
      )
    }

    const serial = await nextCertSerial()
    const cert = await db.certificate.create({
      data: {
        serial,
        qrToken: randomBytes(16).toString('hex'),
        type: 'PROGRAM_COMPLETION',
        holderName: resolvedHolderName,
        program: resolvedProgramTitle,
        grade: eligibility.gradeLabel,
        country: (app?.country || country || '').trim() || null,
        userId: resolvedUserId,
        admissionId: app?.id || null,
      },
    })

    if (app?.id) {
      await db.admissionApplication.update({ where: { id: app.id }, data: { status: 'CERTIFIED' } })
    }
    await db.enrollment.updateMany({
      where: { userId: resolvedUserId, programId: resolvedProgram.id },
      data: { certificateNo: cert.serial, status: 'COMPLETED', ...(eligibility.score !== null ? { finalScore: eligibility.score } : {}) },
    })

    const linkedUser = await db.user.findUnique({ where: { id: resolvedUserId }, select: { email: true, name: true } })
    await notify(resolvedUserId, 'CERTIFICATE', 'تم إصدار شهادتك', `أُصدرت شهادتك لبرنامج «${cert.program}» برقم ${serial} — متاحة في بوابة الطالب.`, 'dashboard')
    const email = app?.email || linkedUser?.email
    if (email) await emailCertificateIssued(email, linkedUser?.name || cert.holderName, cert.program, serial)

    await audit(admin, 'ISSUE_CERTIFICATE', 'Certificate', cert.id, `${serial} — ${cert.holderName} (${cert.program})`)
    return NextResponse.json({ ok: true, certificate: cert, eligibility })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    }
    console.error('admin certificates POST error:', e)
    return NextResponse.json({ error: 'تعذر إصدار الشهادة' }, { status: 500 })
  }
}
