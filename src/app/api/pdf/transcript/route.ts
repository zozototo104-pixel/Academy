import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { pdfDate, pdfPercent, pdfResponse, pdfSafeText, renderOfficialPdf } from '@/lib/pdf/official'
import { calculateFinalGrade } from '@/lib/final-grade'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function passText(value?: boolean | null) {
  if (value === true) return 'ناجح'
  if (value === false) return 'غير ناجح'
  return '—'
}

export async function GET(req: NextRequest) {
  try {
    const user = await requireUser()
    const enrollmentId = req.nextUrl.searchParams.get('enrollmentId') || undefined

    const admission = await db.admissionApplication.findFirst({
      where: { OR: [{ userId: user.id }, { email: user.email }], status: { not: 'REJECTED' } },
      orderBy: { createdAt: 'desc' },
      select: { reference: true, fullName: true, country: true, status: true, supervisor: { select: { name: true } } },
    }).catch(() => null)

    const enrollments = await db.enrollment.findMany({
      where: { userId: user.id, ...(enrollmentId ? { id: enrollmentId } : {}) },
      orderBy: { createdAt: 'desc' },
      include: { program: { select: { id: true, titleAr: true, titleEn: true, category: true, hours: true } } },
    })

    if (enrollmentId && enrollments.length === 0) return NextResponse.json({ error: 'السجل غير موجود' }, { status: 404 })

    const sections: any[] = [
      {
        title: 'بيانات الطالب / Student Details',
        rows: [
          { label: 'الاسم', value: admission?.fullName || user.name },
          { label: 'البريد', value: user.email, dir: 'ltr' as const },
          { label: 'الدولة', value: admission?.country || user.country || '—' },
          { label: 'مرجع القبول', value: admission?.reference || '—', dir: 'ltr' as const },
          { label: 'المشرف الأكاديمي', value: admission?.supervisor?.name || '—' },
        ],
      },
    ]

    const tables: any[] = []
    const scorePool: number[] = []
    let passed = 0
    let total = 0

    for (const en of enrollments) {
      const [unitAttempts, programAttempts, gradebook] = await Promise.all([
        db.examAttempt.findMany({
          where: { userId: user.id, exam: { unit: { programId: en.programId } } },
          orderBy: { submittedAt: 'desc' },
          include: { exam: { select: { title: true, passScore: true, unit: { select: { title: true, order: true } } } } },
        }),
        db.programExamAttempt.findMany({
          where: { userId: user.id, exam: { programId: en.programId } },
          orderBy: { createdAt: 'desc' },
          include: { exam: { select: { title: true, passScore: true, semester: true } } },
        }),
        calculateFinalGrade({ userId: user.id, programId: en.programId, admissionId: null }).catch(() => null),
      ])

      const rows = [
        ...unitAttempts.map((a) => ({
          kind: 'اختبار وحدة',
          title: a.exam.title,
          part: a.exam.unit.title,
          score: a.score,
          passed: a.passed,
          date: a.submittedAt,
        })),
        ...programAttempts.map((a) => ({
          kind: 'اختبار فصلي',
          title: a.exam.title,
          part: `الفصل ${a.exam.semester === 2 ? 'الثاني' : 'الأول'}`,
          score: a.finalScore ?? a.score,
          passed: a.passed,
          date: a.submittedAt || a.createdAt,
        })),
      ]

      for (const r of rows) {
        total++
        if (r.passed) passed++
        if (typeof r.score === 'number') scorePool.push(r.score)
      }

      sections.push({
        title: `البرنامج / ${en.program.titleAr}`,
        rows: [
          { label: 'الاسم الإنجليزي', value: en.program.titleEn || '—', dir: 'ltr' as const },
          { label: 'التصنيف', value: en.program.category },
          { label: 'الساعات', value: en.program.hours, dir: 'ltr' as const },
          { label: 'حالة التسجيل', value: en.status },
          { label: 'تاريخ التسجيل', value: pdfDate(en.createdAt), dir: 'ltr' as const },
          { label: 'رقم الشهادة', value: en.certificateNo || '—', dir: 'ltr' as const },
          { label: 'الدرجة النهائية', value: gradebook?.score != null ? pdfPercent(gradebook.score) : en.finalScore != null ? pdfPercent(en.finalScore) : 'قيد الاكتمال', dir: 'ltr' as const },
        ],
      })

      tables.push({
        title: `التقييمات المسجلة / ${en.program.titleAr}`,
        columns: ['التقييم', 'الجزء', 'الدرجة', 'الحالة', 'التاريخ'],
        rows: rows.length ? rows.map((r) => [r.title, r.part, r.score == null ? '—' : pdfPercent(r.score), passText(r.passed), pdfDate(r.date)]) : [['لا توجد تقييمات مسجلة', '—', '—', '—', '—']],
        maxRows: 14,
      })
    }

    const average = scorePool.length ? Math.round(scorePool.reduce((a, b) => a + b, 0) / scorePool.length) : null
    sections.push({
      title: 'ملخص السجل / Academic Summary',
      rows: [
        { label: 'عدد البرامج', value: enrollments.length, dir: 'ltr' as const },
        { label: 'عدد التقييمات', value: total, dir: 'ltr' as const },
        { label: 'التقييمات المجتازة', value: passed, dir: 'ltr' as const },
        { label: 'المتوسط العام', value: average == null ? '—' : pdfPercent(average), dir: 'ltr' as const },
      ],
    })

    const pdf = await renderOfficialPdf({
      title: 'السجل الأكاديمي الرسمي',
      subtitle: 'Official Academic Transcript',
      documentLabel: 'ACADEMIC TRANSCRIPT',
      reference: admission?.reference || user.id,
      issuedAt: new Date(),
      status: enrollments.length ? 'سجل فعّال / ACTIVE RECORD' : 'لا توجد تسجيلات / NO ENROLLMENTS',
      statusTone: enrollments.length ? 'success' : 'warning',
      sections,
      tables,
      footer: 'هذا السجل الأكاديمي صادر إلكترونياً من منصة AACT ويعكس البيانات المسجلة وقت الإصدار.',
    })

    return pdfResponse(pdf, `AACT-TRANSCRIPT-${user.id}.pdf`)
  } catch (e) {
    console.error('transcript PDF error:', e)
    if (e instanceof Error && e.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'تسجيل الدخول مطلوب' }, { status: 401 })
    return NextResponse.json({ error: 'تعذر توليد PDF السجل الأكاديمي' }, { status: 500 })
  }
}
