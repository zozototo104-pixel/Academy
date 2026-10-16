import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { jsPDF } from 'jspdf'
import { createCanvas, GlobalFonts } from '@napi-rs/canvas'
import { buildInvoicePdf } from '@/lib/invoice-pdf'
import { loadArabicCanvas } from '@/lib/pdf-arabic'

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

type BilingualLabel = { ar: string; en: string }
type Variant = 'A-current' | 'B-shape-no-reverse' | 'C-canvas-rtl'

type ArabicWriter = (
  doc: jsPDF,
  value: string,
  x: number,
  y: number,
  opts?: { size?: number; color?: string; maxWidth?: number; maxLines?: number; align?: 'right' | 'center' }
) => number

const PAGE_W = 794
const PAGE_H = 1123
const BRAND_NAVY = '#0f2b46'
const BRAND_GOLD = '#c9a227'
const SOFT_GOLD = '#f7edd0'
const TEXT = '#1f2937'
const MUTED = '#64748b'
const BORDER = '#e2e8f0'
const ARABIC_FONT_NAME = 'AmiriArabic'
const ARABIC_FONT_FILE = 'Amiri-Regular.ttf'
const FONT_PATH = join(process.cwd(), 'public', 'fonts', ARABIC_FONT_FILE)
const OUT_ARG = process.argv.find((arg) => arg.startsWith('--out='))?.slice('--out='.length)
const OUT_DIR = resolve(OUT_ARG || process.env.OUT_DIR || 'artifacts/invoice-variants')

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

const ARABIC_RE = /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/
const LTR_TOKEN_RE = /\d+(?:[.,]\d+)*(?:\s*[A-Za-z]{2,6})?|[A-Za-z][A-Za-z0-9._:/%+\-@]*(?:\s+[A-Za-z][A-Za-z0-9._:/%+\-@]*)*/g

type ArabicForms = { iso: string; fin?: string; ini?: string; med?: string }
const FORMS: Record<string, ArabicForms> = {
  'ء': { iso: '\uFE80' },
  'آ': { iso: '\uFE81', fin: '\uFE82' },
  'أ': { iso: '\uFE83', fin: '\uFE84' },
  'ؤ': { iso: '\uFE85', fin: '\uFE86' },
  'إ': { iso: '\uFE87', fin: '\uFE88' },
  'ئ': { iso: '\uFE89', fin: '\uFE8A', ini: '\uFE8B', med: '\uFE8C' },
  'ا': { iso: '\uFE8D', fin: '\uFE8E' },
  'ب': { iso: '\uFE8F', fin: '\uFE90', ini: '\uFE91', med: '\uFE92' },
  'ة': { iso: '\uFE93', fin: '\uFE94' },
  'ت': { iso: '\uFE95', fin: '\uFE96', ini: '\uFE97', med: '\uFE98' },
  'ث': { iso: '\uFE99', fin: '\uFE9A', ini: '\uFE9B', med: '\uFE9C' },
  'ج': { iso: '\uFE9D', fin: '\uFE9E', ini: '\uFE9F', med: '\uFEA0' },
  'ح': { iso: '\uFEA1', fin: '\uFEA2', ini: '\uFEA3', med: '\uFEA4' },
  'خ': { iso: '\uFEA5', fin: '\uFEA6', ini: '\uFEA7', med: '\uFEA8' },
  'د': { iso: '\uFEA9', fin: '\uFEAA' },
  'ذ': { iso: '\uFEAB', fin: '\uFEAC' },
  'ر': { iso: '\uFEAD', fin: '\uFEAE' },
  'ز': { iso: '\uFEAF', fin: '\uFEB0' },
  'س': { iso: '\uFEB1', fin: '\uFEB2', ini: '\uFEB3', med: '\uFEB4' },
  'ش': { iso: '\uFEB5', fin: '\uFEB6', ini: '\uFEB7', med: '\uFEB8' },
  'ص': { iso: '\uFEB9', fin: '\uFEBA', ini: '\uFEBB', med: '\uFEBC' },
  'ض': { iso: '\uFEBD', fin: '\uFEBE', ini: '\uFEBF', med: '\uFEC0' },
  'ط': { iso: '\uFEC1', fin: '\uFEC2', ini: '\uFEC3', med: '\uFEC4' },
  'ظ': { iso: '\uFEC5', fin: '\uFEC6', ini: '\uFEC7', med: '\uFEC8' },
  'ع': { iso: '\uFEC9', fin: '\uFECA', ini: '\uFECB', med: '\uFECC' },
  'غ': { iso: '\uFECD', fin: '\uFECE', ini: '\uFECF', med: '\uFED0' },
  'ف': { iso: '\uFED1', fin: '\uFED2', ini: '\uFED3', med: '\uFED4' },
  'ق': { iso: '\uFED5', fin: '\uFED6', ini: '\uFED7', med: '\uFED8' },
  'ك': { iso: '\uFED9', fin: '\uFEDA', ini: '\uFEDB', med: '\uFEDC' },
  'ل': { iso: '\uFEDD', fin: '\uFEDE', ini: '\uFEDF', med: '\uFEE0' },
  'م': { iso: '\uFEE1', fin: '\uFEE2', ini: '\uFEE3', med: '\uFEE4' },
  'ن': { iso: '\uFEE5', fin: '\uFEE6', ini: '\uFEE7', med: '\uFEE8' },
  'ه': { iso: '\uFEE9', fin: '\uFEEA', ini: '\uFEEB', med: '\uFEEC' },
  'و': { iso: '\uFEED', fin: '\uFEEE' },
  'ى': { iso: '\uFEEF', fin: '\uFEF0' },
  'ي': { iso: '\uFEF1', fin: '\uFEF2', ini: '\uFEF3', med: '\uFEF4' },
}

function safeText(value: unknown, fallback = '—') {
  const text = String(value ?? '').trim()
  return text || fallback
}

function hasArabic(value: unknown) {
  return /[\u0600-\u06FF\u0750-\u077F]/.test(String(value ?? ''))
}

function canJoinNext(ch: string) {
  return !!FORMS[ch]?.ini || !!FORMS[ch]?.med
}

function canJoinPrev(ch: string) {
  return !!FORMS[ch]?.fin || !!FORMS[ch]?.med
}

function shapeArabicLogical(input: string) {
  const chars = Array.from(input.replace(/[\u064B-\u0652]/g, ''))
  const lamAlef: Record<string, [string, string]> = {
    'ا': ['\uFEFB', '\uFEFC'],
    'أ': ['\uFEF7', '\uFEF8'],
    'إ': ['\uFEF9', '\uFEFA'],
    'آ': ['\uFEF5', '\uFEF6'],
  }
  const shaped: string[] = []
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]
    const prev = chars[i - 1]
    const next = chars[i + 1]
    if (ch === 'ل' && next && lamAlef[next]) {
      const joinsPrev = !!prev && canJoinNext(prev) && canJoinPrev(ch)
      shaped.push(lamAlef[next][joinsPrev ? 1 : 0])
      i++
      continue
    }
    const forms = FORMS[ch]
    if (!forms) { shaped.push(ch); continue }
    const joinsPrev = !!prev && canJoinNext(prev) && canJoinPrev(ch)
    const joinsNext = !!next && canJoinNext(ch) && canJoinPrev(next)
    if (joinsPrev && joinsNext && forms.med) shaped.push(forms.med)
    else if (joinsPrev && forms.fin) shaped.push(forms.fin)
    else if (joinsNext && forms.ini) shaped.push(forms.ini)
    else shaped.push(forms.iso)
  }
  return shaped.join('')
}

function reverseChars(value: string) {
  return Array.from(value).reverse().join('')
}

function reverseArabicRunPreservingLtr(run: string) {
  const placeholders: string[] = []
  const protectedRun = run.replace(LTR_TOKEN_RE, (token) => {
    const marker = `\u0000${placeholders.length}\u0000`
    placeholders.push(token)
    return marker
  })
  let reversed = reverseChars(protectedRun)
  placeholders.forEach((token, index) => {
    const reversedMarker = reverseChars(`\u0000${index}\u0000`)
    reversed = reversed.replace(reversedMarker, token)
  })
  return reversed
}

function oldVisualArabicWithReverse(value: string) {
  if (!ARABIC_RE.test(value)) return value
  return reverseArabicRunPreservingLtr(shapeArabicLogical(value)).replace(/\s+([:،؛])/g, '$1')
}

function sampleInvoice(): InvoicePdfData {
  return {
    invoiceNo: 'INV-AR-1',
    receiptNo: 'RCPT-AR-1',
    title: 'OFFICIAL RECEIPT',
    status: 'PAID / Receipt issued',
    statusKind: 'PAID',
    issueDate: '2026-10-16',
    settledAt: '2026-10-16',
    payerName: 'أحمد محمود',
    payerNameFallback: 'Ahmed Mahmoud',
    payerEmail: 'ahmed@example.test',
    payerCountry: 'Palestine',
    programOrService: 'برنامج الاستشارات الإدارية',
    programOrServiceFallback: 'Management Consulting Program',
    purpose: 'Tuition Invoice',
    description: 'رسوم البرنامج التدريبي للفصل الأول',
    descriptionFallback: 'Tuition Invoice',
    amount: '250.00 USD',
    originalAmount: '250.00 USD',
    waivedAmount: '0.00 USD',
    method: 'Bank Transfer',
    reference: 'APP-AR-1',
  }
}

function registerArabicFont(doc: jsPDF) {
  if (!existsSync(FONT_PATH)) throw new Error(`Missing Arabic font: ${FONT_PATH}`)
  const base64 = Buffer.from(readFileSync(FONT_PATH)).toString('base64')
  doc.addFileToVFS(ARABIC_FONT_FILE, base64)
  doc.addFont(ARABIC_FONT_FILE, ARABIC_FONT_NAME, 'normal')
}

function setText(doc: jsPDF, size: number, color = TEXT, style: 'normal' | 'bold' = 'normal', font = 'helvetica') {
  doc.setFont(font, style)
  doc.setFontSize(size)
  doc.setTextColor(color)
}

function writeTextArabic(transform: (value: string) => string): ArabicWriter {
  return (doc, value, x, y, opts = {}) => {
    setText(doc, opts.size || 13, opts.color || TEXT, 'normal', ARABIC_FONT_NAME)
    const logical = safeText(value)
    const logicalLines = opts.maxWidth ? doc.splitTextToSize(logical, opts.maxWidth).slice(0, opts.maxLines || 3) : [logical]
    const visualLines = logicalLines.map((line: string) => transform(line))
    doc.text(visualLines, x, y, { align: opts.align || 'right' })
    return Math.max(20, visualLines.length * ((opts.size || 13) + 4))
  }
}

function wrapCanvasLines(text: string, size: number, maxWidth: number) {
  const probe = createCanvas(10, 10)
  const ctx = probe.getContext('2d')
  ctx.font = `${size}px Amiri`
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word
    if (ctx.measureText(candidate).width <= maxWidth || !current) current = candidate
    else {
      lines.push(current)
      current = word
    }
  }
  if (current) lines.push(current)
  return lines.length ? lines : [text]
}

function writeCanvasArabic(): ArabicWriter {
  GlobalFonts.registerFromPath(FONT_PATH, 'Amiri')
  return (doc, value, x, y, opts = {}) => {
    const logical = safeText(value)
    const size = opts.size || 13
    const maxWidth = opts.maxWidth || Math.min(620, Math.max(180, opts.align === 'center' ? x * 2 : x - 52))
    const maxLines = opts.maxLines || 3
    const lines = wrapCanvasLines(logical, size, maxWidth).slice(0, maxLines)
    const lineHeight = size + 6
    const pad = 8
    const width = Math.ceil(maxWidth + pad * 2)
    const height = Math.ceil(lines.length * lineHeight + pad * 2)
    const scale = 2
    const canvas = createCanvas(width * scale, height * scale)
    const ctx = canvas.getContext('2d')
    ctx.scale(scale, scale)
    ctx.font = `${size}px Amiri`
    ctx.fillStyle = opts.color || TEXT
    ctx.textBaseline = 'alphabetic'
    ;(ctx as any).direction = 'rtl'
    ctx.textAlign = opts.align === 'center' ? 'center' : 'right'
    const drawX = opts.align === 'center' ? width / 2 : width - pad
    lines.forEach((line, index) => ctx.fillText(line, drawX, pad + size + index * lineHeight))
    const image = `data:image/png;base64,${canvas.toBuffer('image/png').toString('base64')}`
    const left = opts.align === 'center' ? x - width / 2 : x - width
    doc.addImage(image, 'PNG', left, y - size - 4, width, height)
    return Math.max(20, lines.length * (size + 4))
  }
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

function drawBilingualLabel(doc: jsPDF, writeArabic: ArabicWriter, label: BilingualLabel, x: number, y: number, arabicX: number, color = MUTED) {
  setText(doc, 12, color, 'bold')
  doc.text(label.en, x, y)
  writeArabic(doc, label.ar, arabicX, y, { size: 12, color })
}

function writeValue(doc: jsPDF, writeArabic: ArabicWriter, value: string, x: number, y: number, opts: { size?: number; color?: string; style?: 'normal' | 'bold'; maxWidth?: number; align?: 'left' | 'right' }) {
  const isArabic = hasArabic(value)
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

function drawPair(doc: jsPDF, writeArabic: ArabicWriter, label: BilingualLabel, value: string, x: number, y: number, maxValueWidth: number) {
  drawBilingualLabel(doc, writeArabic, label, x, y, x + 150)
  const valueX = hasArabic(value) ? x + 585 : x + 180
  const height = writeValue(doc, writeArabic, value || '—', valueX, y, { size: 13, color: TEXT, style: 'bold', maxWidth: maxValueWidth })
  return y + Math.max(28, height)
}

function drawSectionTitle(doc: jsPDF, writeArabic: ArabicWriter, label: BilingualLabel, x: number, y: number) {
  setText(doc, 15, BRAND_NAVY, 'bold')
  doc.text(label.en, x, y)
  writeArabic(doc, label.ar, 714, y, { size: 15, color: BRAND_NAVY })
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

function buildVariantPdf(data: InvoicePdfData, writeArabic: ArabicWriter) {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'px', format: [PAGE_W, PAGE_H], compress: false })
  registerArabicFont(doc)
  const descriptionText = safeText(data.description, data.descriptionFallback || data.purpose)
  const methodText = safeText(data.method, 'Payment Method')
  const purposeText = safeText(data.purpose, 'Other Fee')

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
  writeArabic(doc, titleArabicLabel(data.statusKind), 714, 116, { size: 23, color: '#ffffff' })
  setText(doc, 13, '#dbeafe', 'bold')
  doc.text(data.title, 70, 122)

  const statusFill = data.statusKind === 'PAID' || data.statusKind === 'WAIVED' ? '#d1fae5' : '#fef3c7'
  const statusStroke = data.statusKind === 'PAID' || data.statusKind === 'WAIVED' ? '#047857' : '#b45309'
  fillRounded(doc, 52, 178, 690, 70, statusFill, statusStroke)
  drawBilingualLabel(doc, writeArabic, LABELS.status, 80, 204, 260, statusStroke)
  setText(doc, 13, statusStroke, 'bold')
  doc.text(data.status, 80, 228)
  writeArabic(doc, statusArabicLabel(data.statusKind), 500, 228, { size: 16, color: statusStroke, maxWidth: 220 })
  setText(doc, 24, BRAND_NAVY, 'bold')
  doc.text(data.amount, 710, 220, { align: 'right' })

  fillRounded(doc, 52, 280, 690, 208, '#f8fafc', BORDER)
  drawSectionTitle(doc, writeArabic, LABELS.invoiceDetails, 80, 310)
  let y = 342
  y = drawPair(doc, writeArabic, LABELS.invoiceNo, data.invoiceNo, 80, y, 410)
  y = drawPair(doc, writeArabic, LABELS.receiptNo, data.receiptNo || '—', 80, y, 410)
  y = drawPair(doc, writeArabic, LABELS.issueDate, data.issueDate, 80, y, 410)
  y = drawPair(doc, writeArabic, LABELS.settledAt, data.settledAt, 80, y, 410)
  y = drawPair(doc, writeArabic, LABELS.paymentMethod, `${methodArabicLabel(methodText)} / ${methodText}`, 80, y, 410)

  fillRounded(doc, 52, 520, 690, 176, '#ffffff', BORDER)
  drawSectionTitle(doc, writeArabic, LABELS.payerDetails, 80, 550)
  y = 582
  y = drawPair(doc, writeArabic, LABELS.payer, data.payerName, 80, y, 410)
  y = drawPair(doc, writeArabic, LABELS.email, data.payerEmail, 80, y, 410)
  y = drawPair(doc, writeArabic, LABELS.country, data.payerCountry, 80, y, 410)
  y = drawPair(doc, writeArabic, LABELS.reference, data.reference, 80, y, 410)

  fillRounded(doc, 52, 728, 690, 196, '#fffbeb', '#fde68a')
  drawSectionTitle(doc, writeArabic, LABELS.programOrService, 80, 760)
  const programText = safeText(data.programOrService, data.programOrServiceFallback)
  writeValue(doc, writeArabic, programText, hasArabic(programText) ? 714 : 80, 792, { size: 14, color: TEXT, style: 'bold', maxWidth: 610 })
  doc.setDrawColor('#f4d675')
  doc.line(80, 852, 714, 852)
  drawBilingualLabel(doc, writeArabic, LABELS.description, 80, 884, 230)
  writeValue(doc, writeArabic, descriptionText, hasArabic(descriptionText) ? 714 : 80, 910, { size: 13, color: TEXT, maxWidth: 610 })

  fillRounded(doc, 52, 952, 690, 92, SOFT_GOLD, '#ead389')
  drawBilingualLabel(doc, writeArabic, LABELS.purpose, 80, 986, 230)
  writeArabic(doc, `${purposeArabicLabel(purposeText)} / ${purposeText}`, 365, 1016, { size: 16, color: BRAND_NAVY, maxWidth: 285 })
  drawBilingualLabel(doc, writeArabic, LABELS.total, 520, 986, 640)
  setText(doc, 22, BRAND_NAVY, 'bold')
  doc.text(data.amount, 714, 1016, { align: 'right' })

  doc.setDrawColor(BORDER)
  doc.line(52, 1084, 742, 1084)
  setText(doc, 11, MUTED, 'normal')
  writeArabic(doc, 'تم إنشاء المستند إلكترونياً عبر منصة AACT ولا يحتاج إلى توقيع يدوي.', 714, 1092, { size: 10, color: MUTED })
  doc.text('Generated electronically by AACT Platform. No manual signature required.', 52, 1110)
  doc.text('aactacademy.com', 742, 1110, { align: 'right' })

  return Buffer.from(doc.output('arraybuffer') as ArrayBuffer)
}

const variants: Record<Variant, ArabicWriter> = {
  'A-current': writeTextArabic(oldVisualArabicWithReverse),
  'B-shape-no-reverse': writeTextArabic((value) => ARABIC_RE.test(value) ? shapeArabicLogical(value) : value),
  'C-canvas-rtl': writeCanvasArabic(),
}

mkdirSync(OUT_DIR, { recursive: true })
const data = sampleInvoice()
for (const [variant, writer] of Object.entries(variants) as [Variant, ArabicWriter][]) {
  const pdf = buildVariantPdf(data, writer)
  const file = join(OUT_DIR, `${variant}.pdf`)
  writeFileSync(file, pdf)
  console.log(`[invoice-variants] wrote ${file}`)
}

const realPdf = Buffer.from(buildInvoicePdf(data, { fontPaths: [FONT_PATH], compress: false }))
const realFile = join(OUT_DIR, 'D-real-after-change.pdf')
writeFileSync(realFile, realPdf)
console.log(`[invoice-variants] wrote ${realFile}`)
