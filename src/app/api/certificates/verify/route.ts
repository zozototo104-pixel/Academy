import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { buildAcademicProgramProfile } from '@/lib/program-tracks'

// GET /api/certificates/verify?serial=AACT-C-2026-00001 — تحقق عام من صحة الشهادة
export async function GET(req: NextRequest) {
  try {
    const serial = req.nextUrl.searchParams.get('serial')?.trim()
    const token = req.nextUrl.searchParams.get('token')?.trim()
    if (!serial && !token) {
      return NextResponse.json({ error: 'يرجى إدخال رقم الشهادة' }, { status: 400 })
    }
    const cert = await db.certificate.findFirst({
      where: serial ? { serial } : { qrToken: token! },
    })
    if (!cert) {
      return NextResponse.json({ valid: false, message: 'لا توجد شهادة بهذا الرقم — تأكد من الرقم أو تواصل مع الإدارة' })
    }
    const program = cert.program
      ? await db.program.findFirst({
          where: { titleAr: cert.program },
          select: { titleAr: true, titleEn: true, description: true, category: true, hours: true, _count: { select: { units: true } } },
        }).catch(() => null)
      : null
    const academicProfile = program
      ? buildAcademicProgramProfile({
          titleAr: program.titleAr,
          titleEn: program.titleEn,
          description: program.description,
          category: program.category,
          hours: program.hours,
          unitsCount: program._count.units,
        })
      : null
    return NextResponse.json({
      valid: cert.valid,
      certificate: {
        serial: cert.serial,
        type: cert.type,
        holderName: cert.holderName,
        program: cert.program,
        grade: cert.grade,
        country: cert.country,
        issuedAt: cert.issuedAt,
        valid: cert.valid,
        academicProfile,
      },
      message: cert.valid
        ? 'شهادة صحيحة ومسجلة رسمياً في سجلات الأكاديمية الأمريكية للاستشارات والتدريب'
        : 'الشهادة موجودة لكنها موقوفة — يرجى التواصل مع الإدارة',
    })
  } catch (e) {
    console.error('certificates verify error:', e)
    return NextResponse.json({ error: 'تعذر التحقق من الشهادة' }, { status: 500 })
  }
}
