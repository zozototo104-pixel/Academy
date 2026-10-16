import { existsSync } from 'fs'
import { join } from 'path'
import type { jsPDF } from 'jspdf'

type CanvasModule = typeof import('@napi-rs/canvas')

const ARABIC_RE = /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/
const CANVAS_ARABIC_FONT_FAMILY = 'Amiri'
const CANVAS_ARABIC_FONT_PATH = join(process.cwd(), 'public', 'fonts', 'Amiri-Regular.ttf')
const DEFAULT_CANVAS_TEXT = '#1f2937'

type ArabicForms = { iso: string; fin?: string; ini?: string; med?: string }
export type DrawArabicImageOptions = {
  size?: number
  color?: string
  maxWidth?: number
  maxLines?: number
  align?: 'right' | 'center'
  fontPath?: string
}

let canvasArabicFontRegistrationAttempted = false
let canvasArabicFontRegistrationError: unknown = null
let canvasModule: CanvasModule | null = null

function loadCanvasModule(): CanvasModule {
  if (!canvasModule) canvasModule = require('@napi-rs/canvas') as CanvasModule
  return canvasModule
}

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

function ensureCanvasArabicFont(fontPath = CANVAS_ARABIC_FONT_PATH) {
  if (canvasArabicFontRegistrationAttempted) {
    if (canvasArabicFontRegistrationError) throw canvasArabicFontRegistrationError
    return
  }

  canvasArabicFontRegistrationAttempted = true
  try {
    if (!existsSync(fontPath)) throw new Error(`Missing Arabic canvas font: ${fontPath}`)
    loadCanvasModule().GlobalFonts.registerFromPath(fontPath, CANVAS_ARABIC_FONT_FAMILY)
  } catch (error) {
    canvasArabicFontRegistrationError = error
    throw error
  }
}

function wrapCanvasLines(text: string, size: number, maxWidth: number) {
  const { createCanvas } = loadCanvasModule()
  const probe = createCanvas(10, 10)
  const ctx = probe.getContext('2d')
  ctx.font = `${size}px ${CANVAS_ARABIC_FONT_FAMILY}`
  const words = String(text || '').split(/\s+/).filter(Boolean)
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
  return lines.length ? lines : [String(text || '')]
}

export function drawArabicImage(
  doc: jsPDF,
  text: string,
  x: number,
  y: number,
  opts: DrawArabicImageOptions = {}
): number {
  ensureCanvasArabicFont(opts.fontPath)
  const logical = String(text || '').trim() || '—'
  const size = opts.size || 13
  const maxWidth = opts.maxWidth || Math.min(620, Math.max(180, opts.align === 'center' ? x * 2 : x - 52))
  const maxLines = opts.maxLines || 3
  const lines = wrapCanvasLines(logical, size, maxWidth).slice(0, maxLines)
  const lineHeight = size + 6
  const pad = 8
  const width = Math.ceil(maxWidth + pad * 2)
  const height = Math.ceil(lines.length * lineHeight + pad * 2)
  const scale = 2
  const { createCanvas } = loadCanvasModule()
  const canvas = createCanvas(width * scale, height * scale)
  const ctx = canvas.getContext('2d')
  ctx.scale(scale, scale)
  ctx.font = `${size}px ${CANVAS_ARABIC_FONT_FAMILY}`
  ctx.fillStyle = opts.color || DEFAULT_CANVAS_TEXT
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

/**
 * Shape logical Arabic text for jsPDF text() fallback without reversing the run.
 * The primary PDF path draws Arabic through canvas images; this is only a no-canvas fallback.
 */
export function toVisualArabic(text: string): string {
  const input = String(text || '')
  if (!ARABIC_RE.test(input)) return input
  return shapeArabicLogical(input).replace(/\s+([:،؛])/g, '$1')
}
