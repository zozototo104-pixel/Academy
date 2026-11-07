/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test'
import {
  buildCertificateCredential,
  resolveCertificateAccessMode,
  verifyCertificateCredential,
} from '../../src/lib/w3c/certificate-credential'

// Guard: وضع الإفصاح المنقّح في مكوّن اعتماد W3C نفسه.
// البحث بالرقم التسلسلي لا يزرع qrToken في أي حقل من الاعتماد (لا في
// verificationToken ولا في الروابط ولا في المعرفات)، ويحجب التقدير،
// ويظل إثبات HMAC صالحًا على الحمولة المنقحة.

const CERT: any = {
  id: 'cert-lib-1',
  serial: 'AACT-C-2026-00042',
  qrToken: '0123456789abcdef0123456789abcdef',
  type: 'DIPLOMA',
  holderName: 'طالب اختبار المكتبة',
  program: 'دبلوم اختبار المكتبة',
  grade: 'امتياز',
  country: 'فلسطين',
  issuedAt: new Date('2026-01-15T00:00:00Z'),
  valid: true,
  userId: 'user-lib-1',
  enrollmentId: null,
  admissionId: null,
  agentId: null,
}

describe('resolveCertificateAccessMode', () => {
  test('the qrToken itself is TOKEN mode; serial and legacy serial are SERIAL mode', () => {
    expect(resolveCertificateAccessMode(CERT, CERT.qrToken)).toBe('TOKEN')
    expect(resolveCertificateAccessMode(CERT, CERT.serial)).toBe('SERIAL')
    expect(resolveCertificateAccessMode(CERT, 'LEG-0042')).toBe('SERIAL')
    expect(resolveCertificateAccessMode(CERT, '')).toBe('SERIAL')
  })
})

describe('buildCertificateCredential disclosure modes', () => {
  test('default (token) mode keeps verificationToken, grade and token-based URLs', () => {
    const credential = buildCertificateCredential(CERT)
    expect(credential.evidence[0].verificationToken).toBe(CERT.qrToken)
    expect(credential.credentialSubject.grade).toBe(CERT.grade)
    expect(credential.id.includes(CERT.qrToken)).toBe(true)
    expect(verifyCertificateCredential(credential)).toBe(true)
  })

  test('SERIAL mode embeds the qrToken nowhere and withholds the grade', () => {
    const credential = buildCertificateCredential(CERT, { accessMode: 'SERIAL' })
    const serialized = JSON.stringify(credential)
    expect(serialized.includes(CERT.qrToken)).toBe(false)
    expect(credential.evidence[0].verificationToken).toBeUndefined()
    expect(credential.credentialSubject.grade).toBeNull()
    expect(credential.credentialSubject.certificateSerial).toBe(CERT.serial)
    expect(credential.id.includes(CERT.serial)).toBe(true)
    // الإثبات يُحسب على الحمولة المنقحة نفسها فيظل قابلًا للتحقق.
    expect(verifyCertificateCredential(credential)).toBe(true)
  })
})
