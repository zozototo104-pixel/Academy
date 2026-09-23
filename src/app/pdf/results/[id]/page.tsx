import { notFound } from 'next/navigation'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'
import {
  AccessDeniedPdf,
  OfficialPdfDocument,
  PdfField,
  PdfSection,
  PdfTable,
  formatPdfDate,
  statusArabic,
} from '../../_components/OfficialDocument'

export const dynamic = 'force-dynamic'

type PageProps = {
  params: Promise<{ id: string }>
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function canView(user: any, ownerId?: string | null): boolean {
  if (!user) return false
  if (user.role === 'ADMIN') return true
  return Boolean(ownerId && ownerId === user.id)
}

function parseFeedback(value?: string | null): string {
  if (!value) return '—'
  try {
    const parsed = JSON.parse(value)
    if (typeof parsed === 'string') return parsed
    if (parsed?.summary) return String(parsed.summary)
    if (parsed?.feedback) return String(parsed.feedback)
    return JSON.stringify(parsed).slice(0, 700)
  } catch {
    return value
  }
}

export default async function ResultPdfPage({ params, searchParams }: PageProps) {
  const { id } = await params
  const query = searchParams ? await searchParams : {}
  const user = await getCurrentUser()
  const attempt = await db.programExamAttempt.findUnique({
    where: { id },
    include: {
      user: { select: { id: true, name: true, email: true, country: true } },
      exam: { include: { program: { select: { titleAr: true, category: true } } } },
      answers: {
        include: { question: { select: { order: true, text: true, type: true, points: true, sourceBookTitle: true, cognitiveSkill: true, difficulty: true } } },
        orderBy: { question: { order: 'asc' } },
      },
    },
  })

  if (!attempt) notFound()
  if (!canView(user, attempt.userId)) return <AccessDeniedPdf />

  const score = attempt.finalScore != null ? attempt.finalScore : attempt.score
  const autoPrint = firstParam(query.print) === '1'

  return (
    <OfficialPdfDocument
      title="نتيجة امتحان رسمية"
      subtitle="بيان نتيجة امتحان صادر من منصة الأكاديمية الأمريكية للاستشارات والتدريب."
      reference={attempt.id}
      status={attempt.passed == null ? statusArabic(attempt.status) : attempt.passed ? 'ناجح' : 'غير ناجح'}
      issuedAt={attempt.submittedAt || attempt.createdAt}
      autoPrint={autoPrint}
      footerNote="تعكس هذه الوثيقة النتيجة المسجلة في المنصة وقت الإصدار، وقد تتغير فقط عند وجود اعتراض أو مراجعة إدارية موثقة."
    >
      <PdfSection title="بيانات الطالب والامتحان">
        <div className="grid gap-3 md:grid-cols-3">
          <PdfField label="اسم الطالب" value={attempt.user.name} />
          <PdfField label="البريد" value={attempt.user.email} />
          <PdfField label="الدولة" value={attempt.user.country || '—'} />
          <PdfField label="البرنامج" value={attempt.exam.program.titleAr} />
          <PdfField label="الامتحان" value={attempt.exam.title} />
          <PdfField label="الفصل" value={attempt.exam.semester === 2 ? 'الفصل الثاني' : 'الفصل الأول'} />
          <PdfField label="الدرجة" value={score != null ? `${score}%` : 'قيد التصحيح'} />
          <PdfField label="حد النجاح" value={`${attempt.exam.passScore}%`} />
          <PdfField label="مدة الحل" value={attempt.durationUsedMin != null ? `${attempt.durationUsedMin} دقيقة` : '—'} />
        </div>
      </PdfSection>

      <PdfSection title="ملخص التصحيح">
        <div className="rounded-2xl bg-[#fbfcff] p-4 text-sm font-bold leading-relaxed text-slate-700">
          {parseFeedback(attempt.feedback)}
        </div>
        {attempt.appealStatus !== 'NONE' ? (
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <PdfField label="حالة الاعتراض" value={statusArabic(attempt.appealStatus)} />
            <PdfField label="رد المراجعة" value={attempt.appealResponse || 'قيد المراجعة'} />
          </div>
        ) : null}
      </PdfSection>

      <PdfSection title="تفاصيل الإجابات المسجلة">
        <PdfTable
          headers={['#', 'السؤال', 'الدرجة', 'ملاحظات']}
          rows={attempt.answers.map((a) => [
            a.question.order,
            <span><b>{a.question.text}</b><br /><span className="text-xs text-slate-500">{a.question.sourceBookTitle || a.question.cognitiveSkill || a.question.difficulty || '—'}</span></span>,
            `${a.points ?? '—'} / ${a.maxPoints ?? a.question.points}`,
            a.aiFeedback || (a.isCorrect == null ? 'قيد التصحيح' : a.isCorrect ? 'إجابة صحيحة' : 'إجابة غير مكتملة/غير صحيحة'),
          ])}
        />
      </PdfSection>
    </OfficialPdfDocument>
  )
}
