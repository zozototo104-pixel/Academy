import { NextRequest, NextResponse } from 'next/server'
import { promises as dns } from 'dns'
import net from 'net'
import { db } from '@/lib/db'
import { extractDocumentText } from '@/lib/document-extract'
import { storeFileBuffer, storageErrorMessage } from '@/lib/storage'
import { textAiCompleteJson } from '@/lib/text-ai'
import { serializeRepresentative } from '@/lib/academy-representatives'
import { emailAdminRepresentativeProfileSubmitted } from '@/lib/mailer'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

function originFrom(req: NextRequest) {
  return req.headers.get('origin') || `${req.nextUrl.protocol}//${req.nextUrl.host}`
}

function compact(value?: string | null, max = 5000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function text(value: unknown, max = 5000) {
  return String(value ?? '').trim().slice(0, max) || null
}

const IMAGE_MAX_BYTES = 5 * 1024 * 1024
const DOCUMENT_MAX_BYTES = 15 * 1024 * 1024

function isPrivateHostAddress(address: string) {
  const family = net.isIP(address)
  if (!family) return true
  if (family === 4) {
    const [a, b] = address.split('.').map((x) => Number(x))
    return a === 10 || a === 127 || a === 0 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51) || (a === 203 && b === 0)
  }
  const lower = address.toLowerCase().split('%')[0]
  const mapped = lower.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/)
  if (mapped) return isPrivateHostAddress(mapped[1])
  const hex = lower.replace(/:/g, '')
  return lower === '::1' || lower === '::' || lower.startsWith('fc') || lower.startsWith('fd') || /^fe[89ab]/.test(hex) || lower.startsWith('2001:db8:') || lower.startsWith('2001:') || lower.startsWith('ff')
}

async function validatePublicHttpsUrl(raw: string) {
  let parsed: URL
  try { parsed = new URL(raw) } catch { throw new Error('INVALID_URL') }
  if (parsed.protocol !== 'https:') throw new Error('URL_REQUIRES_HTTPS')
  const host = parsed.hostname.toLowerCase()
  const literal = net.isIP(host)
  const addresses = literal ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => [])
  if (!addresses.length || addresses.some((entry) => isPrivateHostAddress(entry.address))) throw new Error('URL_PRIVATE_HOST_REJECTED')
  return parsed.toString()
}

function validOfficeArchive(buffer: Buffer, extension: string) {
  // Validate the ZIP central directory and required OOXML members without extracting untrusted data.
  const end = buffer.length - 22
  let footer = -1
  for (let i = end; i >= Math.max(0, end - 65535); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50 && i + 22 + buffer.readUInt16LE(i + 20) === buffer.length) { footer = i; break }
  }
  if (footer < 0 || buffer.readUInt16LE(footer + 4) !== 0 || buffer.readUInt16LE(footer + 6) !== 0) return false
  const count = buffer.readUInt16LE(footer + 10)
  const directorySize = buffer.readUInt32LE(footer + 12)
  const directoryOffset = buffer.readUInt32LE(footer + 16)
  if (count < 2 || count > 2000 || directoryOffset + directorySize !== footer) return false
  const names = new Set<string>()
  let totalUncompressed = 0
  let cursor = directoryOffset
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > footer || buffer.readUInt32LE(cursor) !== 0x02014b50) return false
    const nameSize = buffer.readUInt16LE(cursor + 28)
    const extraSize = buffer.readUInt16LE(cursor + 30)
    const commentSize = buffer.readUInt16LE(cursor + 32)
    const next = cursor + 46 + nameSize + extraSize + commentSize
    if (next > footer) return false
    const compressed = buffer.readUInt32LE(cursor + 20)
    const uncompressed = buffer.readUInt32LE(cursor + 24)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const method = buffer.readUInt16LE(cursor + 10)
    if (![0, 8].includes(method) || compressed === 0xffffffff || uncompressed === 0xffffffff) return false
    totalUncompressed += uncompressed
    if (totalUncompressed > 100 * 1024 * 1024 || (compressed > 0 && uncompressed > compressed * 200)) return false
    if (localOffset + 30 > directoryOffset || buffer.readUInt32LE(localOffset) !== 0x04034b50) return false
    const localNameSize = buffer.readUInt16LE(localOffset + 26)
    const localExtraSize = buffer.readUInt16LE(localOffset + 28)
    if (localOffset + 30 + localNameSize + localExtraSize + compressed > directoryOffset) return false
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameSize).toString('utf8')
    if (!name || name.startsWith('/') || name.includes('..') || name.includes('\\') || buffer.subarray(localOffset + 30, localOffset + 30 + localNameSize).toString('utf8') !== name) return false
    names.add(name)
    cursor = next
  }
  const documentPart = extension === '.docx' ? 'word/document.xml' : extension === '.xlsx' ? 'xl/workbook.xml' : 'ppt/presentation.xml'
  return cursor === footer && names.has('[Content_Types].xml') && names.has('_rels/.rels') && names.has(documentPart)
}

function detectAllowedUpload(buffer: Buffer, fileName: string, declaredMime: string, assetType: string) {
  const lower = String(fileName || '').toLowerCase()
  const header = buffer.subarray(0, 16)
  const isPdf = header.subarray(0, 4).toString('ascii') === '%PDF'
  const isPng = header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  const isJpg = header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff
  const isZip = header.subarray(0, 2).toString('ascii') === 'PK'
  const image = assetType === 'profilePhoto'
  const maxBytes = image ? IMAGE_MAX_BYTES : DOCUMENT_MAX_BYTES
  if (buffer.byteLength > maxBytes) throw new Error('FILE_TOO_LARGE')
  if (image) {
    if (isPng) return { mimeType: 'image/png' }
    if (isJpg) return { mimeType: 'image/jpeg' }
    throw new Error('UNSUPPORTED_IMAGE_TYPE')
  }
  if (isPdf) return { mimeType: 'application/pdf' }
  if (isPng) return { mimeType: 'image/png' }
  if (isJpg) return { mimeType: 'image/jpeg' }
  if (isZip) {
    const extension = ['.docx', '.xlsx', '.pptx'].find((ext) => lower.endsWith(ext))
    if (extension && validOfficeArchive(buffer, extension)) {
      return { mimeType: extension === '.docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : extension === '.xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }
    }
  }
  throw new Error('UNSUPPORTED_FILE_TYPE')
}

function uploadErrorResponse(error: unknown) {
  const raw = String((error as any)?.message || error || '')
  if (raw === 'FILE_TOO_LARGE') return NextResponse.json({ error: 'FILE_TOO_LARGE' }, { status: 413 })
  if (raw.includes('URL_') || raw.includes('INVALID_URL')) return NextResponse.json({ error: raw }, { status: 400 })
  if (raw.includes('UNSUPPORTED_')) return NextResponse.json({ error: raw }, { status: 400 })
  return NextResponse.json({ error: 'UPLOAD_FAILED', message: storageErrorMessage(error) }, { status: 500 })
}

async function loadRepresentative(token: string) {
  return db.academyRepresentative.findFirst({
    where: { onboardingToken: token, deletedAt: null, status: { in: ['DRAFT', 'HIDDEN'] } },
    include: { files: { orderBy: [{ displayOrder: 'asc' }, { createdAt: 'desc' }] } },
  }).catch(() => null)
}

function parseJson(raw: string) {
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) throw new Error('NO_JSON')
  return JSON.parse(match[0])
}

async function rewriteRepresentativeProfile(rep: any) {
  const fileEvidence = Array.isArray(rep.files)
    ? rep.files
        .filter((f: any) => f.extractedText || f.description || f.externalUrl)
        .slice(0, 12)
        .map((f: any) => `ملف: ${f.title} [${f.kind}]\nوصف: ${compact(f.description, 700)}\nنص مستخرج: ${compact(f.extractedText, 2400)}\nرابط: ${f.externalUrl || f.fileUrl || ''}`)
        .join('\n\n---\n\n')
    : ''

  const system = `أنت محرر سيرة مهنية رسمي للأكاديمية الأمريكية للاستشارات والتدريب.
أعد صياغة ملف ممثل أكاديمي للعرض داخل منصة رسمية.
القواعد:
- لا تخترع شهادات أو ألقاباً أو مناصب غير موجودة في المدخلات.
- لا تغيّر نطاق التمثيل أو الدولة.
- اكتب بلغة عربية مهنية هادئة.
- أعد JSON فقط.`

  const prompt = `بيانات الممثل:
الاسم: ${rep.fullName}
الصفة: ${rep.displayTitle || ''}
الدرجة: ${rep.degreeTitle || ''}
الرتبة: ${rep.academicRank || ''}
الدولة: ${rep.country}
المنطقة: ${rep.region}
النطاق: ${rep.territory || ''}
التخصص: ${rep.specialization || ''}
السيرة الخام: ${compact(rep.rawBio, 9000)}
الأعمال: ${compact(rep.worksSummary, 5000)}
الإنجازات: ${compact(rep.achievements, 5000)}
الملفات:
${fileEvidence || 'لا توجد ملفات مقروءة.'}

أعد JSON بهذا الشكل:
{
  "shortBio": "ملخص عام في 35-55 كلمة",
  "professionalBio": "سيرة مهنية رسمية من 3 إلى 5 فقرات قصيرة",
  "worksSummary": "ملخص أعمال وخبرات منظم",
  "achievements": "إنجازات ومجالات تميز بصياغة حذرة",
  "publicContactNote": "جملة رسمية قصيرة للتواصل ونطاق التمثيل"
}`

  const raw = await textAiCompleteJson({ system, history: [{ role: 'user', text: prompt }], temperature: 0.25, maxOutputTokens: 2200 })
  return parseJson(raw)
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const rep = await loadRepresentative(token)
  if (!rep) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })
  const visible = serializeRepresentative(rep, originFrom(req), false)
  return NextResponse.json({ representative: { ...visible, files: rep.files.map((file) => ({ id: file.id, title: file.title, kind: file.kind, description: file.description, reviewStatus: file.reviewStatus || 'APPROVED', reviewNote: file.reviewNote, externalUrl: file.externalUrl, fileUrl: file.reviewStatus === 'APPROVED' ? visible.files.find((item) => item.id === file.id)?.fileUrl || null : null })), rawBio: rep.rawBio, onboardingStatus: rep.onboardingStatus, aiRewriteStatus: rep.aiRewriteStatus, aiRewriteNote: rep.aiRewriteNote } })
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const rep = await loadRepresentative(token)
  if (!rep) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })
  const body = await req.json().catch(() => ({}))
  const submit = body.submit === true
  let safeWebsite = rep.website
  if (body.website) {
    try { safeWebsite = await validatePublicHttpsUrl(String(body.website)) }
    catch (error) { return uploadErrorResponse(error) }
  }

  let updated = await db.academyRepresentative.update({
    where: { id: rep.id },
    data: {
      degreeTitle: text(body.degreeTitle, 220) ?? rep.degreeTitle,
      academicRank: text(body.academicRank, 160) ?? rep.academicRank,
      city: text(body.city, 120) ?? rep.city,
      specialization: text(body.specialization, 260) ?? rep.specialization,
      rawBio: text(body.rawBio, 12000) ?? rep.rawBio,
      worksSummary: text(body.worksSummary, 6000) ?? rep.worksSummary,
      achievements: text(body.achievements, 6000) ?? rep.achievements,
      website: safeWebsite,
      publicContactNote: text(body.publicContactNote, 1200) ?? rep.publicContactNote,
      onboardingStatus: submit ? 'SUBMITTED_REVIEW' : 'WAITING_PROFILE',
      onboardingSubmittedAt: submit ? new Date() : rep.onboardingSubmittedAt,
    },
    include: { files: { orderBy: [{ displayOrder: 'asc' }, { createdAt: 'desc' }] } },
  })

  if (submit) {
    try {
      const rewritten = await rewriteRepresentativeProfile(updated)
      updated = await db.academyRepresentative.update({
        where: { id: rep.id },
        data: {
          shortBio: compact(rewritten.shortBio, 900) || updated.shortBio,
          professionalBio: compact(rewritten.professionalBio, 12000) || updated.professionalBio,
          worksSummary: compact(rewritten.worksSummary, 6000) || updated.worksSummary,
          achievements: compact(rewritten.achievements, 6000) || updated.achievements,
          publicContactNote: compact(rewritten.publicContactNote, 1200) || updated.publicContactNote,
          aiRewriteStatus: 'UPDATED',
          aiRewriteNote: 'تمت إعادة صياغة ملف الممثل بعد رفع البيانات من رابط الاستكمال.',
        },
        include: { files: { orderBy: [{ displayOrder: 'asc' }, { createdAt: 'desc' }] } },
      })
    } catch (error: any) {
      updated = await db.academyRepresentative.update({
        where: { id: rep.id },
        data: { aiRewriteStatus: 'FAILED', aiRewriteNote: String(error?.message || error).slice(0, 500) },
        include: { files: { orderBy: [{ displayOrder: 'asc' }, { createdAt: 'desc' }] } },
      })
    }
  }

  await db.auditLog.create({
    data: { actorName: updated.fullName, action: submit ? 'REPRESENTATIVE_ONBOARDING_SUBMITTED' : 'REPRESENTATIVE_ONBOARDING_UPDATED', entity: 'AcademyRepresentative', entityId: updated.id, details: `${updated.fullName} — ${updated.country}` },
  }).catch(() => {})

  if (submit && rep.onboardingStatus !== 'SUBMITTED_REVIEW') {
    const admins = await db.user.findMany({ where: { role: 'ADMIN', status: 'ACTIVE' }, select: { email: true } }).catch(() => [])
    await Promise.all(admins.map((admin) => emailAdminRepresentativeProfileSubmitted(admin.email, {
      name: updated.fullName,
      country: updated.country,
      region: updated.region,
      email: updated.email,
    }).catch(() => false)))
  }

  return NextResponse.json({ representative: { ...serializeRepresentative(updated, originFrom(req), false), rawBio: updated.rawBio, onboardingStatus: updated.onboardingStatus, aiRewriteStatus: updated.aiRewriteStatus, aiRewriteNote: updated.aiRewriteNote } })
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const rep = await loadRepresentative(token)
  if (!rep) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })
  const form = await req.formData()
  const file = form.get('file')
  const externalUrl = text(form.get('externalUrl'), 800)
  const assetType = String(form.get('assetType') || 'file')
  const kind = String(form.get('kind') || 'OTHER').slice(0, 40)
  const title = text(form.get('title'), 220) || 'ملف ممثل الأكاديمية'
  const description = text(form.get('description'), 1200)

  if (externalUrl && assetType === 'file') {
    try {
      const safeExternalUrl = await validatePublicHttpsUrl(externalUrl)
      const created = await db.academyRepresentativeFile.create({ data: { representativeId: rep.id, kind: kind || 'LINK', title, description, externalUrl: safeExternalUrl, fileUrl: safeExternalUrl, storageProvider: 'external-url', storageKey: safeExternalUrl, reviewStatus: 'PENDING_REVIEW' } })
      return NextResponse.json({ file: created })
    } catch (error) {
      return uploadErrorResponse(error)
    }
  }

  if (!(file instanceof File)) return NextResponse.json({ error: 'NO_FILE' }, { status: 400 })
  if (file.size > (assetType === 'profilePhoto' ? IMAGE_MAX_BYTES : DOCUMENT_MAX_BYTES)) {
    return NextResponse.json({ error: 'FILE_TOO_LARGE' }, { status: 413 })
  }
  try {
    const buffer = Buffer.from(await file.arrayBuffer())
    const detected = detectAllowedUpload(buffer, file.name || 'file', file.type || 'application/octet-stream', assetType)
    const stored = await storeFileBuffer({ buffer, fileName: file.name || 'file', mimeType: detected.mimeType, namespace: `representatives/${rep.id}` })
    if (assetType === 'profilePhoto') {
      const updated = await db.academyRepresentative.update({
        where: { id: rep.id },
        data: { profilePhotoUrl: stored.url, profilePhotoName: file.name, profilePhotoMime: stored.mimeType, profilePhotoSize: stored.size, profilePhotoStorageProvider: stored.provider, profilePhotoStorageKey: stored.key, onboardingStatus: rep.onboardingStatus === 'SUBMITTED_REVIEW' ? 'SUBMITTED_REVIEW' : 'WAITING_PROFILE' },
      })
      return NextResponse.json({ representative: updated })
    }
    if (assetType === 'officialCard') {
      const updated = await db.academyRepresentative.update({
        where: { id: rep.id },
        data: { officialCardUrl: stored.url, officialCardName: file.name, officialCardMime: stored.mimeType, officialCardSize: stored.size, officialCardStorageProvider: stored.provider, officialCardStorageKey: stored.key, onboardingStatus: rep.onboardingStatus === 'SUBMITTED_REVIEW' ? 'SUBMITTED_REVIEW' : 'WAITING_PROFILE' },
      })
      return NextResponse.json({ representative: updated })
    }
    const extracted = await extractDocumentText(buffer, file.type || 'application/octet-stream', file.name || 'file', 50000).catch(() => null)
    const created = await db.academyRepresentativeFile.create({
      data: { representativeId: rep.id, kind, title, description, fileName: file.name, mimeType: stored.mimeType, size: stored.size, storageProvider: stored.provider, storageKey: stored.key, fileUrl: stored.url, extractedText: extracted?.readable ? extracted.text : null, reviewStatus: 'PENDING_REVIEW' },
    })
    return NextResponse.json({ file: created, extraction: extracted ? { readable: extracted.readable, reader: extracted.reader, note: extracted.note } : null })
  } catch (error) {
    return uploadErrorResponse(error)
  }
}
