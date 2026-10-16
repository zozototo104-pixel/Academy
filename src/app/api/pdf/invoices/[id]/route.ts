import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { NextRequest, NextResponse } from 'next/server'
import { jsPDF } from 'jspdf'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { toVisualArabic } from '@/lib/pdf-arabic'

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
  payerNameFallback: string
  payerEmail: string
  payerCountry: string
  programOrService: string
  programOrServiceFallback: string
  purpose: string
  description: string
  descriptionFallback?: string
  amount: string
  originalAmount: string
  waivedAmount: string
  method: string
  reference: string
}

type InvoicePdfOptions = {
  fontPaths?: string[]
  compress?: boolean
}

type BilingualLabel = {
  ar: string
  en: string
}

const PAGE_W = 794
const PAGE_H = 1123
const BRAND_NAVY = '#0f2b46'
const BRAND_GOLD = '#c9a227'
const SOFT_GOLD = '#f7edd0'
const TEXT = '#1f2937'
const MUTED = '#64748b'
const BORDER = '#e2e8f0'
export const ARABIC_FONT_NAME = 'AmiriArabic'
const ARABIC_FONT_FILE = 'Amiri-Regular.ttf'
const ARABIC_FONT_PATHS = [
  join(process.cwd(), 'public', 'fonts', ARABIC_FONT_FILE),
  join(process.cwd(), 'src', 'assets', 'fonts', ARABIC_FONT_FILE),
]

const LABELS = {
  invoiceDetails: { ar: 'تفاصيل الفاتورة', en: 'Invoice Details' },
  invoiceNo: { ar: 'رقم الفاتورة', en: 'Invoice No.' },
  receiptNo: { ar: 'رقم الإيصال', en: 'Receipt No.' },
  issueDate: { ar: 'تاريخ الإصدار', en: 'Issue Date' },
  settledAt: { ar: 'تاريخ الدفع', en: 'Paid / Waived At' },
  paymentMethod: { ar: 'طريقة الدفع', en: 'Payment Method' },
  payerDetails: { ar: 'بيانات الدافع', en: 'Payer Details' },
  payer: { ar: 'الدافع', en: 'Payer' },
  email: { ar: 'البريد', en: 'Email' },
  country: { ar: 'الدولة', en: 'Country' },
  reference: { ar: 'المرجع', en: 'Reference' },
  programOrService: { ar: 'البرنامج أو الخدمة', en: 'Program or Service' },
  description: { ar: 'الوصف', en: 'Description' },
  purpose: { ar: 'الغرض', en: 'Purpose' },
  total: { ar: 'المجموع', en: 'Total' },
  status: { ar: 'الحالة', en: 'Status' },
} satisfies Record<string, BilingualLabel>

const PURPOSE_LABELS_AR: Record<string, string> = {
  'Application Fee': 'رسوم التقديم',
  'Tuition Invoice': 'فاتورة الرسوم الدراسية',
  'Tuition Installment': 'قسط الرسوم الدراسية',
  'Accreditation Application Fee': 'رسوم طلب الاعتماد',
  'Accreditation Fee': 'رسوم الاعتماد',
  Accreditation: 'اعتماد',
  'Service Fee': 'رسوم خدمة',
  'Other Fee': 'رسوم أخرى',
}

const METHOD_LABELS_AR: Record<string, string> = {
  Paymob: 'بايموب',
  Fawry: 'فوري',
  Stripe: 'سترايب',
  PayPal: 'باي بال',
  USDT: 'USDT',
  'Bank Transfer': 'تحويل بنكي',
  'Direct Payment': 'دفع مباشر',
  Cash: 'نقداً',
  'Waiver / Scholarship': 'إعفاء / منحة',
  '—': '—',
}

function safeText(value: unknown, fallback = '—') {
  const text = String(value ?? '').trim()
  return text || fallback
}

function fileSafe(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-')
}

function hasArabic(value: unknown) {
  return /[\u0600-\u06FF\u0750-\u077F]/.test(String(value ?? ''))
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
  if (waiverStatus === 'REQUESTED' || waiverStatus === 'VERIFIED') return { label: 'WAIVER PENDING / awaiting approval', kind: 'PENDING' as const, title: 'PENDING - NOT A FINAL RECEIPT' }
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

function resolveArabicFontPath(fontPaths = ARABIC_FONT_PATHS) {
  return fontPaths.find((candidate) => existsSync(candidate)) || null
}

export function isArabicFontAvailable(fontPaths = ARABIC_FONT_PATHS) {
  return Boolean(resolveArabicFontPath(fontPaths))
}

export function registerArabicFont(doc: jsPDF, fontPaths = ARABIC_FONT_PATHS) {
  const fontPath = resolveArabicFontPath(fontPaths)
  if (!fontPath) {
    console.warn(`[invoice-pdf] Arabic font missing. Tried paths: ${fontPaths.join(', ')}`)
    return false
  }

  try {
    const base64 = Buffer.from(readFileSync(fontPath)).toString('base64')
    doc.addFileToVFS(ARABIC_FONT_FILE, base64)
    doc.addFont(ARABIC_FONT_FILE, ARABIC_FONT_NAME, 'normal')
    return true
  } catch (error) {
    console.warn(`[invoice-pdf] Arabic font could not be loaded from ${fontPath}. Tried paths: ${fontPaths.join(', ')}`, error)
    return false
  }
}

function pdfValue(value: string, fallback: string, arabicReady: boolean) {
  return hasArabic(value) && !arabicReady ? fallback : safeText(value, fallback)
}

function setText(doc: jsPDF, size: number, color = TEXT, style: 'normal' | 'bold' = 'normal', font = 'helvetica') {
  doc.setFont(font, style)
  doc.setFontSize(size)
  doc.setTextColor(color)
}

function writeArabic(doc: jsPDF, value: string, x: number, y: number, opts: { size?: number; color?: string; maxWidth?: number; maxLines?: number; align?: 'right' | 'center' } = {}) {
  setText(doc, opts.size || 13, opts.color || TEXT, 'normal', ARABIC_FONT_NAME)
  const logical = safeText(value)
  const logicalLines = opts.maxWidth ? doc.splitTextToSize(logical, opts.maxWidth).slice(0, opts.maxLines || 3) : [logical]
  const visualLines = logicalLines.map((line: string) => toVisualArabic(line))
  doc.text(visualLines, x, y, { align: opts.align || 'right' })
  return Math.max(20, visualLines.length * ((opts.size || 13) + 4))
}

function drawBilingualLabel(doc: jsPDF, label: BilingualLabel, x: number, y: number, arabicX: number, arabicReady: boolean, color = MUTED) {
  setText(doc, 12, color, 'bold')
  doc.text(label.en, x, y)
  if (arabicReady) writeArabic(doc, label.ar, arabicX, y, { size: 12, color })
}

function writeValue(doc: jsPDF, value: string, x: number, y: number, opts: { size?: number; color?: string; style?: 'normal' | 'bold'; maxWidth?: number; align?: 'left' | 'right'; arabicReady: boolean }) {
  const isArabic = hasArabic(value) && opts.arabicReady
  if (isArabic) {
    return writeArabic(doc, value, x, y, {
      size: opts.size || 13,
      color: opts.color || TEXT,
      maxWidth: opts.maxWidth,
      align: opts.align === 'left' ? 'right' : opts.align,
    })
  }

  setText(doc, opts.size || 13, opts.color || TEXT, opts.style || 'normal')
  const lines = opts.maxWidth ? doc.splitTextToSize(value, opts.maxWidth).slice(0, 3) : [value]
  doc.text(lines, x, y, { align: opts.align || 'left' })
  return Math.max(20, lines.length * ((opts.size || 13) + 4))
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

function drawPair(doc: jsPDF, label: BilingualLabel, value: string, x: number, y: number, maxValueWidth: number, arabicReady: boolean) {
  if (arabicReady) {
    drawBilingualLabel(doc, label, x, y, x + 150, true)
  } else {
    setText(doc, 12, MUTED, 'bold')
    doc.text(label.en, x, y)
  }
  const valueX = hasArabic(value) && arabicReady ? x + 585 : x + 180
  const height = writeValue(doc, value || '—', valueX, y, { size: 13, color: TEXT, style: 'bold', maxWidth: maxValueWidth, arabicReady })
  return y + Math.max(28, height)
}

function drawSectionTitle(doc: jsPDF, label: BilingualLabel, x: number, y: number, arabicReady: boolean) {
  setText(doc, 15, BRAND_NAVY, 'bold')
  doc.text(label.en, x, y)
  if (arabicReady) writeArabic(doc, label.ar, 714, y, { size: 15, color: BRAND_NAVY })
}

function statusArabicLabel(kind: InvoicePdfData['statusKind']) {
  if (kind === 'PAID') return 'مدفوعة / صدر الإيصال'
  if (kind === 'WAIVED') return 'معفاة / تمت التسوية'
  if (kind === 'PENDING') return 'غير مدفوعة / الإعفاء قيد المراجعة'
  return 'غير مدفوعة / المبلغ مستحق'
}

function titleArabicLabel(kind: InvoicePdfData['statusKind']) {
  if (kind === 'PAID') return 'إيصال رسمي'
  if (kind === 'WAIVED') return 'إيصال إعفاء رسمي'
  if (kind === 'PENDING') return 'قيد الانتظار - ليس إيصالاً نهائياً'
  return 'فاتورة رسمية'
}

function purposeArabicLabel(value: string) {
  return PURPOSE_LABELS_AR[value] || (hasArabic(value) ? value : 'غرض الدفع')
}

function methodArabicLabel(value: string) {
  return METHOD_LABELS_AR[value] || (hasArabic(value) ? value : 'طريقة دفع')
}

export function buildInvoicePdf(data: InvoicePdfData, options: InvoicePdfOptions = {}): Uint8Array {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'px', format: [PAGE_W, PAGE_H], compress: options.compress ?? true })
  const fontPaths = options.fontPaths || ARABIC_FONT_PATHS
  const arabicReady = registerArabicFont(doc, fontPaths)
  const descriptionText = pdfValue(data.description, data.descriptionFallback || data.purpose, arabicReady)
  const methodText = pdfValue(data.method, 'Payment Method', arabicReady)
  const purposeText = pdfValue(data.purpose, 'Other Fee', arabicReady)

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
  if (arabicReady) {
    writeArabic(doc, titleArabicLabel(data.statusKind), 714, 116, { size: 23, color: '#ffffff' })
    setText(doc, 13, '#dbeafe', 'bold')
    doc.text(data.title, 70, 122)
  } else {
    setText(doc, 26, '#ffffff', 'bold')
    doc.text(data.title, 70, 122)
  }

  const statusFill = data.statusKind === 'PAID' || data.statusKind === 'WAIVED' ? '#d1fae5' : '#fef3c7'
  const statusStroke = data.statusKind === 'PAID' || data.statusKind === 'WAIVED' ? '#047857' : '#b45309'
  fillRounded(doc, 52, 178, 690, 70, statusFill, statusStroke)
  if (arabicReady) {
    drawBilingualLabel(doc, LABELS.status, 80, 204, 260, true, statusStroke)
    setText(doc, 13, statusStroke, 'bold')
    doc.text(data.status, 80, 228)
    writeArabic(doc, statusArabicLabel(data.statusKind), 500, 228, { size: 16, color: statusStroke, maxWidth: 220 })
  } else {
    setText(doc, 19, statusStroke, 'bold')
    doc.text(data.status, 80, 220)
  }
  setText(doc, 24, BRAND_NAVY, 'bold')
  doc.text(data.amount, 710, 220, { align: 'right' })

  fillRounded(doc, 52, 280, 690, 208, '#f8fafc', BORDER)
  drawSectionTitle(doc, LABELS.invoiceDetails, 80, 310, arabicReady)
  let y = 342
  y = drawPair(doc, LABELS.invoiceNo, data.invoiceNo, 80, y, 410, arabicReady)
  y = drawPair(doc, LABELS.receiptNo, data.receiptNo || '—', 80, y, 410, arabicReady)
  y = drawPair(doc, LABELS.issueDate, data.issueDate, 80, y, 410, arabicReady)
  y = drawPair(doc, LABELS.settledAt, data.settledAt, 80, y, 410, arabicReady)
  y = drawPair(doc, LABELS.paymentMethod, arabicReady ? `${methodArabicLabel(methodText)} / ${methodText}` : methodText, 80, y, 410, arabicReady)

  fillRounded(doc, 52, 520, 690, 176, '#ffffff', BORDER)
  drawSectionTitle(doc, LABELS.payerDetails, 80, 550, arabicReady)
  y = 582
  y = drawPair(doc, LABELS.payer, pdfValue(data.payerName, data.payerNameFallback, arabicReady), 80, y, 410, arabicReady)
  y = drawPair(doc, LABELS.email, data.payerEmail, 80, y, 410, arabicReady)
  y = drawPair(doc, LABELS.country, data.payerCountry, 80, y, 410, arabicReady)
  y = drawPair(doc, LABELS.reference, data.reference, 80, y, 410, arabicReady)

  fillRounded(doc, 52, 728, 690, 196, '#fffbeb', '#fde68a')
  drawSectionTitle(doc, LABELS.programOrService, 80, 760, arabicReady)
  const programText = pdfValue(data.programOrService, data.programOrServiceFallback, arabicReady)
  writeValue(doc, programText, hasArabic(programText) && arabicReady ? 714 : 80, 792, { size: 14, color: TEXT, style: 'bold', maxWidth: 610, arabicReady })
  doc.setDrawColor('#f4d675')
  doc.line(80, 852, 714, 852)
  drawBilingualLabel(doc, LABELS.description, 80, 884, 230, arabicReady)
  writeValue(doc, descriptionText, hasArabic(descriptionText) && arabicReady ? 714 : 80, 910, { size: 13, color: TEXT, maxWidth: 610, arabicReady })

  fillRounded(doc, 52, 952, 690, 92, SOFT_GOLD, '#ead389')
  drawBilingualLabel(doc, LABELS.purpose, 80, 986, 230, arabicReady)
  if (arabicReady) {
    writeArabic(doc, `${purposeArabicLabel(purposeText)} / ${purposeText}`, 365, 1016, { size: 16, color: BRAND_NAVY, maxWidth: 285 })
  } else {
    setText(doc, 17, BRAND_NAVY, 'bold')
    doc.text(purposeText, 80, 1016)
  }
  drawBilingualLabel(doc, LABELS.total, 520, 986, 640, arabicReady)
  setText(doc, 22, BRAND_NAVY, 'bold')
  doc.text(data.amount, 714, 1016, { align: 'right' })

  if (data.statusKind === 'WAIVED') {
    setText(doc, 11, '#047857', 'bold')
    doc.text(`Original: ${data.originalAmount} | Waived: ${data.waivedAmount} | Remaining: 0.00 USD`, 80, 1064)
    if (arabicReady) writeArabic(doc, `الأصل: ${data.originalAmount} | المعفى: ${data.waivedAmount} | المتبقي: 0.00 USD`, 714, 1064, { size: 11, color: '#047857' })
  } else if (data.statusKind === 'UNPAID' || data.statusKind === 'PENDING') {
    setText(doc, 11, '#b45309', 'bold')
    doc.text(`Remaining due: ${data.amount}`, 80, 1064)
    if (arabicReady) writeArabic(doc, `المتبقي المستحق: ${data.amount}`, 714, 1064, { size: 11, color: '#b45309' })
  }

  doc.setDrawColor(BORDER)
  doc.line(52, 1084, 742, 1084)
  setText(doc, 11, MUTED, 'normal')
  doc.text('Generated electronically by AACT Platform. No manual signature required.', 52, 1106)
  if (arabicReady) writeArabic(doc, 'تم إنشاء المستند إلكترونياً عبر منصة AACT ولا يحتاج إلى توقيع يدوي.', 714, 1106, { size: 11, color: MUTED })
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
