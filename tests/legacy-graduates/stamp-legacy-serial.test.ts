/// <reference types="bun-types" />
import sharp from 'sharp'
import { describe, expect, test } from 'bun:test'
import {
  normalizeStampLayout,
  renderCertificateStampTextOverlayPng,
  stampValue,
} from '@/lib/legacy-certificate-files'

// The stamp dialog offers two serial fields side by side: the automatic
// serial and the old (legacy) serial, each with its own show/hide toggle.
// These tests pin the wiring: the old number flows from the certificate
// record into the stamp, old saved layouts gain the field by default
// without moving their existing fields, a visible field with a value draws,
// and a visible field WITHOUT a value draws nothing (so certificates
// without an old number are unaffected).
//
// Pixel comparisons are difference-based only (draws vs does-not-draw),
// so they hold under any font set — unlike comparisons against the
// machine's own system fonts, which differ between machines.
type Ink = { mask: Uint8Array; count: number; width: number; height: number }

async function inkMask(png: Buffer): Promise<Ink> {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true })
  const { width, height, channels } = info
  const mask = new Uint8Array(width * height)
  let count = 0
  for (let i = 0; i < width * height; i++) {
    const o = i * channels
    const alpha = channels === 4 ? data[o + 3] : 255
    const gray = (data[o] + data[o + 1] + data[o + 2]) / 3
    if (alpha > 128 && gray < 128) {
      mask[i] = 1
      count++
    }
  }
  return { mask, count, width, height }
}

function jaccard(a: Ink, b: Ink): number {
  let inter = 0
  let union = 0
  for (let i = 0; i < a.mask.length; i++) {
    if (a.mask[i] && b.mask[i]) inter++
    if (a.mask[i] || b.mask[i]) union++
  }
  return union ? inter / union : 0
}

const BASE_VALUES = {
  holderName: 'Ahmed Mohamed Ali',
  program: 'Crisis Management Diploma',
  grade: 'Excellent',
  issuedAt: new Date('2024-06-30'),
  serial: 'AACT-C-2026-00001',
}

describe('legacy certificate stamp old-serial field', () => {
  test('old layouts gain the field by default and the value resolves', () => {
    // A layout saved before this field existed has no legacySerial key.
    const oldSaved = JSON.stringify({
      holderName: { x: 50, y: 36, width: 72, fontSize: 4.2, visible: false },
      serial: { x: 15, y: 95, width: 30, fontSize: 1.25, visible: true },
      qr: { x: 15, y: 80, size: 16, visible: true },
    })
    const layout = normalizeStampLayout(oldSaved, 'M')
    // Existing fields keep their saved positions.
    expect(layout.serial.x).toBe(15)
    expect(layout.serial.y).toBe(95)
    // The new field appears with a sensible default, visible like the serial.
    expect(layout.legacySerial.visible).toBe(true)
    expect(layout.legacySerial.x).toBe(15)
    expect(layout.legacySerial.y).toBeLessThan(layout.serial.y)
    expect(layout.legacySerial.y).toBeGreaterThan(80)

    expect(stampValue('legacySerial', layout.legacySerial, { legacySerial: 'OLD-2020-123' })).toBe('OLD-2020-123')
    expect(stampValue('legacySerial', layout.legacySerial, {})).toBe('')
    expect(stampValue('serial', layout.serial, BASE_VALUES)).toBe('AACT-C-2026-00001')
  })

  test(
    'the old number draws when present and draws nothing when absent',
    async () => {
      const base = normalizeStampLayout('BOTTOM_LEFT', 'M')
      const withValue = await renderCertificateStampTextOverlayPng({
        width: 595,
        height: 842,
        layout: base,
        values: { ...BASE_VALUES, legacySerial: 'OLD-2020-123' },
      })
      const hidden = await renderCertificateStampTextOverlayPng({
        width: 595,
        height: 842,
        layout: { ...base, legacySerial: { ...base.legacySerial, visible: false } },
        values: { ...BASE_VALUES, legacySerial: 'OLD-2020-123' },
      })
      const empty = await renderCertificateStampTextOverlayPng({
        width: 595,
        height: 842,
        layout: base,
        values: BASE_VALUES,
      })
      expect(withValue).not.toBeNull()
      expect(hidden).not.toBeNull()
      expect(empty).not.toBeNull()
      const inkWith = await inkMask(withValue!)
      const inkHidden = await inkMask(hidden!)
      const inkEmpty = await inkMask(empty!)
      // Visible + value must add ink beyond the hidden render.
      expect(jaccard(inkWith, inkHidden)).toBeLessThan(0.99)
      expect(inkWith.count).toBeGreaterThan(inkHidden.count)
      // Visible + NO value must render exactly like hidden: nothing drawn.
      expect(jaccard(inkEmpty, inkHidden)).toBe(1)
    },
    120000,
  )
})
