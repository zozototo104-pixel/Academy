import { jsPDF } from 'jspdf'
import { ARABIC_FONT_NAME, registerArabicFont, safeText } from '@/lib/invoice-pdf'
import { drawArabicImage, toVisualArabic } from '@/lib/pdf-arabic'
import type { OfficialPdfOptions, OfficialPdfSection, OfficialPdfTable } from '@/lib/pdf/official'

export type TranscriptPdfOptions = {
  fontPaths?: string[]
  compress?: boolean
}

const PAGE_W = 794
const PAGE_H = 1123
const CONTENT_X = 52
const CONTENT_W = 690
const CONTENT_RIGHT = CONTENT_X + CONTENT_W
const CONTENT_BOTTOM = 1030
const BRAND_NAVY = '#0f2b46'
const BRAND_GOLD = '#c9a227'
const SOFT_GOLD = '#f7edd0'
const TEXT = '#1f2937'
const MUTED = '#64748b'
const BORDER = '#e2e8f0'

function hasArabic(value: unknown) {
  return /[\u0600-\u06FF\u0750-\u077F]/.test(String(value ?? ''))
}

function setText(doc: jsPDF, size: number, color = TEXT, style: 'normal' | 'bold' = 'normal', font = 'helvetica') {
  doc.setFont(font, style)
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

let warnedArabicFallback = false

function writeArabic(doc: jsPDF, value: string, rightX: number, y: number, opts: { size?: number; color?: string; maxWidth?: number; maxLines?: number } = {}) {
  const size = opts.size || 13
  try {
    return drawArabicImage(doc, safeText(value), rightX, y, {
      size,
      color: opts.color || TEXT,
      maxWidth: opts.maxWidth,
      maxLines: opts.maxLines || 3,
      align: 'right',
    })
  } catch (error) {
    if (!warnedArabicFallback) {
      warnedArabicFallback = true
      console.warn('[transcript-pdf] Canvas Arabic renderer failed; falling back to shaped jsPDF text.', error)
    }
    setText(doc, size, opts.color || TEXT, 'normal', ARABIC_FONT_NAME)
    const logical = safeText(value)
    const lines = opts.maxWidth ? doc.splitTextToSize(logical, opts.maxWidth).slice(0, opts.maxLines || 3) : [logical]
    const visualLines = lines.map((line: string) => toVisualArabic(line))
    doc.text(visualLines, rightX, y, { align: 'right' })
    return Math.max(20, visualLines.length * (size + 4))
  }
}

function latinLines(doc: jsPDF, value: string, size: number, maxWidth: number, style: 'normal' | 'bold' = 'bold') {
  setText(doc, size, TEXT, style)
  return doc.splitTextToSize(safeText(value), maxWidth).slice(0, 3) as string[]
}

function estimateLines(doc: jsPDF, value: unknown, size: number, maxWidth: number, arabicReady: boolean) {
  const text = safeText(value)
  if (hasArabic(text) && arabicReady) {
    setText(doc, size, TEXT, 'normal', ARABIC_FONT_NAME)
    return Math.min(3, Math.max(1, doc.splitTextToSize(text, maxWidth).length))
  }
  return Math.min(3, Math.max(1, latinLines(doc, text, size, maxWidth).length))
}

function drawLatin(doc: jsPDF, value: string, rightX: number, y: number, opts: { size?: number; color?: string; style?: 'normal' | 'bold'; maxWidth?: number }) {
  const size = opts.size || 13
  const lines = opts.maxWidth ? latinLines(doc, value, size, opts.maxWidth, opts.style || 'bold') : [safeText(value)]
  setText(doc, size, opts.color || TEXT, opts.style || 'bold')
  doc.text(lines, rightX, y, { align: 'right' })
  return Math.max(20, lines.length * (size + 5))
}

function drawValue(doc: jsPDF, value: unknown, rightX: number, y: number, opts: { size?: number; color?: string; maxWidth: number; dir?: 'rtl' | 'ltr'; arabicReady: boolean }) {
  const text = safeText(value)
  if (hasArabic(text) && opts.arabicReady && opts.dir !== 'ltr') {
    return writeArabic(doc, text, rightX, y, { size: opts.size || 13, color: opts.color, maxWidth: opts.maxWidth })
  }
  return drawLatin(doc, text, rightX, y, { size: opts.size || 13, color: opts.color, maxWidth: opts.maxWidth })
}

export function buildTranscriptPdf(opts: OfficialPdfOptions, options: TranscriptPdfOptions = {}): Uint8Array {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'px', format: [PAGE_W, PAGE_H], compress: options.compress ?? true })
  const arabicReady = registerArabicFont(doc, options.fontPaths)
  if (!arabicReady) console.warn('[transcript-pdf] Arabic font unavailable; Arabic text may not render correctly.')

  const issued = opts.issuedAt ? new Date(opts.issuedAt) : new Date()
  const issuedText = Number.isNaN(issued.getTime()) ? '—' : issued.toISOString().slice(0, 10)
  let y = 0

  function drawFullHeader() {
    doc.setFillColor(BRAND_NAVY)
    doc.rect(0, 0, PAGE_W, 140, 'F')
    doc.setFillColor(BRAND_GOLD)
    doc.rect(0, 140, PAGE_W, 8, 'F')
    doc.circle(704, 72, 38, 'F')
    setText(doc, 22, '#ffffff', 'bold')
    doc.text('AACT', 704, 80, { align: 'center' })
    setText(doc, 24, '#ffffff', 'bold')
    doc.text('American Academy for Consulting and Training', 70, 54)
    setText(doc, 15, '#dbeafe', 'bold')
    doc.text(safeText(opts.subtitle, 'Official Academic Transcript'), 70, 86)
    if (opts.documentLabel) {
      setText(doc, 12, '#f4d675', 'bold')
      doc.text(opts.documentLabel, 70, 118)
    }
    if (arabicReady) writeArabic(doc, opts.title, 640, 112, { size: 21, color: '#ffffff', maxWidth: 380 })
    y = 148
  }

  function drawSlimHeader() {
    doc.setFillColor(BRAND_NAVY)
    doc.rect(0, 0, PAGE_W, 64, 'F')
    doc.setFillColor(BRAND_GOLD)
    doc.rect(0, 64, PAGE_W, 6, 'F')
    doc.circle(714, 32, 22, 'F')
    setText(doc, 13, '#ffffff', 'bold')
    doc.text('AACT', 714, 37, { align: 'center' })
    setText(doc, 14, '#ffffff', 'bold')
    doc.text('American Academy for Consulting and Training', 52, 40)
    if (arabicReady) writeArabic(doc, opts.title, 660, 40, { size: 14, color: '#ffffff', maxWidth: 260 })
    y = 96
  }

  function ensure(height: number) {
    if (y + height <= CONTENT_BOTTOM) return
    doc.addPage([PAGE_W, PAGE_H], 'portrait')
    drawSlimHeader()
  }

  function drawMetaAndStatus() {
    let metaY = y + 26
    setText(doc, 11, MUTED, 'bold')
    doc.text(`Reference: ${safeText(opts.reference, '—')}`, CONTENT_X, metaY)
    if (arabicReady) {
      doc.text(issuedText, 612, metaY, { align: 'right' })
      writeArabic(doc, 'تاريخ الإصدار:', CONTENT_RIGHT, metaY, { size: 11, color: MUTED, maxWidth: 120 })
    } else doc.text(`Issued: ${issuedText}`, CONTENT_RIGHT, metaY, { align: 'right' })
    y = metaY + 14

    if (opts.status) {
      const tone = opts.statusTone || 'info'
      const fill = tone === 'success' ? '#d1fae5' : tone === 'warning' ? '#fef3c7' : '#e0f2fe'
      const stroke = tone === 'success' ? '#047857' : tone === 'warning' ? '#b45309' : '#0369a1'
      fillRounded(doc, CONTENT_X, y, CONTENT_W, 54, fill, stroke)
      const parts = safeText(opts.status).split(' / ')
      const arabicPart = parts.find((p) => hasArabic(p))
      const latinPart = parts.find((p) => !hasArabic(p))
      if (latinPart) {
        setText(doc, 13, stroke, 'bold')
        doc.text(latinPart, 80, y + 34)
      }
      if (arabicPart && arabicReady) writeArabic(doc, arabicPart, 714, y + 34, { size: 15, color: stroke })
      y += 54 + 22
    } else {
      y += 12
    }
  }

  function sectionHeight(section: OfficialPdfSection) {
    const rows = section.rows || []
    let height = 52
    for (const row of rows) {
      const lines = estimateLines(doc, row.value, 13, 380, arabicReady)
      height += Math.max(30, lines * 19 + 8)
    }
    if (section.lines?.length) height += section.lines.length * 22 + 6
    return height + 14
  }

  function drawSection(section: OfficialPdfSection, index: number) {
    const height = sectionHeight(section)
    ensure(height)
    const cardY = y
    fillRounded(doc, CONTENT_X, cardY, CONTENT_W, height, index % 2 ? '#ffffff' : '#f8fafc', BORDER)
    if (arabicReady) writeArabic(doc, section.title, 714, cardY + 36, { size: 15, color: BRAND_NAVY, maxWidth: 640 })
    else drawLatin(doc, section.title, 714, cardY + 36, { size: 15, color: BRAND_NAVY, maxWidth: 640 })
    let rowY = cardY + 52
    for (const row of section.rows || []) {
      const lines = estimateLines(doc, row.value, 13, 380, arabicReady)
      const rowH = Math.max(30, lines * 19 + 8)
      if (arabicReady) writeArabic(doc, row.label, 714, rowY + 20, { size: 12, color: MUTED, maxWidth: 200 })
      else drawLatin(doc, row.label, 714, rowY + 20, { size: 12, color: MUTED, maxWidth: 200 })
      drawValue(doc, row.value, 470, rowY + 20, { size: 13, maxWidth: 380, dir: row.dir, arabicReady })
      rowY += rowH
    }
    for (const line of section.lines || []) {
      drawValue(doc, line, 714, rowY + 18, { size: 12.5, maxWidth: 640, arabicReady })
      rowY += 22
    }
    y = cardY + height + 20
  }

  function tableLayout(table: OfficialPdfTable) {
    const cols = Math.max(1, table.columns.length)
    const weights = cols === 5 ? [2.3, 1.6, 0.8, 0.9, 1.0] : Array.from({ length: cols }, () => 1)
    const totalWeight = weights.reduce((a, b) => a + b, 0)
    const widths = weights.map((w) => (CONTENT_W - 20) * (w / totalWeight))
    const rightEdges: number[] = []
    let cursor = CONTENT_RIGHT - 10
    for (let i = 0; i < cols; i++) {
      rightEdges.push(cursor)
      cursor -= widths[i]
    }
    const rows = table.rows.slice(0, table.maxRows || 18)
    const rowHeights = rows.map((row) => {
      let lines = 1
      row.slice(0, cols).forEach((cell, i) => {
        lines = Math.max(lines, Math.min(2, estimateLines(doc, cell, 11.5, widths[i] - 18, arabicReady)))
      })
      return Math.max(32, lines * 18 + 12)
    })
    const height = 58 + 34 + rowHeights.reduce((a, b) => a + b, 0) + 16
    return { widths, rightEdges, rows, rowHeights, height }
  }

  function drawTable(table: OfficialPdfTable) {
    const layout = tableLayout(table)
    ensure(layout.height)
    const cardY = y
    fillRounded(doc, CONTENT_X, cardY, CONTENT_W, layout.height, '#ffffff', BORDER)
    if (arabicReady) writeArabic(doc, table.title, 714, cardY + 38, { size: 16, color: BRAND_NAVY, maxWidth: 640 })
    else drawLatin(doc, table.title, 714, cardY + 38, { size: 16, color: BRAND_NAVY, maxWidth: 640 })

    const headerY = cardY + 56
    doc.setFillColor(SOFT_GOLD)
    doc.roundedRect(CONTENT_X + 10, headerY, CONTENT_W - 20, 32, 8, 8, 'F')
    table.columns.forEach((col, i) => {
      drawValue(doc, col, layout.rightEdges[i], headerY + 21, { size: 12, color: MUTED, maxWidth: layout.widths[i] - 18, arabicReady })
    })

    let rowY = headerY + 34
    layout.rows.forEach((row, ri) => {
      const rowH = layout.rowHeights[ri]
      if (ri % 2 === 0) {
        doc.setFillColor('#f8fafc')
        doc.roundedRect(CONTENT_X + 10, rowY, CONTENT_W - 20, rowH, 8, 8, 'F')
      }
      row.slice(0, table.columns.length).forEach((cell, i) => {
        drawValue(doc, cell, layout.rightEdges[i], rowY + 21, { size: 11.5, maxWidth: layout.widths[i] - 18, arabicReady })
      })
      rowY += rowH
    })
    y = cardY + layout.height + 20
  }

  drawFullHeader()
  drawMetaAndStatus()
  ;(opts.sections || []).forEach((section, i) => drawSection(section, i))
  ;(opts.tables || []).forEach((table) => drawTable(table))

  const totalPages = doc.getNumberOfPages()
  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i)
    doc.setDrawColor(BORDER)
    doc.line(CONTENT_X, 1078, CONTENT_RIGHT, 1078)
    if (opts.footer && arabicReady) writeArabic(doc, opts.footer, 714, 1096, { size: 10, color: MUTED, maxWidth: 470 })
    setText(doc, 10, MUTED, 'normal')
    doc.text('Generated electronically by AACT Platform.', CONTENT_X, 1112)
    doc.text(`Page ${i} of ${totalPages}`, CONTENT_RIGHT, 1112, { align: 'right' })
  }

  return new Uint8Array(doc.output('arraybuffer'))
}
