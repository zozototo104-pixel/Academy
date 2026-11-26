// Comprehensive exam phase 2 — admin certificate-file upload.
// Real route code + real stamping; only the DB/auth/storage are faked
// (same pattern as the legacy-graduates upload tests).
import { beforeEach, describe, expect, mock, test } from 'bun:test'

type AnyRecord = Record<string, any>

const certificates = new Map<string, AnyRecord>()
const audits: AnyRecord[] = []
const storedFiles = new Map<string, { buffer: Buffer; mimeType: string }>()
let storageSeq = 0
let currentAdmin: AnyRecord | null = { id: 'admin-1', name: 'Admin', role: 'ADMIN' }

const fakeDb: any = {
  certificate: {
    findUnique: async ({ where }: AnyRecord) => {
      const row = certificates.get(where?.id)
      return row ? { ...row } : null
    },
    update: async ({ where, data }: AnyRecord) => {
      const row = certificates.get(where?.id)
      if (!row) throw new Error('NOT_FOUND')
      Object.assign(row, data)
      return { ...row }
    },
  },
  auditLog: {
    create: async ({ data }: AnyRecord) => {
      const row = { id: `audit-${audits.length + 1}`, ...data }
      audits.push(row)
      return row
    },
  },
}

mock.module('@/lib/db', () => ({ db: fakeDb }))
mock.module('@/lib/auth', () => ({
  requireAdmin: async () => {
    if (!currentAdmin) throw new Error('UNAUTHORIZED')
    return currentAdmin
  },
}))
mock.module('@/lib/storage', () => ({
  storeFileBuffer: async (input: { buffer: Buffer; fileName: string; mimeType?: string | null; namespace: string }) => {
    const key = `${input.namespace}/file-${++storageSeq}-${input.fileName}`
    storedFiles.set(key, { buffer: input.buffer, mimeType: input.mimeType || 'application/octet-stream' })
    return { provider: 'local', key, url: `/uploads/${key}`, size: input.buffer.byteLength, mimeType: input.mimeType || 'application/octet-stream' }
  },
  readStoredFile: async (input: { key?: string | null; mimeType?: string | null }) => {
    const stored = input.key ? storedFiles.get(input.key) : null
    return stored ? { buffer: stored.buffer, mimeType: stored.mimeType || input.mimeType || 'application/octet-stream' } : null
  },
  deleteStoredFile: async (key: string) => storedFiles.delete(String(key)),
}))

const uploadRoute = await import('../../src/app/api/admin/comprehensive-exams/[id]/certificates/[certificateId]/upload/route')

function reset() {
  certificates.clear()
  audits.splice(0)
  storedFiles.clear()
  storageSeq = 0
  currentAdmin = { id: 'admin-1', name: 'Admin', role: 'ADMIN' }
}

function seedExamCert(over: AnyRecord = {}) {
  const cert: AnyRecord = {
    id: 'cert-1',
    type: 'COMPREHENSIVE_EXAM',
    comprehensiveExamId: 'exam-1',
    legacy: false,
    serial: 'AACT-C-2026-00042',
    qrToken: 'qr-exam-1',
    holderName: 'أحمد محمد',
    holderNameEn: 'Ahmad Mohammad',
    program: 'برنامج الشهادات المهنية ونظام معادلة الخبرات المهنية',
    programEn: 'Professional Certificates',
    grade: '85%',
    gradeEn: null,
    legacySerial: null,
    issuedAt: new Date('2026-11-26T00:00:00Z'),
    valid: true,
    uploadedFileKey: null,
    uploadedFileName: null,
    uploadedMime: null,
    stampedFileKey: null,
    qrPosition: null,
    qrSize: null,
    ...over,
  }
  certificates.set(cert.id, cert)
  return cert
}

function jsonReq(url: string) {
  return { formData: async () => new FormData(), json: async () => ({}), nextUrl: new URL(url) } as any
}

function formReq(form: FormData, url: string) {
  return { formData: async () => form, json: async () => ({}), nextUrl: new URL(url) } as any
}

function ctx(examId = 'exam-1', certificateId = 'cert-1') {
  return { params: { id: examId, certificateId } } as any
}

async function minimalPdf() {
  const { PDFDocument } = await import('pdf-lib')
  const pdf = await PDFDocument.create()
  pdf.addPage([600, 800])
  return Buffer.from(await pdf.save())
}

beforeEach(reset)

describe('comprehensive-exam certificate upload guards', () => {
  test('non-COMPREHENSIVE_EXAM certificate is 404', async () => {
    certificates.set('cert-legacy', {
      id: 'cert-legacy', type: 'PROGRAM_COMPLETION', legacy: true, serial: 'AACT-C-2026-00001', qrToken: 'qr-1',
      holderName: 'Grad', program: 'دبلوم القيادة', valid: true, issuedAt: new Date(),
    })
    const fd = new FormData()
    fd.append('file', new File([await minimalPdf()], 'grad.pdf', { type: 'application/pdf' }))
    const res = await uploadRoute.POST(formReq(fd, 'https://aactacademy.test/api/admin/comprehensive-exams/exam-1/certificates/cert-legacy/upload'), ctx('exam-1', 'cert-legacy'))
    expect(res.status).toBe(404)
    expect((await uploadRoute.GET(jsonReq('https://aactacademy.test/api/admin/comprehensive-exams/exam-1/certificates/cert-legacy/upload'), ctx('exam-1', 'cert-legacy'))).status).toBe(404)
  })

  test('certificate of another exam is 404', async () => {
    seedExamCert({ comprehensiveExamId: 'exam-2' })
    const fd = new FormData()
    fd.append('file', new File([await minimalPdf()], 'grad.pdf', { type: 'application/pdf' }))
    const res = await uploadRoute.POST(formReq(fd, 'https://aactacademy.test/api/admin/comprehensive-exams/exam-1/certificates/cert-1/upload'), ctx('exam-1', 'cert-1'))
    expect(res.status).toBe(404)
  })

  test('missing certificate is 404', async () => {
    const fd = new FormData()
    fd.append('file', new File([await minimalPdf()], 'grad.pdf', { type: 'application/pdf' }))
    const res = await uploadRoute.POST(formReq(fd, 'https://aactacademy.test/api/admin/comprehensive-exams/exam-1/certificates/nope/upload'), ctx('exam-1', 'nope'))
    expect(res.status).toBe(404)
    expect((await uploadRoute.GET(jsonReq('https://aactacademy.test/api/admin/comprehensive-exams/exam-1/certificates/nope/upload'), ctx('exam-1', 'nope'))).status).toBe(404)
  })

  test('non-admin receives 403 on GET and POST', async () => {
    seedExamCert({ uploadedFileKey: 'certificates/legacy-originals/x.pdf', uploadedMime: 'application/pdf' })
    storedFiles.set('certificates/legacy-originals/x.pdf', { buffer: await minimalPdf(), mimeType: 'application/pdf' })
    currentAdmin = null
    expect((await uploadRoute.GET(jsonReq('https://aactacademy.test/api/admin/comprehensive-exams/exam-1/certificates/cert-1/upload'), ctx())).status).toBe(403)
    const fd = new FormData()
    fd.append('file', new File([await minimalPdf()], 'grad.pdf', { type: 'application/pdf' }))
    expect((await uploadRoute.POST(formReq(fd, 'https://aactacademy.test/api/admin/comprehensive-exams/exam-1/certificates/cert-1/upload'), ctx())).status).toBe(403)
    currentAdmin = { id: 'admin-1', name: 'Admin', role: 'ADMIN' }
  })
})

describe('comprehensive-exam certificate upload stamping', () => {
  test('PDF upload stores original and stamped files with the certificate serial and QR token', async () => {
    seedExamCert()
    const fd = new FormData()
    fd.append('file', new File([await minimalPdf()], 'grad.pdf', { type: 'application/pdf' }))
    fd.append('qrPosition', 'BOTTOM_LEFT')
    fd.append('qrSize', 'M')
    const res = await uploadRoute.POST(formReq(fd, 'https://aactacademy.test/api/admin/comprehensive-exams/exam-1/certificates/cert-1/upload'), ctx())
    expect(res.status).toBe(200)
    const body = (await res.json()) as AnyRecord
    expect(body.ok).toBe(true)
    expect(body.stampedFileKey).toBeTruthy()
    const cert = certificates.get('cert-1')!
    expect(cert.uploadedFileKey).toBeTruthy()
    expect(cert.uploadedFileName).toBe('grad.pdf')
    expect(cert.uploadedMime).toBe('application/pdf')
    expect(cert.stampedFileKey).toBeTruthy()
    expect(cert.qrSize).toBe('CUSTOM')
    expect(String(cert.qrPosition || '').startsWith('{')).toBe(true)
    const stamped = storedFiles.get(cert.stampedFileKey)
    expect(stamped).toBeTruthy()
    expect(stamped!.buffer.subarray(0, 5).toString()).toBe('%PDF-')
    // The stamped file is bigger than the blank original: QR + serial landed on it.
    expect(stamped!.buffer.byteLength).toBeGreaterThan(1000)
    expect(audits.length).toBe(1)
    expect(audits[0].action).toBe('UPLOAD_COMPREHENSIVE_EXAM_CERTIFICATE_FILE')
    expect(audits[0].entityId).toBe('cert-1')
    expect(audits[0].details).toContain('AACT-C-2026-00042')
  })

  test('non-PDF and non-image uploads are rejected', async () => {
    seedExamCert()
    const fd = new FormData()
    fd.append('file', new File([Buffer.from('not a certificate')], 'bad.txt', { type: 'text/plain' }))
    const res = await uploadRoute.POST(formReq(fd, 'https://aactacademy.test/api/admin/comprehensive-exams/exam-1/certificates/cert-1/upload'), ctx())
    expect(res.status).toBe(400)
    expect(certificates.get('cert-1')!.uploadedFileKey).toBeNull()
    expect(audits.length).toBe(0)
  })

  test('POST preview returns the stamped PDF without saving anything', async () => {
    seedExamCert()
    const fd = new FormData()
    fd.append('file', new File([await minimalPdf()], 'grad.pdf', { type: 'application/pdf' }))
    fd.append('qrPosition', 'TOP_RIGHT')
    fd.append('qrSize', 'L')
    const res = await uploadRoute.POST(formReq(fd, 'https://aactacademy.test/api/admin/comprehensive-exams/exam-1/certificates/cert-1/upload?preview=true'), ctx())
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/pdf')
    expect(Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-')
    const cert = certificates.get('cert-1')!
    expect(cert.uploadedFileKey).toBeNull()
    expect(cert.stampedFileKey).toBeNull()
    expect(audits.length).toBe(0)
    expect(storedFiles.size).toBe(0)
  })

  test('restamp without a new file reuses the stored original and audits RESTAMP', async () => {
    seedExamCert({ uploadedFileKey: 'certificates/legacy-originals/orig.pdf', uploadedFileName: 'orig.pdf', uploadedMime: 'application/pdf' })
    storedFiles.set('certificates/legacy-originals/orig.pdf', { buffer: await minimalPdf(), mimeType: 'application/pdf' })
    const fd = new FormData()
    fd.append('qrPosition', 'BOTTOM_RIGHT')
    fd.append('qrSize', 'S')
    const res = await uploadRoute.POST(formReq(fd, 'https://aactacademy.test/api/admin/comprehensive-exams/exam-1/certificates/cert-1/upload'), ctx())
    expect(res.status).toBe(200)
    const cert = certificates.get('cert-1')!
    expect(cert.uploadedFileKey).toBe('certificates/legacy-originals/orig.pdf')
    expect(cert.stampedFileKey).toBeTruthy()
    expect(audits.length).toBe(1)
    expect(audits[0].action).toBe('RESTAMP_COMPREHENSIVE_EXAM_CERTIFICATE_FILE')
  })

  test('upload without a file and without a stored original is 400', async () => {
    seedExamCert()
    const res = await uploadRoute.POST(formReq(new FormData(), 'https://aactacademy.test/api/admin/comprehensive-exams/exam-1/certificates/cert-1/upload'), ctx())
    expect(res.status).toBe(400)
  })
})

describe('comprehensive-exam certificate stamp preview GET', () => {
  test('GET stamps the stored original at a real URL and the layout changes the output', async () => {
    seedExamCert({ uploadedFileKey: 'certificates/legacy-originals/prev.pdf', uploadedMime: 'application/pdf', qrPosition: 'BOTTOM_LEFT', qrSize: 'M' })
    storedFiles.set('certificates/legacy-originals/prev.pdf', { buffer: await minimalPdf(), mimeType: 'application/pdf' })
    const urlFor = (x: number) => `https://aactacademy.test/api/admin/comprehensive-exams/exam-1/certificates/cert-1/upload?layout=${encodeURIComponent(JSON.stringify({ qr: { x, y: 90, size: 12, visible: true } }))}`
    const resA = await uploadRoute.GET(jsonReq(urlFor(10)), ctx())
    expect(resA.status).toBe(200)
    expect(resA.headers.get('Content-Type')).toBe('application/pdf')
    const bufA = Buffer.from(await resA.arrayBuffer())
    expect(bufA.subarray(0, 5).toString()).toBe('%PDF-')
    const resB = await uploadRoute.GET(jsonReq(urlFor(85)), ctx())
    expect(resB.status).toBe(200)
    const bufB = Buffer.from(await resB.arrayBuffer())
    expect(bufB.equals(bufA)).toBe(false)
    // Preview never saves: no audit rows, no stamped file stored.
    expect(audits.length).toBe(0)
    expect(storedFiles.size).toBe(1)
  })

  test('GET without a stored original is 404', async () => {
    seedExamCert()
    expect((await uploadRoute.GET(jsonReq('https://aactacademy.test/api/admin/comprehensive-exams/exam-1/certificates/cert-1/upload'), ctx())).status).toBe(404)
  })
})
