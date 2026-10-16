import { existsSync } from 'fs'
import { join } from 'path'
import type { jsPDF } from 'jspdf'
import { createCanvas, GlobalFonts } from '@napi-rs/canvas'

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

function reverseChars(value: string) {
  return Array.from(value).reverse().join('')
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

/**
 * Convert logical Arabic text to a pre-shaped visual order suitable for jsPDF text() with align:right.
 * Do not combine this with jsPDF setR2L/isInputRtl; that would apply a second bidi pass and flip mixed text.
 */
export function toVisualArabic(text: string): string {
  const input = String(text || '')
  if (!ARABIC_RE.test(input)) return input
  const shaped = shapeArabicLogical(input)
  return reverseArabicRunPreservingLtr(shaped)
    .replace(/\s+([:،؛])/g, '$1')
}
