import { NextRequest, NextResponse } from 'next/server'
import { jsPDF } from 'jspdf'
import sharp from 'sharp'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ id: string }> | { id: string } }
type PdfLine = { label: string; value: string; dir?: 'rtl' | 'ltr' }

const PAGE_W = 794
const PAGE_H = 1123
const BRAND_NAVY = '#0f2b46'
const BRAND_GOLD = '#c9a227'
const SOFT_GOLD = '#f7edd0'
const TEXT = '#1f2937'
const MUTED = '#64748b'

function safeText(value: unknown, fallback = '—') {
  const text = String(value ?? '').trim()
  return text || fallback
}

function escapeXml(value: unknown) {
  return safeText(value, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
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
    APPLICATION_FEE: 'رسوم تقديم / Application Fee',
    TUITION: 'رسوم دراسية / Tuition',
    TUITION_INSTALLMENT: 'قسط رسوم دراسية / Tuition Installment',
    ACCREDITATION_APP: 'رسوم تقديم اعتماد / Accreditation Application',
    ACCREDITATION_FEE: 'رسوم تقديم اعتماد / Accreditation Fee',
    ACCREDITATION: 'اعتماد / Accreditation',
    SERVICE_FEE: 'رسوم خدمة / Service Fee',
    OTHER: 'أخرى / Other',
  }
  return labels[safeText(value, '')] || safeText(value, 'Other')
}

function statusLabel(value?: string | null) {
  return value === 'PAID' ? 'مسددة / PAID' : 'غير مسددة / UNPAID'
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
  }
  return labels[value] || value
}

function wrapText(input: string, maxChars: number) {
  const words = safeText(input, '').replace(/\s+/g, ' ').split(' ').filter(Boolean)
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const next = current ? `${current} ${word}` : word
    if (next.length > maxChars && current) {
      lines.push(current)
      current = word
    } else {
      current = next
    }
  }
  if (current) lines.push(current)
  return lines.length ? lines : ['—']
}

function text(x: number, y: number, content: string, opts: { size?: number; fill?: string; weight?: number; anchor?: 'start' | 'middle' | 'end'; dir?: 'rtl' | 'ltr'; family?: string } = {}) {
  const size = opts.size || 18
  const fill = opts.fill || TEXT
  const anchor = opts.anchor || 'start'
  const dir = opts.dir || 'rtl'
  const weight = opts.weight || 500
  const family = opts.family || "'DejaVu Sans','Noto Naskh Arabic','Arial','Tahoma',sans-serif"
  return `<text x="${x}" y="${y}" text-anchor="${anchor}" direction="${dir}" unicode-bidi="plaintext" style="font-family:${family};font-size:${size}px;font-weight:${weight};fill:${fill};dominant-baseline:alphabetic">${escapeXml(content)}</text>`
}

function lineRows(rows: PdfLine[], startY: number, opts: { xLabel?: number; xValue?: number; rowH?: number } = {}) {
  const xLabel = opts.xLabel ?? 705
  const xValue = opts.xValue ?? 85
  const rowH = opts.rowH ?? 42
  let y = startY
  let out = ''
  for (const row of rows) {
    out += text(xLabel, y, row.label, { size: 17, fill: MUTED, weight: 800, anchor: 'end', dir: 'rtl' })
    out += text(xValue, y, row.value, { size: 17, fill: TEXT, weight: 700, anchor: 'start', dir: row.dir || 'rtl' })
    y += rowH
  }
  return { svg: out, endY: y }
}

function buildInvoiceSvg(data: {
  invoiceNo: string
  receiptNo?: string | null
  status: string
  issueDate: string
  paidAt: string
  payerName: string
  payerEmail: string
  payerCountry: string
  programOrService: string
  purpose: string
  description: string
  amount: string
  method: string
  reference: string
}) {
  const descLines = wrapText(data.description, 72).slice(0, 4)
  const programLines = wrapText(data.programOrService, 66).slice(0, 3)
  const isPaid = data.status === 'مسددة / PAID'
  const statusColor = isPaid ? '#047857' : '#b45309'
  const statusBg = isPaid ? '#d1fae5' : '#fef3c7'

  const invoiceRows = lineRows([
    { label: 'رقم الفاتورة / Invoice No.', value: data.invoiceNo, dir: 'ltr' },
    { label: 'رقم الإيصال / Receipt No.', value: data.receiptNo || '—', dir: 'ltr' },
    { label: 'تاريخ الإصدار / Issue Date', value: data.issueDate, dir: 'ltr' },
    { label: 'تاريخ السداد / Paid At', value: data.paidAt, dir: 'ltr' },
    { label: 'طريقة الدفع / Payment Method', value: data.method, dir: 'ltr' },
  ], 262, { xLabel: 690, xValue: 92, rowH: 38 })

  const payerRows = lineRows([
    { label: 'اسم الدافع / Payer', value: data.payerName },
    { label: 'البريد / Email', value: data.payerEmail, dir: 'ltr' },
    { label: 'الدولة / Country', value: data.payerCountry },
    { label: 'مرجع الطلب / Reference', value: data.reference, dir: 'ltr' },
  ], 500, { xLabel: 690, xValue: 92, rowH: 38 })

  const descSvg = descLines.map((l, i) => text(690, 772 + i * 30, l, { size: 17, fill: TEXT, weight: 700, anchor: 'end', dir: 'rtl' })).join('')
  const programSvg = programLines.map((l, i) => text(690, 690 + i * 30, l, { size: 17, fill: TEXT, weight: 800, anchor: 'end', dir: 'rtl' })).join('')

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${PAGE_W}" height="${PAGE_H}" viewBox="0 0 ${PAGE_W} ${PAGE_H}">
  <rect width="${PAGE_W}" height="${PAGE_H}" fill="#ffffff"/>
  <rect x="0" y="0" width="${PAGE_W}" height="138" fill="${BRAND_NAVY}"/>
  <rect x="0" y="138" width="${PAGE_W}" height="8" fill="${BRAND_GOLD}"/>
  <circle cx="704" cy="70" r="38" fill="${BRAND_GOLD}" opacity="0.95"/>
  ${text(704, 80, 'AACT', { size: 24, fill: '#ffffff', weight: 900, anchor: 'middle', dir: 'ltr', family: 'Arial,sans-serif' })}
  ${text(665, 54, 'الأكاديمية الأمريكية للاستشارات والتدريب', { size: 24, fill: '#ffffff', weight: 900, anchor: 'end', dir: 'rtl' })}
  ${text(665, 88, 'American Academy for Consulting and Training', { size: 18, fill: '#dbeafe', weight: 700, anchor: 'end', dir: 'ltr', family: 'Arial,sans-serif' })}
  ${text(86, 62, 'OFFICIAL INVOICE', { size: 27, fill: '#ffffff', weight: 900, anchor: 'start', dir: 'ltr', family: 'Arial,sans-serif' })}
  ${text(86, 96, 'فاتورة رسمية قابلة للطباعة', { size: 18, fill: '#f7edd0', weight: 800, anchor: 'start', dir: 'rtl' })}

  <rect x="52" y="178" width="690" height="64" rx="20" fill="${statusBg}" stroke="${statusColor}" stroke-width="1.2"/>
  ${text(705, 218, data.status, { size: 22, fill: statusColor, weight: 900, anchor: 'end', dir: 'rtl' })}
  ${text(90, 218, data.amount, { size: 24, fill: BRAND_NAVY, weight: 900, anchor: 'start', dir: 'ltr', family: 'Arial,sans-serif' })}

  <rect x="52" y="258" width="690" height="188" rx="22" fill="#f8fafc" stroke="#e2e8f0"/>
  ${text(690, 242, 'بيانات الفاتورة / Invoice Details', { size: 19, fill: BRAND_NAVY, weight: 900, anchor: 'end', dir: 'rtl' })}
  ${invoiceRows.svg}

  <rect x="52" y="490" width="690" height="162" rx="22" fill="#ffffff" stroke="#e2e8f0"/>
  ${text(690, 478, 'بيانات الدافع / Payer Details', { size: 19, fill: BRAND_NAVY, weight: 900, anchor: 'end', dir: 'rtl' })}
  ${payerRows.svg}

  <rect x="52" y="682" width="690" height="190" rx="22" fill="#fffbeb" stroke="#fde68a"/>
  ${text(690, 670, 'الخدمة أو البرنامج / Service or Program', { size: 19, fill: BRAND_NAVY, weight: 900, anchor: 'end', dir: 'rtl' })}
  ${programSvg}
  <line x1="86" y1="736" x2="706" y2="736" stroke="#f4d675" stroke-width="1"/>
  ${text(690, 760, 'الوصف / Description', { size: 16, fill: MUTED, weight: 900, anchor: 'end', dir: 'rtl' })}
  ${descSvg}

  <rect x="52" y="900" width="690" height="96" rx="22" fill="${SOFT_GOLD}" stroke="#ead389"/>
  ${text(690, 938, 'الغرض / Purpose', { size: 17, fill: MUTED, weight: 900, anchor: 'end', dir: 'rtl' })}
  ${text(690, 970, data.purpose, { size: 19, fill: BRAND_NAVY, weight: 900, anchor: 'end', dir: 'rtl' })}
  ${text(92, 956, 'TOTAL', { size: 16, fill: MUTED, weight: 900, anchor: 'start', dir: 'ltr', family: 'Arial,sans-serif' })}
  ${text(92, 982, data.amount, { size: 25, fill: BRAND_NAVY, weight: 900, anchor: 'start', dir: 'ltr', family: 'Arial,sans-serif' })}

  <line x1="52" y1="1030" x2="742" y2="1030" stroke="#e2e8f0"/>
  ${text(742, 1056, 'تم إصدار هذه الفاتورة إلكترونياً من منصة AACT. لا تتطلب توقيعاً يدوياً.', { size: 15, fill: MUTED, weight: 700, anchor: 'end', dir: 'rtl' })}
  ${text(52, 1056, 'Generated electronically by AACT Platform.', { size: 13, fill: MUTED, weight: 700, anchor: 'start', dir: 'ltr', family: 'Arial,sans-serif' })}
  ${text(397, 1088, 'aactacademy.com', { size: 13, fill: BRAND_NAVY, weight: 800, anchor: 'middle', dir: 'ltr', family: 'Arial,sans-serif' })}
</svg>`
}

async function svgToPdfBuffer(svg: string) {
  const png = await sharp(Buffer.from(svg)).png().toBuffer()
  const doc = new jsPDF({ orientation: 'portrait', unit: 'px', format: [PAGE_W, PAGE_H], compress: true })
  doc.addImage(new Uint8Array(png), 'PNG', 0, 0, PAGE_W, PAGE_H)
  return Buffer.from(doc.output('arraybuffer'))
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
        payment.admission?.program ||
        payment.enrollment?.program?.titleAr ||
        payment.agent?.orgName ||
        payment.description,
      'AACT Service'
    )
    const reference = safeText(payment.admission?.reference || payment.agent?.territory || payment.enrollment?.id || payment.id, payment.id)

    const svg = buildInvoiceSvg({
      invoiceNo: payment.invoiceNo,
      receiptNo: payment.receiptNo,
      status: statusLabel(payment.status),
      issueDate: formatDate(payment.createdAt),
      paidAt: formatDate(payment.paidAt),
      payerName,
      payerEmail,
      payerCountry,
      programOrService,
      purpose: purposeLabel(payment.purpose),
      description: safeText(payment.description, purposeLabel(payment.purpose)),
      amount: formatMoney(payment.amount, payment.currency),
      method: methodLabel(payment.method || payment.provider),
      reference,
    })

    const pdf = await svgToPdfBuffer(svg)
    const filename = `${fileSafe(payment.invoiceNo || payment.id)}.pdf`

    return new NextResponse(pdf, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${filename}"`,
        'Cache-Control': 'private, no-store, max-age=0',
        'Content-Length': String(pdf.length),
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
