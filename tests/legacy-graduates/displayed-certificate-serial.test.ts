/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test'
import { displayedCertificateSerial, normalizeStampLayout } from '@/lib/legacy-certificate-files'

// The QR verification page must show the serial number that is actually
// displayed on the certificate — the one the admin chose in the stamp
// dialog — not always the automatic serial and not always the old one:
// - never stamped (template PDF) or stamped with the old position-only
//   system: the paper shows the automatic serial only;
// - stamped with a saved layout: the layout's own show/hide toggles
//   decide — old number when shown, automatic when only it is shown;
// - the field must never come out empty when either number exists.
const SERIAL = 'AACT-C-2026-00003'
const LEGACY = 'OLD-2020-123'

function layoutJson(patch: Record<string, unknown>): string {
  const base: any = normalizeStampLayout('BOTTOM_LEFT', 'M')
  return JSON.stringify({ ...base, ...patch })
}

describe('displayed certificate serial', () => {
  test('template and old position-only stamps show the automatic serial', () => {
    expect(displayedCertificateSerial({ serial: SERIAL, legacySerial: LEGACY, qrPosition: null })).toBe(SERIAL)
    expect(displayedCertificateSerial({ serial: SERIAL, legacySerial: LEGACY, qrPosition: '' })).toBe(SERIAL)
    expect(displayedCertificateSerial({ serial: SERIAL, legacySerial: LEGACY, qrPosition: 'BOTTOM_LEFT' })).toBe(SERIAL)
  })

  test('saved layout: shown old number wins over the automatic one', () => {
    expect(displayedCertificateSerial({ serial: SERIAL, legacySerial: LEGACY, qrPosition: layoutJson({}) })).toBe(LEGACY)
  })

  test('saved layout: hidden old number falls back to the shown automatic one', () => {
    const base: any = normalizeStampLayout('BOTTOM_LEFT', 'M')
    const hidden = JSON.stringify({ ...base, legacySerial: { ...base.legacySerial, visible: false } })
    expect(displayedCertificateSerial({ serial: SERIAL, legacySerial: LEGACY, qrPosition: hidden })).toBe(SERIAL)
  })

  test('saved layout: shown old number wins even when the automatic one is hidden', () => {
    const base: any = normalizeStampLayout('BOTTOM_LEFT', 'M')
    const onlyOld = JSON.stringify({ ...base, serial: { ...base.serial, visible: false } })
    expect(displayedCertificateSerial({ serial: SERIAL, legacySerial: LEGACY, qrPosition: onlyOld })).toBe(LEGACY)
  })

  test('saved layout: shown field with no value is skipped', () => {
    expect(displayedCertificateSerial({ serial: SERIAL, legacySerial: null, qrPosition: layoutJson({}) })).toBe(SERIAL)
    expect(displayedCertificateSerial({ serial: SERIAL, legacySerial: '', qrPosition: layoutJson({}) })).toBe(SERIAL)
  })

  test('saved layout: both hidden still yields a number, never empty', () => {
    const base: any = normalizeStampLayout('BOTTOM_LEFT', 'M')
    const none = JSON.stringify({
      ...base,
      legacySerial: { ...base.legacySerial, visible: false },
      serial: { ...base.serial, visible: false },
    })
    expect(displayedCertificateSerial({ serial: SERIAL, legacySerial: LEGACY, qrPosition: none })).toBe(LEGACY)
    expect(displayedCertificateSerial({ serial: SERIAL, legacySerial: null, qrPosition: none })).toBe(SERIAL)
  })
})
