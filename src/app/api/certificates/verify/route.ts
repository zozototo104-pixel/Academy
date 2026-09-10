import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { academicProfileFromRules, buildAcademicProgramProfile } from '@/lib/program-tracks'

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
          select: {
            titleAr: true, titleEn: true, description: true, category: true, hours: true, admissionRules: true,
            units: { orderBy: { order: 'asc' }, select: { order: true, title: true } },
            books: { orderBy: { createdAt: 'asc' }, select: { title: true, titleEn: true, semester: true } },
            assignments: { where: { status: { not: 'ARCHIVED' } }, orderBy: [{ semester: 'asc' }, { createdAt: 'asc' }], select: { title: true, semester: true, points: true, status: true } },
            programExams: { orderBy: [{ semester: 'asc' }, { createdAt: 'desc' }], select: { title: true, semester: true, status: true, _count: { select: { questions: true } } } },
            _count: { select: { units: true } },
          },
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
          units: program.units,
          books: program.books,
          assignments: program.assignments,
          exams: program.programExams.map((e) => ({ title: e.title, semester: e.semester, status: e.status, questionCount: e._count.questions })),
          academicProfile: academicProfileFromRules(program.admissionRules),
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
