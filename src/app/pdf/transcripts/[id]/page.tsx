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
  formatPdfMoney,
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

function parseJsonArray(value?: string | null): string[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

function canView(user: any, ownerId?: string | null): boolean {
  if (!user) return false
  if (user.role === 'ADMIN') return true
  return Boolean(ownerId && ownerId === user.id)
}

export default async function TranscriptPdfPage({ params, searchParams }: PageProps) {
  const { id } = await params
  const query = searchParams ? await searchParams : {}
  const user = await getCurrentUser()
  const enrollment = await db.enrollment.findUnique({
    where: { id },
    include: {
      user: { select: { id: true, name: true, email: true, phone: true, country: true } },
      program: {
        include: {
          units: { orderBy: [{ semester: 'asc' }, { order: 'asc' }], select: { id: true, order: true, semester: true, title: true, summary: true, status: true } },
          books: { orderBy: [{ semester: 'asc' }, { createdAt: 'asc' }], select: { title: true, author: true, semester: true, description: true } },
          programExams: { orderBy: [{ semester: 'asc' }, { createdAt: 'asc' }], select: { id: true, title: true, semester: true, status: true, passScore: true, totalPoints: true } },
          assignments: { orderBy: [{ semester: 'asc' }, { createdAt: 'asc' }], select: { id: true, title: true, type: true, semester: true, points: true, weight: true, status: true } },
        },
      },
      payments: { orderBy: { createdAt: 'desc' }, select: { invoiceNo: true, receiptNo: true, description: true, amount: true, currency: true, status: true, paidAt: true } },
    },
  })

  if (!enrollment) notFound()
  if (!canView(user, enrollment.userId)) return <AccessDeniedPdf />

  const [examAttempts, assignmentSubmissions, certificates, admission] = await Promise.all([
    db.programExamAttempt.findMany({
      where: { userId: enrollment.userId, exam: { is: { programId: enrollment.programId } } },
      orderBy: { createdAt: 'desc' },
      include: { exam: { select: { title: true, semester: true, passScore: true } } },
    }),
    db.assignmentSubmission.findMany({
      where: { userId: enrollment.userId, assignment: { is: { programId: enrollment.programId } } },
      orderBy: { submittedAt: 'desc' },
      include: { assignment: { select: { title: true, semester: true, points: true, weight: true, type: true } } },
    }),
    db.certificate.findMany({
      where: { OR: [{ enrollmentId: enrollment.id }, { userId: enrollment.userId, program: enrollment.program.titleAr }] },
      orderBy: { issuedAt: 'desc' },
      select: { serial: true, type: true, grade: true, issuedAt: true, valid: true },
    }),
    db.admissionApplication.findFirst({
      where: { userId: enrollment.userId, programId: enrollment.programId },
      orderBy: { createdAt: 'desc' },
      select: { reference: true, status: true, approvedAt: true, thesisDeadline: true, supervisionMode: true },
    }),
  ])

  const completed = new Set(parseJsonArray(enrollment.completedUnits))
  const completedCount = enrollment.program.units.filter((u) => completed.has(u.id)).length
  const totalUnits = enrollment.program.units.length
  const progress = totalUnits ? Math.round((completedCount / totalUnits) * 100) : 0
  const paidTotal = enrollment.payments.filter((p) => p.status === 'PAID').reduce((sum, p) => sum + p.amount, 0)
  const dueTotal = enrollment.payments.filter((p) => p.status !== 'PAID').reduce((sum, p) => sum + p.amount, 0)
  const autoPrint = firstParam(query.print) === '1'

  return (
    <OfficialPdfDocument
      title="السجل الأكاديمي الرسمي"
      subtitle="كشف متابعة دراسية ونتائج الطالب بناءً على سجلات منصة الأكاديمية."
      reference={admission?.reference || enrollment.certificateNo || enrollment.id}
      status={statusArabic(enrollment.status)}
      issuedAt={new Date()}
      autoPrint={autoPrint}
      footerNote="هذا السجل يوضح الوضع الأكاديمي كما هو محفوظ في المنصة بتاريخ الإصدار، ولا يغني عن الشهادة النهائية أو قرارات الإدارة عند وجود مراجعات مفتوحة."
    >
      <PdfSection title="بيانات الطالب والبرنامج">
        <div className="grid gap-3 md:grid-cols-3">
          <PdfField label="اسم الطالب" value={enrollment.user.name} />
          <PdfField label="البريد" value={enrollment.user.email} />
          <PdfField label="الدولة" value={enrollment.user.country || '—'} />
          <PdfField label="البرنامج" value={enrollment.program.titleAr} />
          <PdfField label="نوع البرنامج" value={enrollment.program.category} />
          <PdfField label="تاريخ التسجيل" value={formatPdfDate(enrollment.createdAt)} />
          <PdfField label="التقدم" value={`${completedCount}/${totalUnits} وحدة — ${progress}%`} />
          <PdfField label="النتيجة النهائية" value={enrollment.finalScore != null ? `${enrollment.finalScore}%` : 'لم تعتمد بعد'} />
          <PdfField label="رقم الشهادة" value={enrollment.certificateNo || certificates[0]?.serial || 'لم تصدر بعد'} />
        </div>
      </PdfSection>

      <PdfSection title="وحدات البرنامج">
        <PdfTable
          headers={['الفصل', 'الترتيب', 'الوحدة', 'الحالة']}
          rows={enrollment.program.units.map((u) => [
            u.semester === 2 ? 'الفصل الثاني' : u.semester === 3 ? 'بحث/مشروع' : 'الفصل الأول',
            u.order,
            <span><b>{u.title}</b>{u.summary ? <><br /><span className="text-xs text-slate-500">{u.summary}</span></> : null}</span>,
            completed.has(u.id) ? 'مكتملة' : statusArabic(u.status),
          ])}
        />
      </PdfSection>

      <PdfSection title="الكتب والمراجع المقررة">
        <PdfTable
          headers={['الفصل', 'اسم الكتاب', 'المؤلف', 'الوصف']}
          rows={enrollment.program.books.map((b) => [
            b.semester === 2 ? 'الفصل الثاني' : b.semester === 3 ? 'بحث/مشروع' : 'عام / الفصل الأول',
            b.title,
            b.author || '—',
            b.description || '—',
          ])}
        />
      </PdfSection>

      <PdfSection title="الامتحانات والواجبات">
        <div className="grid gap-5 lg:grid-cols-2">
          <PdfTable
            headers={['الامتحان', 'الفصل', 'الدرجة', 'الحالة']}
            rows={examAttempts.map((a) => [
              a.exam.title,
              a.exam.semester === 2 ? 'الثاني' : 'الأول',
              a.finalScore != null ? `${a.finalScore}%` : a.score != null ? `${a.score}%` : 'قيد التصحيح',
              a.passed == null ? statusArabic(a.status) : a.passed ? 'ناجح' : 'غير ناجح',
            ])}
          />
          <PdfTable
            headers={['التكليف', 'الفصل', 'الدرجة', 'الحالة']}
            rows={assignmentSubmissions.map((s) => [
              s.assignment.title,
              s.assignment.semester === 2 ? 'الثاني' : s.assignment.semester === 3 ? 'بحث/مشروع' : 'الأول',
              s.score != null ? `${s.score}/${s.assignment.points}` : 'قيد التصحيح',
              statusArabic(s.status),
            ])}
          />
        </div>
      </PdfSection>

      <PdfSection title="الرسوم والمدفوعات المرتبطة بالتسجيل">
        <div className="mb-4 grid gap-3 md:grid-cols-3">
          <PdfField label="إجمالي المسدد" value={formatPdfMoney(paidTotal)} />
          <PdfField label="إجمالي المستحق المفتوح" value={formatPdfMoney(dueTotal)} />
          <PdfField label="عدد الفواتير" value={enrollment.payments.length} />
        </div>
        <PdfTable
          headers={['الفاتورة', 'الوصف', 'المبلغ', 'الحالة']}
          rows={enrollment.payments.map((p) => [
            <span>{p.invoiceNo}{p.receiptNo ? <><br /><span className="text-xs text-emerald-700">{p.receiptNo}</span></> : null}</span>,
            p.description,
            formatPdfMoney(p.amount, p.currency),
            p.status === 'PAID' ? `مسددة — ${formatPdfDate(p.paidAt)}` : 'غير مسددة',
          ])}
        />
      </PdfSection>

      {certificates.length > 0 ? (
        <PdfSection title="الشهادات الصادرة">
          <PdfTable
            headers={['الرقم التسلسلي', 'النوع', 'التقدير', 'تاريخ الإصدار']}
            rows={certificates.map((c) => [c.serial, statusArabic(c.type), c.grade || '—', formatPdfDate(c.issuedAt)])}
          />
        </PdfSection>
      ) : null}
    </OfficialPdfDocument>
  )
}
