import { jsPDF } from 'jspdf'
import sharp from 'sharp'

export const PDF_PAGE_W = 794
export const PDF_PAGE_H = 1123

const BRAND_NAVY = '#0f2b46'
const BRAND_GOLD = '#c9a227'
const TEXT = '#1f2937'
const MUTED = '#64748b'
const SOFT_BG = '#f8fafc'

export type PdfDir = 'rtl' | 'ltr'
export type OfficialPdfRow = { label: string; value: unknown; dir?: PdfDir }
export type OfficialPdfSection = { title: string; rows?: OfficialPdfRow[]; lines?: string[] }
export type OfficialPdfTable = { title: string; columns: string[]; rows: Array<Array<unknown>>; maxRows?: number }

export interface OfficialPdfOptions {
  title: string
  subtitle?: string
  documentLabel?: string
  status?: string
  statusTone?: 'success' | 'warning' | 'info'
  reference?: string
  issuedAt?: Date | string | null
  sections?: OfficialPdfSection[]
  tables?: OfficialPdfTable[]
  footer?: string
}

export function pdfSafeText(value: unknown, fallback = '—') {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text || fallback
}

export function pdfDate(value: Date | string | null | undefined) {
  if (!value) return '—'
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toISOString().slice(0, 10)
}

export function pdfPercent(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return `${Math.round(value * 100) / 100}%`
  if (typeof value === 'string' && value.trim()) return `${value}%`
  return '—'
}

export function pdfMoney(value: unknown, currency = 'USD') {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : Number(value || 0)
  return `${(Number.isFinite(n) ? n : 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`
}

function esc(value: unknown) {
  return pdfSafeText(value, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function wrapText(input: unknown, maxChars: number, maxLines = 3) {
  const words = pdfSafeText(input, '').split(' ').filter(Boolean)
  const out: string[] = []
  let current = ''
  for (const word of words) {
    const next = current ? `${current} ${word}` : word
    if (next.length > maxChars && current) {
      out.push(current)
      current = word
      if (out.length >= maxLines) break
    } else {
      current = next
    }
  }
  if (current && out.length < maxLines) out.push(current)
  return out.length ? out : ['—']
}

function text(x: number, y: number, content: unknown, opts: { size?: number; fill?: string; weight?: number; anchor?: 'start' | 'middle' | 'end'; dir?: PdfDir; family?: string } = {}) {
  const size = opts.size || 16
  const fill = opts.fill || TEXT
  const anchor = opts.anchor || 'start'
  const dir = opts.dir || 'rtl'
  const weight = opts.weight || 700
  const family = opts.family || "'DejaVu Sans','Noto Naskh Arabic','Arial','Tahoma',sans-serif"
  return `<text x="${x}" y="${y}" text-anchor="${anchor}" direction="${dir}" unicode-bidi="plaintext" style="font-family:${family};font-size:${size}px;font-weight:${weight};fill:${fill};dominant-baseline:alphabetic">${esc(content)}</text>`
}

function pageShell(body: string, pageNo: number, totalPages: number, opts: OfficialPdfOptions) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${PDF_PAGE_W}" height="${PDF_PAGE_H}" viewBox="0 0 ${PDF_PAGE_W} ${PDF_PAGE_H}">
  <rect width="${PDF_PAGE_W}" height="${PDF_PAGE_H}" fill="#ffffff"/>
  <rect x="0" y="0" width="${PDF_PAGE_W}" height="132" fill="${BRAND_NAVY}"/>
  <rect x="0" y="132" width="${PDF_PAGE_W}" height="8" fill="${BRAND_GOLD}"/>
  <circle cx="704" cy="66" r="38" fill="${BRAND_GOLD}"/>
  ${text(704, 76, 'AACT', { size: 24, fill: '#ffffff', weight: 900, anchor: 'middle', dir: 'ltr', family: 'Arial,sans-serif' })}
  ${text(660, 52, 'الأكاديمية الأمريكية للاستشارات والتدريب', { size: 23, fill: '#ffffff', weight: 900, anchor: 'end', dir: 'rtl' })}
  ${text(660, 86, 'American Academy for Consulting and Training', { size: 16, fill: '#dbeafe', weight: 700, anchor: 'end', dir: 'ltr', family: 'Arial,sans-serif' })}
  ${text(88, 62, opts.documentLabel || 'OFFICIAL DOCUMENT', { size: 25, fill: '#ffffff', weight: 900, anchor: 'start', dir: 'ltr', family: 'Arial,sans-serif' })}
  ${text(88, 96, opts.subtitle || 'وثيقة رسمية قابلة للطباعة', { size: 16, fill: '#f7edd0', weight: 800, anchor: 'start', dir: 'rtl' })}
  ${body}
  <line x1="52" y1="1044" x2="742" y2="1044" stroke="#e2e8f0"/>
  ${text(742, 1070, opts.footer || 'تم إصدار هذه الوثيقة إلكترونياً من منصة AACT.', { size: 14, fill: MUTED, weight: 700, anchor: 'end', dir: 'rtl' })}
  ${text(52, 1070, `Page ${pageNo} / ${totalPages}`, { size: 12, fill: MUTED, weight: 700, anchor: 'start', dir: 'ltr', family: 'Arial,sans-serif' })}
  ${text(397, 1096, 'aactacademy.com', { size: 13, fill: BRAND_NAVY, weight: 800, anchor: 'middle', dir: 'ltr', family: 'Arial,sans-serif' })}
</svg>`
}

function statusColors(tone?: OfficialPdfOptions['statusTone']) {
  if (tone === 'success') return { bg: '#d1fae5', fg: '#047857', stroke: '#10b981' }
  if (tone === 'warning') return { bg: '#fef3c7', fg: '#b45309', stroke: '#f59e0b' }
  return { bg: '#e0f2fe', fg: '#0369a1', stroke: '#38bdf8' }
}

function buildBodies(opts: OfficialPdfOptions) {
  const bodies: string[] = []
  let body = ''
  let y = 178
  const pushPage = () => {
    bodies.push(body)
    body = ''
    y = 174
  }
  const ensure = (height: number) => {
    if (y + height > 1025) pushPage()
  }

  const colors = statusColors(opts.statusTone)
  body += text(742, y, opts.title, { size: 28, fill: BRAND_NAVY, weight: 900, anchor: 'end', dir: 'rtl' })
  y += 34
  const meta = [opts.reference ? `Reference: ${opts.reference}` : null, `Issued: ${pdfDate(opts.issuedAt || new Date())}`].filter(Boolean).join(' · ')
  body += text(742, y, meta, { size: 13, fill: MUTED, weight: 700, anchor: 'end', dir: 'ltr', family: 'Arial,sans-serif' })
  if (opts.status) {
    body += `<rect x="52" y="${y + 18}" width="690" height="54" rx="18" fill="${colors.bg}" stroke="${colors.stroke}"/>`
    body += text(710, y + 53, opts.status, { size: 19, fill: colors.fg, weight: 900, anchor: 'end', dir: 'rtl' })
    y += 90
  } else {
    y += 38
  }

  for (const section of opts.sections || []) {
    const rows = section.rows || []
    const lines = section.lines || []
    ensure(54 + rows.length * 34 + lines.length * 28)
    body += `<rect x="52" y="${y}" width="690" height="${Math.max(70, 48 + rows.length * 34 + lines.length * 28)}" rx="20" fill="${SOFT_BG}" stroke="#e2e8f0"/>`
    body += text(710, y + 34, section.title, { size: 18, fill: BRAND_NAVY, weight: 900, anchor: 'end', dir: 'rtl' })
    let sy = y + 66
    for (const row of rows) {
      const vals = wrapText(row.value, row.dir === 'ltr' ? 58 : 62, 2)
      body += text(706, sy, row.label, { size: 14, fill: MUTED, weight: 900, anchor: 'end', dir: 'rtl' })
      vals.forEach((v, idx) => {
        body += text(84, sy + idx * 22, v, { size: 14, fill: TEXT, weight: 700, anchor: 'start', dir: row.dir || 'rtl', family: row.dir === 'ltr' ? 'Arial,sans-serif' : undefined })
      })
      sy += Math.max(34, vals.length * 22 + 8)
    }
    for (const line of lines) {
      const vals = wrapText(line, 82, 3)
      vals.forEach((v, idx) => { body += text(706, sy + idx * 22, v, { size: 14, fill: TEXT, weight: 700, anchor: 'end', dir: 'rtl' }) })
      sy += Math.max(28, vals.length * 22 + 6)
    }
    y = sy + 16
  }

  for (const table of opts.tables || []) {
    const rows = table.rows.slice(0, table.maxRows || 18)
    ensure(74 + rows.length * 34)
    body += `<rect x="52" y="${y}" width="690" height="${70 + rows.length * 34}" rx="20" fill="#ffffff" stroke="#e2e8f0"/>`
    body += text(710, y + 34, table.title, { size: 18, fill: BRAND_NAVY, weight: 900, anchor: 'end', dir: 'rtl' })
    let tx = 690
    const colW = 620 / Math.max(1, table.columns.length)
    table.columns.forEach((c) => { body += text(tx, y + 64, c, { size: 12, fill: MUTED, weight: 900, anchor: 'end', dir: 'rtl' }); tx -= colW })
    let ty = y + 94
    rows.forEach((r, ri) => {
      body += `<rect x="72" y="${ty - 21}" width="650" height="30" rx="8" fill="${ri % 2 ? '#ffffff' : '#f8fafc'}"/>`
      let cx = 690
      r.slice(0, table.columns.length).forEach((cell) => { body += text(cx, ty, pdfSafeText(cell), { size: 12, fill: TEXT, weight: 700, anchor: 'end', dir: 'rtl' }); cx -= colW })
      ty += 34
    })
    y = ty + 18
  }

  bodies.push(body)
  return bodies
}

export async function renderOfficialPdf(opts: OfficialPdfOptions) {
  const bodies = buildBodies(opts)
  const doc = new jsPDF({ orientation: 'portrait', unit: 'px', format: [PDF_PAGE_W, PDF_PAGE_H], compress: true })
  for (let i = 0; i < bodies.length; i++) {
    if (i > 0) doc.addPage([PDF_PAGE_W, PDF_PAGE_H], 'portrait')
    const svg = pageShell(bodies[i], i + 1, bodies.length, opts)
    const png = await sharp(Buffer.from(svg)).png().toBuffer()
    doc.addImage(new Uint8Array(png), 'PNG', 0, 0, PDF_PAGE_W, PDF_PAGE_H)
  }
  return Buffer.from(doc.output('arraybuffer'))
}

export function pdfResponse(pdf: Buffer, filename: string) {
  const safe = filename.replace(/[^a-zA-Z0-9._-]+/g, '-')
  return new Response(new Uint8Array(pdf), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${safe.endsWith('.pdf') ? safe : `${safe}.pdf`}"`,
      'Cache-Control': 'private, no-store, max-age=0',
      'Content-Length': String(pdf.length),
    },
  })
}
