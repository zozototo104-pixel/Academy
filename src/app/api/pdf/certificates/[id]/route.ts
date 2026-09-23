import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'
import { pdfDate, pdfResponse, pdfSafeText, renderOfficialPdf } from '@/lib/pdf/official'
import { certificateVerificationUrl, certificateCredentialUrl } from '@/lib/w3c/certificate-credential'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ id: string }> | { id: string } }

function certificateTypeLabel(type?: string | null) {
  const labels: Record<string, string> = {
    PROGRAM_COMPLETION: 'شهادة إتمام برنامج / Program Completion Certificate',
    ACCREDITATION: 'شهادة اعتماد / Accreditation Certificate',
    AGENCY: 'شهادة وكالة / Agency Certificate',
  }
  return labels[pdfSafeText(type, '')] || pdfSafeText(type, 'Certificate')
}

export async function GET(_req: NextRequest, context: RouteContext) {
  try {
    const user = await getCurrentUser()
    const { id } = await Promise.resolve(context.params)
    if (!id) return NextResponse.json({ error: 'معرّف الشهادة مطلوب' }, { status: 400 })

    const certificate = await db.certificate.findFirst({
      where: { OR: [{ id }, { serial: id }, { qrToken: id }] },
      include: {
        admission: { select: { id: true, userId: true, reference: true, fullName: true, email: true, country: true, program: true, programRef: { select: { titleAr: true, titleEn: true } } } },
        agent: { select: { id: true, userId: true, orgName: true, repName: true, email: true, country: true, territory: true, kind: true } },
      },
    })

    if (!certificate) return NextResponse.json({ error: 'الشهادة غير موجودة' }, { status: 404 })

    const canView =
      user.role === 'ADMIN' ||
      certificate.userId === user.id ||
      certificate.admission?.userId === user.id ||
      certificate.admission?.email === user.email ||
      certificate.agent?.userId === user.id

    if (!canView) return NextResponse.json({ error: 'صلاحيات غير كافية لعرض الشهادة' }, { status: 403 })

    const holder = pdfSafeText(certificate.holderName || certificate.admission?.fullName || certificate.agent?.repName || certificate.agent?.orgName, 'Certificate Holder')
    const program = pdfSafeText(certificate.program || certificate.admission?.programRef?.titleAr || certificate.admission?.program || certificate.agent?.orgName, 'AACT Program')
    const verificationUrl = `https://aactacademy.com/verify/${certificate.qrToken}`

    const pdf = await renderOfficialPdf({
      title: 'شهادة رسمية',
      subtitle: 'Official Certificate',
      documentLabel: 'OFFICIAL CERTIFICATE',
      reference: certificate.serial,
      issuedAt: certificate.issuedAt,
      status: certificate.valid ? 'صالحة / VALID' : 'ملغاة / REVOKED',
      statusTone: certificate.valid ? 'success' : 'warning',
      sections: [
        {
          title: 'بيانات الشهادة / Certificate Details',
          rows: [
            { label: 'الرقم التسلسلي', value: certificate.serial, dir: 'ltr' },
            { label: 'نوع الشهادة', value: certificateTypeLabel(certificate.type) },
            { label: 'تاريخ الإصدار', value: pdfDate(certificate.issuedAt), dir: 'ltr' },
            { label: 'رمز التحقق', value: certificate.qrToken, dir: 'ltr' },
          ],
        },
        {
          title: 'بيانات المستفيد / Holder Details',
          rows: [
            { label: 'الاسم', value: holder },
            { label: 'الدولة', value: certificate.country || certificate.admission?.country || certificate.agent?.country || '—' },
            { label: 'البرنامج / الاعتماد', value: program },
            { label: 'التقدير / النتيجة', value: certificate.grade || '—' },
          ],
        },
        {
          title: 'التحقق / Verification',
          rows: [
            { label: 'رابط التحقق', value: verificationUrl, dir: 'ltr' },
            { label: 'مرجع الطلب', value: certificate.admission?.reference || certificate.agent?.territory || '—', dir: 'ltr' },
          ],
          lines: ['تؤكد الأكاديمية أن هذه الوثيقة صادرة إلكترونياً من منصة AACT ويمكن التحقق منها عبر رمز التحقق أعلاه.'],
        },
      ],
      footer: 'هذه الشهادة صادرة إلكترونياً من منصة AACT ولا تتطلب توقيعاً يدوياً عند التحقق الإلكتروني.',
    })

    return pdfResponse(pdf, `${certificate.serial}.pdf`)
  } catch (e) {
    console.error('certificate PDF error:', e)
    if (e instanceof Error && e.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'تسجيل الدخول مطلوب' }, { status: 401 })
    return NextResponse.json({ error: 'تعذر توليد PDF الشهادة' }, { status: 500 })
  }
}
