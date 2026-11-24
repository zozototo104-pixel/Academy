import { describe, expect, it } from 'bun:test'
import { looksLikeBrokenBookPageText } from '@/lib/academic-output-quality'

// Page-level garble gate (point 1 of the 2026-11-24 OCR quality fix):
// a page whose text is mostly font-glyph garbage must go to OCR even with
// thousands of characters, while clean Arabic, mixed, table and English
// pages stay native. Thresholds are pinned here, not in prose.
const cleanArabic = 'تتناول هذه الوحدة أسس المحاسبة المالية وأهدافها في خدمة الإدارة. '.repeat(40)
const cleanMixed = 'تعتمد القوائم المالية على معيار IFRS 9 لقياس الأدوات المالية، ويبلغ صافي الربح 125000 ريال بعد خصم المصروفات التشغيلية البالغة 48000 ريال. '.repeat(12)
const tablePage = 'البيان 2023 2024 2025\nالأصول المتداولة 125000 138000 151000\nالنقدية 42000 47000 53000\nالذمم المدينة 31000 34000 38000\nالمخزون 52000 57000 60000\nإجمالي الأصول 125000 138000 151000\n'
const englishPage = 'Page 1: Academic evidence sentence about management theory and practice. '.repeat(10)
const tofuPage = ('□ '.repeat(300) + 'א ב ג K W J □ '.repeat(60)).repeat(2)
const hebrewPage = 'אבגדהוזחטיכלמנסעפצקרשת '.repeat(40)
const fragmentPage = 'א K W J ב ג □ '.repeat(120)
const twoPctTofu = (cleanArabic.slice(0, 1500) + '□'.repeat(30) + cleanArabic.slice(1500)).slice(0, 2000)
const sixPctTofu = (cleanArabic.slice(0, 1000) + '□'.repeat(120) + cleanArabic.slice(1000)).slice(0, 2000)

describe('looksLikeBrokenBookPageText', () => {
  it('keeps clean Arabic pages native', () => {
    expect(looksLikeBrokenBookPageText(cleanArabic)).toBe(false)
  })

  it('keeps mixed Arabic pages with English terms and numbers native', () => {
    expect(looksLikeBrokenBookPageText(cleanMixed)).toBe(false)
  })

  it('keeps number-heavy table pages native', () => {
    expect(looksLikeBrokenBookPageText(tablePage)).toBe(false)
  })

  it('keeps coherent English pages native', () => {
    expect(looksLikeBrokenBookPageText(englishPage)).toBe(false)
    expect(looksLikeBrokenBookPageText('x'.repeat(120))).toBe(false)
  })

  it('keeps short real headings and numbers-only pages native', () => {
    expect(looksLikeBrokenBookPageText('الفصل الأول')).toBe(false)
    expect(looksLikeBrokenBookPageText('125000 138000 151000 42000 47000 53000')).toBe(false)
  })

  it('flags tofu + Hebrew + single-letter fragment pages as broken', () => {
    expect(looksLikeBrokenBookPageText(tofuPage)).toBe(true)
    expect(looksLikeBrokenBookPageText(fragmentPage)).toBe(true)
  })

  it('flags a Hebrew-dominant page as broken', () => {
    expect(looksLikeBrokenBookPageText(hebrewPage)).toBe(true)
  })

  it('flags pure glyph garbage and empty text as broken', () => {
    expect(looksLikeBrokenBookPageText('□□□□□□□□')).toBe(true)
    expect(looksLikeBrokenBookPageText('')).toBe(true)
  })

  it('tolerates a few stray glyphs but flags a visible share', () => {
    expect(looksLikeBrokenBookPageText(twoPctTofu)).toBe(false)
    expect(looksLikeBrokenBookPageText(sixPctTofu)).toBe(true)
  })
})
