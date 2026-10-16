/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test'
import { validateAdmissionFileSignature } from '../../src/lib/file-signature'
import { backupTableNames } from '../../src/lib/backups'
import { clientIpFromHeaders } from '../../src/lib/rate-limit'

describe('files C2 upload and backup safety', () => {
  test('magic bytes infer octet-stream uploads and reject mismatched extensions', () => {
    const pdf = Buffer.from('%PDF-1.7\nbody', 'utf8')
    expect(validateAdmissionFileSignature({ buffer: pdf, fileName: 'receipt.pdf', mimeType: 'application/octet-stream' })).toMatchObject({ ok: true, mimeType: 'application/pdf' })
    expect(validateAdmissionFileSignature({ buffer: pdf, fileName: 'receipt.pdf', mimeType: '' })).toMatchObject({ ok: true, mimeType: 'application/pdf' })
    expect(validateAdmissionFileSignature({ buffer: pdf, fileName: 'receipt.png', mimeType: 'image/png' }).ok).toBe(false)
    const valid = validateAdmissionFileSignature({ buffer: pdf, fileName: 'receipt.pdf', mimeType: 'application/pdf' })
    expect(valid).toMatchObject({ ok: true, mimeType: 'application/pdf' })
  })

  test('database backup includes payment proofs waivers attempts and certificate templates', () => {
    const tables = backupTableNames()
    expect(tables).toContain('PaymentProof')
    expect(tables).toContain('PaymentWaiverCode')
    expect(tables).toContain('PaymentWaiverAttempt')
    expect(tables).toContain('CertificateTemplate')
  })

  test('x-forwarded-for is trusted only for Vercel requests', () => {
    expect(clientIpFromHeaders(new Headers({ 'x-forwarded-for': '1.1.1.1', 'x-real-ip': '2.2.2.2' }))).toBe('2.2.2.2')
    expect(clientIpFromHeaders(new Headers({ 'x-forwarded-for': '1.1.1.1, 3.3.3.3', 'x-vercel-id': 'iad1::abc' }))).toBe('1.1.1.1')
  })
})
