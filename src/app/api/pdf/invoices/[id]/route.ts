import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { loadArabicCanvas } from '@/lib/pdf-arabic'
import {
  buildInvoicePdf,
  fileSafe,
  formatDate,
  formatMoney,
  isArabicFontAvailable,
  methodLabel,
  purposeLabel,
  safeText,
  statusInfo,
} from '@/lib/invoice-pdf'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ id: string }> | { id: string } }

export async function GET(_req: NextRequest, context: RouteContext) {
  try {
    const user = await requireUser()
    const { id } = await Promise.resolve(context.params)
    if (!id) return NextResponse.json({ error: 'معرّف الفاتورة مطلوب' }, { status: 400 })

    const payment = await db.payment.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, name: true, email: true, country: true, role: true } },
        admission: {
          select: {
            id: true,
            userId: true,
            reference: true,
            fullName: true,
            email: true,
            country: true,
            program: true,
            programRef: { select: { titleAr: true, titleEn: true } },
          },
        },
        enrollment: {
          select: {
            id: true,
            userId: true,
            program: { select: { titleAr: true, titleEn: true } },
            user: { select: { id: true, name: true, email: true, country: true } },
          },
        },
        agent: {
          select: {
            id: true,
            userId: true,
            kind: true,
            orgName: true,
            repName: true,
            email: true,
            country: true,
            territory: true,
          },
        },
      },
    })

    if (!payment) return NextResponse.json({ error: 'الفاتورة غير موجودة' }, { status: 404 })

    const canView =
      user.role === 'ADMIN' ||
      payment.userId === user.id ||
      payment.user?.id === user.id ||
      payment.admission?.userId === user.id ||
      payment.enrollment?.userId === user.id ||
      payment.enrollment?.user?.id === user.id ||
      payment.agent?.userId === user.id

    if (!canView) return NextResponse.json({ error: 'صلاحيات غير كافية لعرض الفاتورة' }, { status: 403 })

    const payerName = safeText(payment.payerName || payment.user?.name || payment.admission?.fullName || payment.enrollment?.user?.name || payment.agent?.repName || payment.agent?.orgName, 'AACT Student')
    const payerEmail = safeText(payment.payerEmail || payment.user?.email || payment.admission?.email || payment.enrollment?.user?.email || payment.agent?.email, '—')
    const payerCountry = safeText(payment.payerCountry || payment.user?.country || payment.admission?.country || payment.enrollment?.user?.country || payment.agent?.country, '—')
    const programOrService = safeText(
      payment.admission?.programRef?.titleAr ||
        payment.admission?.programRef?.titleEn ||
        payment.admission?.program ||
        payment.enrollment?.program?.titleAr ||
        payment.enrollment?.program?.titleEn ||
        payment.agent?.orgName ||
        payment.description,
      'AACT Service'
    )
    const programFallback = safeText(
      payment.admission?.programRef?.titleEn ||
        payment.enrollment?.program?.titleEn ||
        payment.admission?.program ||
        payment.description,
      'Program / service details in portal'
    )
    const reference = safeText(payment.admission?.reference || payment.agent?.territory || payment.enrollment?.id || payment.id, payment.id)
    const status = statusInfo(payment.status, payment.waiverStatus)
    const originalAmount = typeof payment.originalAmount === 'number' && payment.originalAmount > 0 ? payment.originalAmount : payment.amount
    const waivedAmount = typeof payment.waivedAmount === 'number' && payment.waivedAmount > 0 ? payment.waivedAmount : (payment.status === 'WAIVED' ? originalAmount : 0)
    const arabicFontReady = isArabicFontAvailable()
    const fallbackDescription = purposeLabel(payment.purpose)

    await loadArabicCanvas()
    const pdf = buildInvoicePdf({
      invoiceNo: payment.invoiceNo,
      receiptNo: payment.receiptNo,
      title: status.title,
      status: status.label,
      statusKind: status.kind,
      issueDate: formatDate(payment.createdAt),
      settledAt: formatDate(payment.paidAt || payment.waiverApprovedAt),
      payerName,
      payerNameFallback: 'AACT Student',
      payerEmail,
      payerCountry,
      programOrService,
      programOrServiceFallback: programFallback,
      purpose: fallbackDescription,
      description: safeText(payment.description || fallbackDescription, fallbackDescription),
      descriptionFallback: fallbackDescription,
      amount: formatMoney(payment.amount, payment.currency),
      originalAmount: formatMoney(originalAmount, payment.currency),
      waivedAmount: formatMoney(waivedAmount, payment.currency),
      method: methodLabel(payment.method || payment.provider),
      reference,
    })

    const filename = `${fileSafe(payment.invoiceNo || payment.id)}.pdf`
    const body = new ArrayBuffer(pdf.byteLength)
    new Uint8Array(body).set(pdf)

    return new NextResponse(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${filename}"`,
        'Cache-Control': 'private, no-store, max-age=0',
        'Content-Length': String(pdf.byteLength),
        'X-Arabic-Font': arabicFontReady ? 'ready' : 'missing',
      },
    })
  } catch (e) {
    console.error('invoice PDF error:', e)
    if (e instanceof Error && e.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'تسجيل الدخول مطلوب لعرض الفاتورة' }, { status: 401 })
    }
    return NextResponse.json({ error: 'تعذر توليد PDF الفاتورة' }, { status: 500 })
  }
}
