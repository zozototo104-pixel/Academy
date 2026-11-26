// Regular-graduate certificate upload.
// Real route code + real stamping; only the DB/auth/storage are faked
// (same pattern as the legacy-graduates and comprehensive-exam upload tests).
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
    findFirst: async ({ where }: AnyRecord) => {
      const ors: AnyRecord[] = Array.isArray(where?.OR) ? where.OR : []
      for (const row of certificates.values()) {
        if (ors.some((cond) =>
          (cond.id && row.id === cond.id) ||
          (cond.serial && row.serial === cond.serial) ||
          (cond.qrToken && row.qrToken === cond.qrToken) ||
          (cond.legacySerial && row.legacySerial === cond.legacySerial),
        )) return { ...row }
      }
      return null
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
  getCurrentUser: async () => currentAdmin,
}))
mock.module('@/lib/storage', () => ({
  createSignedStorageUrlForKey: (key: string) => `https://storage.example.test/${key}?signed=1`,
  getFileStreamFromStorageOrBase64: async (input: { key?: string | null }) => {
    const found = input.key ? storedFiles.get(input.key) : null
    if (!found) return null
    return { size: found.buffer.length, mimeType: found.mimeType,
      stream: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(found.buffer)); controller.close() } }),
    }
  },
  storeFileBuffer: async (input: { buffer: Buffer; fileName: string; mimeType?: string | null; namespace: string }) => {
    const key = `${input.namespace}/file-${++storageSeq}-${input.fileName}`
    storedFiles.set(key, { buffer: input.buffer, mimeType: input.mimeType || 'application/octet-stream' })
    return { provider: 'local', key, url: `/uploads/${key}`, size: input.buffer.byteLength, mimeType: input.mimeType || 'application/octet-stream' }
  },
  storeFileBufferAtKey: async (input: { buffer: Buffer; key: string; mimeType?: string | null }) => {
    storedFiles.set(input.key, { buffer: input.buffer, mimeType: input.mimeType || 'application/octet-stream' })
    return { provider: 's3', key: input.key, url: '', size: input.buffer.byteLength, mimeType: input.mimeType }
  },
  readStoredFile: async (input: { key?: string | null; mimeType?: string | null }) => {
    const stored = input.key ? storedFiles.get(input.key) : null
    return stored ? { buffer: stored.buffer, mimeType: stored.mimeType || input.mimeType || 'application/octet-stream' } : null
  },
  deleteStoredFile: async (key: string) => storedFiles.delete(String(key)),
}))
mock.module('@/lib/pdf/official', () => ({
  pdfDate: (d: any) => String(d || ''),
  pdfResponse: (buffer: Buffer, filename: string) => new Response(new Uint8Array(buffer), {
    headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${filename}"` },
  }),
  pdfSafeText: (v: any, fallback = '') => String(v ?? fallback ?? ''),
  renderOfficialPdf: async () => Buffer.from('%PDF-official'),
}))
mock.module('@/lib/w3c/certificate-credential', () => ({
  certificateVerificationUrl: (input: any) => `https://verify.test/${input?.qrToken || 'x'}`,
  certificateCredentialUrl: () => 'https://cred.test/x',
}))

const uploadRoute = await import('../../src/app/api/admin/certificates/[certificateId]/upload/route')
const pdfRoute = await import('../../src/app/api/pdf/certificates/[id]/route')

function reset() {
  certificates.clear()
  audits.splice(0)
  storedFiles.clear()
  storageSeq = 0
  currentAdmin = { id: 'admin-1', name: 'Admin', role: 'ADMIN' }
}

function seedRegularCert(over: AnyRecord = {}) {
  const cert: AnyRecord = {
    id: 'cert-1',
    type: 'PROGRAM_COMPLETION',
    comprehensiveExamId: null,
    legacy: false,
    serial: 'AACT-C-2026-00042',
    qrToken: 'qr-reg-1',
    holderName: 'أحمد محمد',
    holderNameEn: 'Ahmad Mohammad',
    program: 'دبلوم إدارة الأعمال',
    programEn: 'Business Administration Diploma',
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

function ctx(certificateId = 'cert-1') {
  return { params: { certificateId } } as any
}

async function minimalPdf() {
  const { PDFDocument } = await import('pdf-lib')
  const pdf = await PDFDocument.create()
  pdf.addPage([600, 800])
  return Buffer.from(await pdf.save())
}

beforeEach(reset)

describe('regular certificate upload guards', () => {
  test('legacy certificate is 404', async () => {
    certificates.set('cert-legacy', {
      id: 'cert-legacy', type: 'PROGRAM_COMPLETION', legacy: true, serial: 'AACT-C-2026-00001', qrToken: 'qr-1',
      holderName: 'Grad', program: 'دبلوم القيادة', valid: true, issuedAt: new Date(),
    })
    const fd = new FormData()
    fd.append('file', new File([await minimalPdf()], 'grad.pdf', { type: 'application/pdf' }))
    const res = await uploadRoute.POST(formReq(fd, 'https://aactacademy.test/api/admin/certificates/cert-legacy/upload'), ctx('cert-legacy'))
    expect(res.status).toBe(404)
    expect((await uploadRoute.GET(jsonReq('https://aactacademy.test/api/admin/certificates/cert-legacy/upload'), ctx('cert-legacy'))).status).toBe(404)
  })

  test('missing certificate is 404', async () => {
    const fd = new FormData()
    fd.append('file', new File([await minimalPdf()], 'grad.pdf', { type: 'application/pdf' }))
    const res = await uploadRoute.POST(formReq(fd, 'https://aactacademy.test/api/admin/certificates/nope/upload'), ctx('nope'))
    expect(res.status).toBe(404)
    expect((await uploadRoute.GET(jsonReq('https://aactacademy.test/api/admin/certificates/nope/upload'), ctx('nope'))).status).toBe(404)
  })

  test('non-admin receives 403 on GET and POST', async () => {
    seedRegularCert({ uploadedFileKey: 'certificates/legacy-originals/x.pdf', uploadedMime: 'application/pdf' })
    storedFiles.set('certificates/legacy-originals/x.pdf', { buffer: await minimalPdf(), mimeType: 'application/pdf' })
    currentAdmin = null
    expect((await uploadRoute.GET(jsonReq('https://aactacademy.test/api/admin/certificates/cert-1/upload'), ctx())).status).toBe(403)
    const fd = new FormData()
    fd.append('file', new File([await minimalPdf()], 'grad.pdf', { type: 'application/pdf' }))
    expect((await uploadRoute.POST(formReq(fd, 'https://aactacademy.test/api/admin/certificates/cert-1/upload'), ctx())).status).toBe(403)
    currentAdmin = { id: 'admin-1', name: 'Admin', role: 'ADMIN' }
  })

  test('comprehensive-exam certificate is accepted here (guard is legacy-only)', async () => {
    seedRegularCert({ type: 'COMPREHENSIVE_EXAM', comprehensiveExamId: 'exam-1' })
    const fd = new FormData()
    fd.append('file', new File([await minimalPdf()], 'grad.pdf', { type: 'application/pdf' }))
    const res = await uploadRoute.POST(formReq(fd, 'https://aactacademy.test/api/admin/certificates/cert-1/upload'), ctx())
    expect(res.status).toBe(200)
    expect(audits[0].action).toBe('UPLOAD_REGULAR_CERTIFICATE_FILE')
  })
})

describe('regular certificate upload stamping', () => {
  test('PDF upload stores original and stamped files with the certificate serial and QR token', async () => {
    seedRegularCert()
    const fd = new FormData()
    fd.append('file', new File([await minimalPdf()], 'grad.pdf', { type: 'application/pdf' }))
    fd.append('qrPosition', 'BOTTOM_LEFT')
    fd.append('qrSize', 'M')
    const res = await uploadRoute.POST(formReq(fd, 'https://aactacademy.test/api/admin/certificates/cert-1/upload'), ctx())
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
    expect(audits[0].action).toBe('UPLOAD_REGULAR_CERTIFICATE_FILE')
    expect(audits[0].entityId).toBe('cert-1')
    expect(audits[0].details).toContain('AACT-C-2026-00042')
  })

  test('non-PDF and non-image uploads are rejected', async () => {
    seedRegularCert()
    const fd = new FormData()
    fd.append('file', new File([Buffer.from('not a certificate')], 'bad.txt', { type: 'text/plain' }))
    const res = await uploadRoute.POST(formReq(fd, 'https://aactacademy.test/api/admin/certificates/cert-1/upload'), ctx())
    expect(res.status).toBe(400)
    expect(certificates.get('cert-1')!.uploadedFileKey).toBeNull()
    expect(audits.length).toBe(0)
  })

  test('empty file is rejected', async () => {
    seedRegularCert()
    const fd = new FormData()
    fd.append('file', new File([], 'empty.pdf', { type: 'application/pdf' }))
    const res = await uploadRoute.POST(formReq(fd, 'https://aactacademy.test/api/admin/certificates/cert-1/upload'), ctx())
    expect(res.status).toBe(400)
    expect(audits.length).toBe(0)
  })

  test('oversized file is rejected with 413', async () => {
    seedRegularCert()
    const fd = new FormData()
    fd.append('file', new File([Buffer.alloc(10 * 1024 * 1024 + 1)], 'big.pdf', { type: 'application/pdf' }))
    const res = await uploadRoute.POST(formReq(fd, 'https://aactacademy.test/api/admin/certificates/cert-1/upload'), ctx())
    expect(res.status).toBe(413)
    expect(certificates.get('cert-1')!.uploadedFileKey).toBeNull()
    expect(audits.length).toBe(0)
  })

  test('POST preview returns the stamped PDF without saving anything', async () => {
    seedRegularCert()
    const fd = new FormData()
    fd.append('file', new File([await minimalPdf()], 'grad.pdf', { type: 'application/pdf' }))
    fd.append('qrPosition', 'TOP_RIGHT')
    fd.append('qrSize', 'L')
    const res = await uploadRoute.POST(formReq(fd, 'https://aactacademy.test/api/admin/certificates/cert-1/upload?preview=true'), ctx())
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
    seedRegularCert({ uploadedFileKey: 'certificates/legacy-originals/orig.pdf', uploadedFileName: 'orig.pdf', uploadedMime: 'application/pdf' })
    storedFiles.set('certificates/legacy-originals/orig.pdf', { buffer: await minimalPdf(), mimeType: 'application/pdf' })
    const fd = new FormData()
    fd.append('qrPosition', 'BOTTOM_RIGHT')
    fd.append('qrSize', 'S')
    const res = await uploadRoute.POST(formReq(fd, 'https://aactacademy.test/api/admin/certificates/cert-1/upload'), ctx())
    expect(res.status).toBe(200)
    const cert = certificates.get('cert-1')!
    expect(cert.uploadedFileKey).toBe('certificates/legacy-originals/orig.pdf')
    expect(cert.stampedFileKey).toBeTruthy()
    expect(audits.length).toBe(1)
    expect(audits[0].action).toBe('RESTAMP_REGULAR_CERTIFICATE_FILE')
  })

  test('upload without a file and without a stored original is 400', async () => {
    seedRegularCert()
    const res = await uploadRoute.POST(formReq(new FormData(), 'https://aactacademy.test/api/admin/certificates/cert-1/upload'), ctx())
    expect(res.status).toBe(400)
  })
})

describe('regular certificate stamp preview GET', () => {
  test('GET stamps the stored original at a real URL and the layout changes the output', async () => {
    seedRegularCert({ uploadedFileKey: 'certificates/legacy-originals/prev.pdf', uploadedMime: 'application/pdf', qrPosition: 'BOTTOM_LEFT', qrSize: 'M' })
    storedFiles.set('certificates/legacy-originals/prev.pdf', { buffer: await minimalPdf(), mimeType: 'application/pdf' })
    const urlFor = (x: number) => `https://aactacademy.test/api/admin/certificates/cert-1/upload?layout=${encodeURIComponent(JSON.stringify({ qr: { x, y: 90, size: 12, visible: true } }))}`
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
    seedRegularCert()
    expect((await uploadRoute.GET(jsonReq('https://aactacademy.test/api/admin/certificates/cert-1/upload'), ctx())).status).toBe(404)
  })
})

describe('PDF route serves the stamped file for regular certificates', () => {
  test('stamped file is preferred when present', async () => {
    const stampedPdf = await minimalPdf()
    seedRegularCert({ stampedFileKey: 'certificates/legacy-stamped/stamped.pdf' })
    storedFiles.set('certificates/legacy-stamped/stamped.pdf', { buffer: stampedPdf, mimeType: 'application/pdf' })
    const res = await pdfRoute.GET({} as any, { params: { id: 'cert-1' } } as any)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/pdf')
    const body = Buffer.from(await res.arrayBuffer())
    expect(body.equals(stampedPdf)).toBe(true)
  })

  test('without a stamped file it falls back to the official PDF', async () => {
    seedRegularCert()
    const res = await pdfRoute.GET({} as any, { params: { id: 'cert-1' } } as any)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/pdf')
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('%PDF-official')
  })

  test('unknown certificate is 404', async () => {
    const res = await pdfRoute.GET({} as any, { params: { id: 'nope' } } as any)
    expect(res.status).toBe(404)
  })
})
