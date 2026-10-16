import { NextRequest, NextResponse } from 'next/server'
import { jsPDF } from 'jspdf'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ id: string }> | { id: string } }

type InvoicePdfData = {
  invoiceNo: string
  receiptNo?: string | null
  title: string
  status: string
  statusKind: 'PAID' | 'WAIVED' | 'PENDING' | 'UNPAID'
  issueDate: string
  settledAt: string
  payerName: string
  payerEmail: string
  payerCountry: string
  programOrService: string
  purpose: string
  description: string
  amount: string
  originalAmount: string
  waivedAmount: string
  method: string
  reference: string
}

const PAGE_W = 794
const PAGE_H = 1123
const BRAND_NAVY = '#0f2b46'
const BRAND_GOLD = '#c9a227'
const SOFT_GOLD = '#f7edd0'
const TEXT = '#1f2937'
const MUTED = '#64748b'
const BORDER = '#e2e8f0'

function safeText(value: unknown, fallback = '—') {
  const text = String(value ?? '').trim()
  return text || fallback
}

function fileSafe(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-')
}

function formatMoney(amount: number | null | undefined, currency?: string | null) {
  const n = typeof amount === 'number' && Number.isFinite(amount) ? amount : 0
  return `${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${safeText(currency, 'USD')}`
}

function formatDate(value: Date | string | null | undefined) {
  if (!value) return '—'
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toISOString().slice(0, 10)
}

function purposeLabel(value?: string | null) {
  const labels: Record<string, string> = {
    APPLICATION_FEE: 'Application Fee',
    TUITION: 'Tuition Invoice',
    TUITION_INSTALLMENT: 'Tuition Installment',
    ACCREDITATION_APP: 'Accreditation Application Fee',
    ACCREDITATION_FEE: 'Accreditation Fee',
    ACCREDITATION: 'Accreditation',
    SERVICE_FEE: 'Service Fee',
    OTHER: 'Other Fee',
  }
  return labels[safeText(value, '')] || safeText(value, 'Other Fee')
}

function statusInfo(value?: string | null, waiverStatus?: string | null) {
  if (value === 'PAID') return { label: 'PAID / Receipt issued', kind: 'PAID' as const, title: 'OFFICIAL RECEIPT' }
  if (value === 'WAIVED') return { label: 'WAIVED / Scholarship or waiver settled', kind: 'WAIVED' as const, title: 'OFFICIAL WAIVER RECEIPT' }
  if (waiverStatus === 'APPROVED' || waiverStatus === 'PROGRAM_APPLIED') return { label: 'WAIVED / Scholarship or waiver settled', kind: 'WAIVED' as const, title: 'OFFICIAL WAIVER RECEIPT' }
  if (waiverStatus === 'REQUESTED' || waiverStatus === 'VERIFIED') return { label: 'WAIVER PENDING / awaiting approval', kind: 'PENDING' as const, title: 'OFFICIAL INVOICE' }
  return { label: 'UNPAID / Amount due', kind: 'UNPAID' as const, title: 'OFFICIAL INVOICE' }
}

function methodLabel(value?: string | null) {
  if (!value) return '—'
  const labels: Record<string, string> = {
    PAYMOB: 'Paymob',
    FAWRY: 'Fawry',
    STRIPE: 'Stripe',
    PAYPAL: 'PayPal',
    USDT: 'USDT',
    BANK_TRANSFER: 'Bank Transfer',
    DIRECT_PAYMENT: 'Direct Payment',
    CASH: 'Cash',
    WAIVER: 'Waiver / Scholarship',
  }
  return labels[value] || value
}

function pdfSafeText(value: unknown, fallback = 'See student portal') {
  const text = safeText(value, fallback)
  // jsPDF built-in fonts are Latin-safe. Arabic details remain visible inside the portal;
  // the PDF uses safe English fallbacks to avoid missing-glyph boxes on mobile viewers.
  return /[\u0600-\u06FF\u0750-\u077F]/.test(text) ? fallback : text
}

function setText(doc: jsPDF, size: number, color = TEXT, style: 'normal' | 'bold' = 'normal') {
  doc.setFont('helvetica', style)
  doc.setFontSize(size)
  doc.setTextColor(color)
}

function fillRounded(doc: jsPDF, x: number, y: number, w: number, h: number, fill: string, stroke?: string) {
  doc.setFillColor(fill)
  if (stroke) {
    doc.setDrawColor(stroke)
    doc.roundedRect(x, y, w, h, 16, 16, 'FD')
  } else {
    doc.roundedRect(x, y, w, h, 16, 16, 'F')
  }
}

function drawPair(doc: jsPDF, label: string, value: string, x: number, y: number, maxValueWidth = 410) {
  setText(doc, 12, MUTED, 'bold')
  doc.text(label, x, y)
  setText(doc, 13, TEXT, 'bold')
  const lines = doc.splitTextToSize(value || '—', maxValueWidth).slice(0, 2)
  doc.text(lines, x + 180, y)
  return y + Math.max(28, lines.length * 18)
}

function drawSectionTitle(doc: jsPDF, title: string, x: number, y: number) {
  setText(doc, 15, BRAND_NAVY, 'bold')
  doc.text(title, x, y)
}

function buildInvoicePdf(data: InvoicePdfData): Uint8Array {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'px', format: [PAGE_W, PAGE_H], compress: true })

  doc.setFillColor(BRAND_NAVY)
  doc.rect(0, 0, PAGE_W, 140, 'F')
  doc.setFillColor(BRAND_GOLD)
  doc.rect(0, 140, PAGE_W, 8, 'F')
  doc.circle(704, 72, 38, 'F')

  setText(doc, 22, '#ffffff', 'bold')
  doc.text('AACT', 704, 80, { align: 'center' })
  setText(doc, 24, '#ffffff', 'bold')
  doc.text('American Academy for Consulting and Training', 70, 54)
  setText(doc, 16, '#dbeafe', 'bold')
  doc.text('AACT Platform', 70, 88)
  setText(doc, 26, '#ffffff', 'bold')
  doc.text(data.title, 70, 122)

  const statusFill = data.statusKind === 'PAID' || data.statusKind === 'WAIVED' ? '#d1fae5' : '#fef3c7'
  const statusStroke = data.statusKind === 'PAID' || data.statusKind === 'WAIVED' ? '#047857' : '#b45309'
  fillRounded(doc, 52, 178, 690, 70, statusFill, statusStroke)
  setText(doc, 19, statusStroke, 'bold')
  doc.text(data.status, 80, 220)
  setText(doc, 24, BRAND_NAVY, 'bold')
  doc.text(data.amount, 710, 220, { align: 'right' })

  fillRounded(doc, 52, 280, 690, 208, '#f8fafc', BORDER)
  drawSectionTitle(doc, 'Invoice Details', 80, 310)
  let y = 342
  y = drawPair(doc, 'Invoice No.', data.invoiceNo, 80, y)
  y = drawPair(doc, 'Receipt No.', data.receiptNo || '—', 80, y)
  y = drawPair(doc, 'Issue Date', data.issueDate, 80, y)
  y = drawPair(doc, 'Paid / Waived At', data.settledAt, 80, y)
  y = drawPair(doc, 'Payment Method', data.method, 80, y)

  fillRounded(doc, 52, 520, 690, 176, '#ffffff', BORDER)
  drawSectionTitle(doc, 'Payer Details', 80, 550)
  y = 582
  y = drawPair(doc, 'Payer', data.payerName, 80, y)
  y = drawPair(doc, 'Email', data.payerEmail, 80, y)
  y = drawPair(doc, 'Country', data.payerCountry, 80, y)
  y = drawPair(doc, 'Reference', data.reference, 80, y)

  fillRounded(doc, 52, 728, 690, 196, '#fffbeb', '#fde68a')
  drawSectionTitle(doc, 'Service or Program', 80, 760)
  setText(doc, 14, TEXT, 'bold')
  doc.text(doc.splitTextToSize(data.programOrService, 610).slice(0, 3), 80, 792)
  doc.setDrawColor('#f4d675')
  doc.line(80, 852, 714, 852)
  setText(doc, 12, MUTED, 'bold')
  doc.text('Description', 80, 884)
  setText(doc, 13, TEXT, 'normal')
  doc.text(doc.splitTextToSize(data.description, 610).slice(0, 3), 80, 910)

  fillRounded(doc, 52, 952, 690, 92, SOFT_GOLD, '#ead389')
  setText(doc, 12, MUTED, 'bold')
  doc.text('Purpose', 80, 986)
  setText(doc, 17, BRAND_NAVY, 'bold')
  doc.text(data.purpose, 80, 1016)
  setText(doc, 12, MUTED, 'bold')
  doc.text('Total', 520, 986)
  setText(doc, 22, BRAND_NAVY, 'bold')
  doc.text(data.amount, 714, 1016, { align: 'right' })

  if (data.statusKind === 'WAIVED') {
    setText(doc, 11, '#047857', 'bold')
    doc.text(`Original: ${data.originalAmount} | Waived: ${data.waivedAmount} | Remaining: 0.00 USD`, 80, 1064)
  } else if (data.statusKind === 'UNPAID' || data.statusKind === 'PENDING') {
    setText(doc, 11, '#b45309', 'bold')
    doc.text(`Remaining due: ${data.amount}`, 80, 1064)
  }

  doc.setDrawColor(BORDER)
  doc.line(52, 1084, 742, 1084)
  setText(doc, 11, MUTED, 'normal')
  doc.text('Generated electronically by AACT Platform. No manual signature required.', 52, 1106)
  doc.text('aactacademy.com', 742, 1106, { align: 'right' })

  return new Uint8Array(doc.output('arraybuffer'))
}

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
      payment.admission?.programRef?.titleEn ||
        payment.admission?.programRef?.titleAr ||
        payment.admission?.program ||
        payment.enrollment?.program?.titleEn ||
        payment.enrollment?.program?.titleAr ||
        payment.agent?.orgName ||
        payment.description,
      'AACT Service'
    )
    const reference = safeText(payment.admission?.reference || payment.agent?.territory || payment.enrollment?.id || payment.id, payment.id)
    const status = statusInfo(payment.status, payment.waiverStatus)
    const originalAmount = typeof payment.originalAmount === 'number' && payment.originalAmount > 0 ? payment.originalAmount : payment.amount
    const waivedAmount = typeof payment.waivedAmount === 'number' && payment.waivedAmount > 0 ? payment.waivedAmount : (payment.status === 'WAIVED' ? originalAmount : 0)

    const pdf = buildInvoicePdf({
      invoiceNo: payment.invoiceNo,
      receiptNo: payment.receiptNo,
      title: status.title,
      status: status.label,
      statusKind: status.kind,
      issueDate: formatDate(payment.createdAt),
      settledAt: formatDate(payment.paidAt || payment.waiverApprovedAt),
      payerName: pdfSafeText(payerName, 'AACT Student'),
      payerEmail: pdfSafeText(payerEmail, 'Student email in portal'),
      payerCountry: pdfSafeText(payerCountry, 'Student country in portal'),
      programOrService: pdfSafeText(programOrService, 'Program / service details in portal'),
      purpose: purposeLabel(payment.purpose),
      description: pdfSafeText(payment.description, purposeLabel(payment.purpose)),
      amount: formatMoney(payment.amount, payment.currency),
      originalAmount: formatMoney(originalAmount, payment.currency),
      waivedAmount: formatMoney(waivedAmount, payment.currency),
      method: methodLabel(payment.method || payment.provider),
      reference: pdfSafeText(reference, payment.id),
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
