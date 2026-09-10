import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { academicProfileFromRules } from '@/lib/program-tracks'

/**
 * 14.1 — السجل الأكاديمي الرسمي للطالب (Academic Transcript)
 * يجمع لكل برنامج مسجل به: درجات اختبارات الوحدات (أفضل محاولة) + امتحانات الفصول
 * + حالة التسجيل ورقم الشهادة — مع ملخص عام (عدد الامتحانات، المجتاز، المتوسط)
 * يُعرض للطالب في بوابته ويمكن طباعته كوثيقة رسمية.
 */

export async function GET() {
  try {
    const user = await requireUser()

    const [admission, enrollments] = await Promise.all([
      db.admissionApplication.findFirst({
        where: { userId: user.id, status: { not: 'REJECTED' } },
        orderBy: { createdAt: 'desc' },
        select: {
          reference: true, fullName: true, country: true, status: true, approvedAt: true, thesisDeadline: true,
          supervisor: { select: { name: true } },
        },
      }).catch(() => null),
      db.enrollment.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: 'desc' },
        include: { program: { select: {
          id: true, titleAr: true, titleEn: true, description: true, category: true, hours: true, admissionRules: true,
          units: { orderBy: { order: 'asc' }, select: { order: true, title: true } },
          books: { orderBy: { createdAt: 'asc' }, select: { title: true, titleEn: true, semester: true } },
          assignments: { where: { status: { not: 'ARCHIVED' } }, orderBy: [{ semester: 'asc' }, { createdAt: 'asc' }], select: { title: true, semester: true, points: true, status: true } },
          programExams: { orderBy: [{ semester: 'asc' }, { createdAt: 'desc' }], select: { title: true, semester: true, status: true, _count: { select: { questions: true } } } },
          _count: { select: { units: true } },
        } } },
      }),
    ])

    const programs: any[] = []
    let totalExams = 0
    let passedExams = 0
    const scores: number[] = []

    for (const en of enrollments) {
      // اختبارات الوحدات: أفضل نتيجة لكل امتحان
      const unitExams = await db.exam.findMany({
        where: { unit: { programId: en.programId }, questions: { some: {} } },
        select: {
          title: true, passScore: true,
          unit: { select: { order: true, title: true } },
          attempts: { where: { userId: user.id }, select: { score: true, passed: true, submittedAt: true }, orderBy: { score: 'desc' } },
        },
      })

      // امتحانات الفصول: أفضل نتيجة (الدرجة النهائية بعد الاعتراض تغلّب)
      const semExams = await db.programExam.findMany({
        where: { programId: en.programId, status: 'READY' },
        select: {
          title: true, passScore: true, semester: true,
          attempts: { where: { userId: user.id }, select: { score: true, finalScore: true, passed: true, submittedAt: true }, orderBy: { createdAt: 'desc' } },
        },
      })

      const unitRows = unitExams
        .sort((a, b) => a.unit.order - b.unit.order)
        .map((ex) => {
          const best = ex.attempts[0]
          totalExams++
          if (best?.passed) passedExams++
          if (best?.score != null) scores.push(best.score)
          return {
            kind: 'UNIT' as const,
            title: ex.title,
            part: ex.unit.title,
            passScore: ex.passScore,
            bestScore: best?.score ?? null,
            passed: best?.passed ?? false,
            date: best?.submittedAt ?? null,
          }
        })

      const semRows = semExams
        .sort((a, b) => a.semester - b.semester)
        .map((ex) => {
          const bestScore = Math.max(0, ...ex.attempts.map((a) => a.finalScore ?? a.score ?? 0)) || null
          const anyPassed = ex.attempts.some((a) => a.passed)
          totalExams++
          if (anyPassed) passedExams++
          if (bestScore != null) scores.push(bestScore)
          return {
            kind: 'SEMESTER' as const,
            title: ex.title,
            part: `الفصل الدراسي ${ex.semester === 2 ? 'الثاني' : 'الأول'}`,
            passScore: ex.passScore,
            bestScore,
            passed: anyPassed,
            date: ex.attempts.find((a) => a.passed)?.submittedAt ?? ex.attempts[0]?.submittedAt ?? null,
          }
        })

      let completedUnits = 0
      try { completedUnits = JSON.parse(en.completedUnits || '[]').length } catch {}

      programs.push({
        enrollmentId: en.id,
        programId: en.programId,
        title: en.program.titleAr,
        titleEn: en.program.titleEn,
        description: en.program.description,
        category: en.program.category,
        hours: en.program.hours,
        unitsCount: en.program._count.units,
        units: en.program.units,
        books: en.program.books,
        exams: en.program.programExams.map((e) => ({ title: e.title, semester: e.semester, status: e.status, questionCount: e._count.questions })),
        academicProfile: academicProfileFromRules(en.program.admissionRules),
        status: en.status,
        finalScore: en.finalScore,
        certificateNo: en.certificateNo,
        enrolledAt: en.createdAt,
        completedUnits,
        rows: [...unitRows, ...semRows],
      })
    }

    const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null

    return NextResponse.json({
      student: {
        name: admission?.fullName || user.name,
        email: user.email,
        country: admission?.country || null,
        reference: admission?.reference || null,
        supervisor: admission?.supervisor?.name || null,
        admissionStatus: admission?.status || null,
        joinedAt: user.createdAt,
      },
      programs,
      summary: {
        programsCount: programs.length,
        totalExams,
        passedExams,
        averageScore: avg,
      },
      generatedAt: new Date().toISOString(),
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'يجب تسجيل الدخول' }, { status: 401 })
    console.error('transcript error:', e)
    return NextResponse.json({ error: 'تعذر تحميل السجل الأكاديمي' }, { status: 500 })
  }
}
