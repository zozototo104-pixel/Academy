import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { pdfDate, pdfPercent, pdfResponse, pdfSafeText, renderOfficialPdf } from '@/lib/pdf/official'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ id: string }> | { id: string } }

type ResultRow = {
  order: number
  question: string
  points: string
  result: string
}

function passLabel(passed?: boolean | null) {
  if (passed === true) return 'ناجح / PASSED'
  if (passed === false) return 'غير ناجح / NOT PASSED'
  return 'قيد التصحيح / PENDING'
}

function passTone(passed?: boolean | null) {
  return passed === true ? 'success' : passed === false ? 'warning' : 'info'
}

function resultRows(answers: Array<any>): ResultRow[] {
  return answers
    .slice()
    .sort((a, b) => (a.question?.order || 0) - (b.question?.order || 0))
    .map((a) => ({
      order: a.question?.order || 0,
      question: pdfSafeText(a.question?.text, 'Question'),
      points: `${a.points ?? 0}/${a.maxPoints ?? a.question?.points ?? '—'}`,
      result: a.isCorrect == null ? '—' : a.isCorrect ? 'صحيح' : 'يحتاج مراجعة',
    }))
}

export async function GET(_req: NextRequest, context: RouteContext) {
  try {
    const user = await requireUser()
    const { id } = await Promise.resolve(context.params)
    if (!id) return NextResponse.json({ error: 'معرّف النتيجة مطلوب' }, { status: 400 })

    const unitAttempt = await db.examAttempt.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, name: true, email: true, country: true, role: true } },
        exam: { select: { title: true, passScore: true, unit: { select: { title: true, program: { select: { titleAr: true, titleEn: true } } } } } },
        answers: { include: { question: { select: { order: true, text: true, points: true } } } },
      },
    })

    const programAttempt = unitAttempt
      ? null
      : await db.programExamAttempt.findUnique({
          where: { id },
          include: {
            user: { select: { id: true, name: true, email: true, country: true, role: true } },
            exam: { select: { title: true, passScore: true, semester: true, program: { select: { titleAr: true, titleEn: true } } } },
            answers: { include: { question: { select: { order: true, text: true, points: true } } } },
          },
        })

    const attempt = unitAttempt || programAttempt
    if (!attempt) return NextResponse.json({ error: 'النتيجة غير موجودة' }, { status: 404 })
    if (user.role !== 'ADMIN' && attempt.userId !== user.id) return NextResponse.json({ error: 'صلاحيات غير كافية لعرض النتيجة' }, { status: 403 })

    const isProgram = !unitAttempt
    const exam: any = attempt.exam
    const finalScore = isProgram ? ((attempt as any).finalScore ?? attempt.score) : attempt.score
    const programTitle = isProgram ? exam.program?.titleAr : exam.unit?.program?.titleAr
    const part = isProgram ? `امتحان الفصل ${exam.semester === 2 ? 'الثاني' : 'الأول'}` : exam.unit?.title
    const submittedAt = isProgram ? ((attempt as any).submittedAt || (attempt as any).createdAt) : (attempt as any).submittedAt

    const pdf = await renderOfficialPdf({
      title: 'نتيجة الطالب الرسمية',
      subtitle: 'Official Student Result',
      documentLabel: 'STUDENT RESULT',
      reference: attempt.id,
      issuedAt: new Date(),
      status: passLabel(attempt.passed),
      statusTone: passTone(attempt.passed),
      sections: [
        {
          title: 'بيانات الطالب / Student Details',
          rows: [
            { label: 'الاسم', value: attempt.user.name },
            { label: 'البريد', value: attempt.user.email, dir: 'ltr' },
            { label: 'الدولة', value: attempt.user.country || '—' },
          ],
        },
        {
          title: 'بيانات الاختبار / Exam Details',
          rows: [
            { label: 'البرنامج', value: programTitle || '—' },
            { label: 'الاختبار', value: exam.title },
            { label: 'الجزء / الفصل', value: part || '—' },
            { label: 'درجة النجاح', value: pdfPercent(exam.passScore), dir: 'ltr' },
            { label: 'درجة الطالب', value: finalScore == null ? '—' : pdfPercent(finalScore), dir: 'ltr' },
            { label: 'تاريخ التسليم', value: pdfDate(submittedAt), dir: 'ltr' },
          ],
        },
      ],
      tables: [
        {
          title: 'تفاصيل الأسئلة / Answer Summary',
          columns: ['السؤال', 'النقاط', 'الحالة'],
          rows: resultRows((attempt as any).answers).map((r) => [r.question, r.points, r.result]),
          maxRows: 18,
        },
      ],
      footer: 'هذه النتيجة صادرة إلكترونياً من منصة AACT وتعكس البيانات المسجلة وقت الإصدار.',
    })

    return pdfResponse(pdf, `AACT-RESULT-${attempt.id}.pdf`)
  } catch (e) {
    console.error('result PDF error:', e)
    if (e instanceof Error && e.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'تسجيل الدخول مطلوب' }, { status: 401 })
    return NextResponse.json({ error: 'تعذر توليد PDF النتيجة' }, { status: 500 })
  }
}
