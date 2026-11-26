// Regular-graduate certificate upload.
// Real route code + real stamping; only the DB/auth/storage are faked
// (same pattern as the legacy-graduates and comprehensive-exam upload tests).
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'

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
    userId: 'user-1',
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

function jsonActionReq(body: AnyRecord, url = 'https://aactacademy.test/api/admin/certificates/cert-1/upload') {
  return { headers: new Headers({ 'Content-Type': 'application/json' }), json: async () => body, nextUrl: new URL(url), url } as any
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

async function presignRegularFile(size: number, mimeType = 'application/pdf') {
  const names = ['AACT_S3_ENDPOINT', 'AACT_S3_BUCKET', 'AACT_S3_ACCESS_KEY_ID', 'AACT_S3_SECRET_ACCESS_KEY'] as const
  const previous = names.map((name) => process.env[name])
  Object.assign(process.env, {
    AACT_S3_ENDPOINT: 'https://r2.example.test', AACT_S3_BUCKET: 'test-bucket',
    AACT_S3_ACCESS_KEY_ID: 'test-key', AACT_S3_SECRET_ACCESS_KEY: 'test-secret',
  })
  try {
    const response = await uploadRoute.POST(jsonActionReq({ action: 'PRESIGN', size, mimeType }), ctx())
    return { response, payload: (await response.json()) as AnyRecord }
  } finally {
    names.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name]
      else process.env[name] = previous[index]
    })
  }
}

beforeEach(reset)

describe('regular certificate upload guards', () => {
  test('admin upload UI excludes comprehensive exam certificates, matching the API guard', () => {
    const adminUI = readFileSync('src/components/aact/AdminExtras.tsx', 'utf8')
    expect(adminUI).toContain("!c.legacy && !c.comprehensiveExamId && c.type === 'PROGRAM_COMPLETION'")
  })

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

  test('comprehensive, agency and accreditation certificates cannot use the regular-graduate route', async () => {
    for (const type of ['COMPREHENSIVE_EXAM', 'AGENCY', 'ACCREDITATION']) {
      seedRegularCert({ type, comprehensiveExamId: type === 'COMPREHENSIVE_EXAM' ? 'exam-1' : null })
      const fd = new FormData()
      fd.append('file', new File([await minimalPdf()], 'grad.pdf', { type: 'application/pdf' }))
      expect((await uploadRoute.POST(formReq(fd, 'https://aactacademy.test/api/admin/certificates/cert-1/upload'), ctx())).status).toBe(404)
      expect((await uploadRoute.GET(jsonReq('https://aactacademy.test/api/admin/certificates/cert-1/upload'), ctx())).status).toBe(404)
    }
    expect(audits).toHaveLength(0)
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

describe('regular certificate direct-to-storage flow', () => {
  test('presign accepts a 5MB file without sending it through a function body', async () => {
    seedRegularCert()
    const { response, payload } = await presignRegularFile(5 * 1024 * 1024)
    expect(response.status).toBe(200)
    expect(payload.uploadUrl).toContain('X-Amz-Signature=')
    expect(payload.key).toStartWith('certificates/regular-pending/cert-1/')
    expect(payload.maxBytes).toBe(10 * 1024 * 1024)
    expect(certificates.get('cert-1')!.uploadedFileKey).toBeNull()
    expect((await presignRegularFile(10 * 1024 * 1024 + 1)).response.status).toBe(413)
  })

  test('a PDF over 5 MiB is previewed, stamped and saved through the direct upload flow', async () => {
    seedRegularCert()
    const { PDFDocument } = await import('pdf-lib')
    const { randomBytes } = await import('node:crypto')
    const pdf = await PDFDocument.create()
    pdf.addPage([600, 800])
    await pdf.attach(randomBytes(5 * 1024 * 1024), 'supporting-file.bin')
    const original = Buffer.from(await pdf.save())
    expect(original.length).toBeGreaterThan(5 * 1024 * 1024)
    const { payload } = await presignRegularFile(original.length)
    storedFiles.set(payload.key, { buffer: original, mimeType: 'application/pdf' })
    const preview = await uploadRoute.POST(jsonActionReq({ action: 'PREVIEW', key: payload.key, size: original.length, fileName: 'certificate.pdf' }), ctx())
    expect(preview.status).toBe(200)
    expect((await preview.json() as AnyRecord).previewUrl).toContain('signed=1')
    expect(storedFiles.has('certificates/regular-previews/cert-1/admin-1.pdf')).toBe(true)
    expect(certificates.get('cert-1')!.stampedFileKey).toBeNull()

    const saved = await uploadRoute.POST(jsonActionReq({ action: 'SAVE', key: payload.key, size: original.length, fileName: 'certificate.pdf' }), ctx())
    expect(saved.status).toBe(200)
    const cert = certificates.get('cert-1')!
    expect(cert.uploadedFileKey).toStartWith('certificates/regular-originals/')
    expect(cert.stampedFileKey).toStartWith('certificates/regular-stamped/')
    const { isPrivateStorageKey } = await import('../../src/lib/prod-safety')
    for (const key of [payload.key, cert.uploadedFileKey, cert.stampedFileKey, 'certificates/regular-previews/cert-1/admin-1.pdf']) {
      expect(isPrivateStorageKey(key)).toBe(true)
    }
    expect(storedFiles.get(cert.uploadedFileKey)!.buffer.equals(original)).toBe(true)
    const stamped = storedFiles.get(cert.stampedFileKey)!.buffer
    expect(stamped.length).toBeGreaterThan(5 * 1024 * 1024)
    expect((await PDFDocument.load(stamped)).getPageCount()).toBe(1)
    expect(storedFiles.has(payload.key)).toBe(false)
    expect(storedFiles.has('certificates/regular-previews/cert-1/admin-1.pdf')).toBe(false)
    expect(audits).toHaveLength(1)
  })

  test('cannot finalize another certificate key, an absent upload, or a mismatched file size', async () => {
    seedRegularCert()
    const { payload } = await presignRegularFile(100)
    expect((await uploadRoute.POST(jsonActionReq({ action: 'SAVE', key: payload.key.replace('/cert-1/', '/cert-2/'), size: 100 }), ctx())).status).toBe(400)
    expect((await uploadRoute.POST(jsonActionReq({ action: 'SAVE', key: payload.key, size: 100 }), ctx())).status).toBe(404)
    storedFiles.set(payload.key, { buffer: await minimalPdf(), mimeType: 'application/pdf' })
    expect((await uploadRoute.POST(jsonActionReq({ action: 'SAVE', key: payload.key, size: 100 }), ctx())).status).toBe(400)
    storedFiles.set(payload.key, { buffer: Buffer.alloc(10 * 1024 * 1024 + 1), mimeType: 'application/pdf' })
    expect((await uploadRoute.POST(jsonActionReq({ action: 'SAVE', key: payload.key, size: 100 }), ctx())).status).toBe(413)
    expect(audits).toHaveLength(0)
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
  test('private certificate IDs are inaccessible to anonymous visitors, but QR token access stays public', async () => {
    seedRegularCert({ stampedFileKey: 'certificates/regular-stamped/private.pdf' })
    storedFiles.set('certificates/regular-stamped/private.pdf', { buffer: await minimalPdf(), mimeType: 'application/pdf' })
    currentAdmin = null
    const byId = await pdfRoute.GET({} as any, { params: { id: 'cert-1' } } as any)
    expect(byId.status).toBe(403)
    const bySerial = await pdfRoute.GET({} as any, { params: { id: 'AACT-C-2026-00042' } } as any)
    expect(bySerial.status).toBe(403)
    const byQr = await pdfRoute.GET({} as any, { params: { id: 'qr-reg-1' } } as any)
    expect(byQr.status).toBe(200)
  })

  test('an unrelated logged-in user cannot fetch a stamped certificate by ID', async () => {
    seedRegularCert({ stampedFileKey: 'certificates/regular-stamped/private.pdf' })
    storedFiles.set('certificates/regular-stamped/private.pdf', { buffer: await minimalPdf(), mimeType: 'application/pdf' })
    currentAdmin = { id: 'other-user', name: 'Other', role: 'STUDENT', email: 'other@example.test' }
    const res = await pdfRoute.GET({} as any, { params: { id: 'cert-1' } } as any)
    expect(res.status).toBe(403)
  })

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

  test('large stamped certificates download through a short-lived signed redirect', async () => {
    seedRegularCert({ stampedFileKey: 'certificates/regular-stamped/big.pdf' })
    storedFiles.set('certificates/regular-stamped/big.pdf', { buffer: Buffer.alloc(5 * 1024 * 1024, 17), mimeType: 'application/pdf' })
    const res = await pdfRoute.GET({ url: 'https://aactacademy.test/api/pdf/certificates/cert-1' } as any, { params: { id: 'cert-1' } } as any)
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toContain('https://storage.example.test/certificates/regular-stamped/big.pdf?signed=1')
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })
})

describe('regular certificate drag-editor stamp layout', () => {
  // The coordinates the admin drags to in the shared stamp editor.
  const draggedLayout = {
    qr: { x: 72, y: 30, size: 22, visible: true },
    serial: { x: 72, y: 44, width: 34, fontSize: 1.6, visible: true },
  }

  test('FormData save with a dragged stampLayout stores the dragged coordinates', async () => {
    seedRegularCert()
    const fd = new FormData()
    fd.append('file', new File([await minimalPdf()], 'grad.pdf', { type: 'application/pdf' }))
    fd.append('stampLayout', JSON.stringify(draggedLayout))
    const res = await uploadRoute.POST(formReq(fd, 'https://aactacademy.test/api/admin/certificates/cert-1/upload'), ctx())
    expect(res.status).toBe(200)
    const cert = certificates.get('cert-1')!
    expect(cert.qrSize).toBe('CUSTOM')
    const saved = JSON.parse(String(cert.qrPosition))
    expect(saved.qr.x).toBe(72)
    expect(saved.qr.y).toBe(30)
    expect(saved.qr.size).toBe(22)
    expect(saved.serial.x).toBe(72)
    expect(saved.serial.y).toBe(44)
    expect(audits[0].action).toBe('UPLOAD_REGULAR_CERTIFICATE_FILE')
  })

  test('JSON SAVE with a dragged stampLayout stores the dragged coordinates', async () => {
    seedRegularCert()
    const pdf = await minimalPdf()
    const { payload } = await presignRegularFile(pdf.length)
    storedFiles.set(payload.key, { buffer: pdf, mimeType: 'application/pdf' })
    const saved = await uploadRoute.POST(jsonActionReq({ action: 'SAVE', key: payload.key, size: pdf.length, fileName: 'certificate.pdf', stampLayout: JSON.stringify(draggedLayout) }), ctx())
    expect(saved.status).toBe(200)
    const cert = certificates.get('cert-1')!
    expect(cert.qrSize).toBe('CUSTOM')
    const layout = JSON.parse(String(cert.qrPosition))
    expect(layout.qr.x).toBe(72)
    expect(layout.qr.y).toBe(30)
    expect(layout.qr.size).toBe(22)
    expect(layout.serial.x).toBe(72)
    expect(layout.serial.y).toBe(44)
  })

  test('GET preview without a layout param uses the saved dragged layout', async () => {
    seedRegularCert({ uploadedFileKey: 'certificates/legacy-originals/prev.pdf', uploadedMime: 'application/pdf', qrPosition: JSON.stringify(draggedLayout), qrSize: 'CUSTOM' })
    storedFiles.set('certificates/legacy-originals/prev.pdf', { buffer: await minimalPdf(), mimeType: 'application/pdf' })
    const savedDefault = await uploadRoute.GET(jsonReq('https://aactacademy.test/api/admin/certificates/cert-1/upload'), ctx())
    expect(savedDefault.status).toBe(200)
    const bufDefault = Buffer.from(await savedDefault.arrayBuffer())
    expect(bufDefault.subarray(0, 5).toString()).toBe('%PDF-')
    const moved = await uploadRoute.GET(jsonReq(`https://aactacademy.test/api/admin/certificates/cert-1/upload?layout=${encodeURIComponent(JSON.stringify({ qr: { x: 10, y: 90, size: 12, visible: true } }))}`), ctx())
    expect(moved.status).toBe(200)
    const bufMoved = Buffer.from(await moved.arrayBuffer())
    expect(bufMoved.equals(bufDefault)).toBe(false)
    expect(audits.length).toBe(0)
  })

  test('the upload UI is the shared drag editor (QR + serial only), not the 4-corner dropdown', () => {
    const adminUI = readFileSync('src/components/aact/AdminExtras.tsx', 'utf8')
    expect(adminUI).toContain('CertificateStampEditor')
    expect(adminUI).toContain("fields={['qr', 'serial']}")
    expect(adminUI).toContain("fd.append('stampLayout'")
    expect(adminUI).toContain('stampLayout: regularCertStampLayoutJson')
    expect(adminUI).not.toContain('BOTTOM_LEFT')
    expect(adminUI).not.toContain('BOTTOM_RIGHT')
    expect(adminUI).not.toContain('TOP_LEFT')
    expect(adminUI).not.toContain('TOP_RIGHT')
  })
})
