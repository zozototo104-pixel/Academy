import { NextRequest, NextResponse } from 'next/server'
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
  return NextResponse.json({ representative: { ...serializeRepresentative(rep, originFrom(req), false), rawBio: rep.rawBio, onboardingStatus: rep.onboardingStatus, aiRewriteStatus: rep.aiRewriteStatus, aiRewriteNote: rep.aiRewriteNote } })
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const rep = await loadRepresentative(token)
  if (!rep) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })
  const body = await req.json().catch(() => ({}))
  const submit = body.submit === true

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
      website: text(body.website, 400) ?? rep.website,
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
    const created = await db.academyRepresentativeFile.create({ data: { representativeId: rep.id, kind: kind || 'LINK', title, description, externalUrl, fileUrl: externalUrl, storageProvider: 'external-url', storageKey: externalUrl } })
    return NextResponse.json({ file: created })
  }

  if (!(file instanceof File)) return NextResponse.json({ error: 'NO_FILE' }, { status: 400 })
  const buffer = Buffer.from(await file.arrayBuffer())
  try {
    const stored = await storeFileBuffer({ buffer, fileName: file.name || 'file', mimeType: file.type || 'application/octet-stream', namespace: `representatives/${rep.id}` })
    if (assetType === 'profilePhoto') {
      const updated = await db.academyRepresentative.update({
        where: { id: rep.id },
        data: { profilePhotoUrl: stored.url, profilePhotoName: file.name, profilePhotoMime: stored.mimeType, profilePhotoSize: stored.size, profilePhotoStorageProvider: stored.provider, profilePhotoStorageKey: stored.key, onboardingStatus: 'WAITING_PROFILE' },
      })
      return NextResponse.json({ representative: updated })
    }
    if (assetType === 'officialCard') {
      const updated = await db.academyRepresentative.update({
        where: { id: rep.id },
        data: { officialCardUrl: stored.url, officialCardName: file.name, officialCardMime: stored.mimeType, officialCardSize: stored.size, officialCardStorageProvider: stored.provider, officialCardStorageKey: stored.key, onboardingStatus: 'WAITING_PROFILE' },
      })
      return NextResponse.json({ representative: updated })
    }
    const extracted = await extractDocumentText(buffer, file.type || 'application/octet-stream', file.name || 'file', 50000).catch(() => null)
    const created = await db.academyRepresentativeFile.create({
      data: { representativeId: rep.id, kind, title, description, fileName: file.name, mimeType: stored.mimeType, size: stored.size, storageProvider: stored.provider, storageKey: stored.key, fileUrl: stored.url, extractedText: extracted?.readable ? extracted.text : null },
    })
    return NextResponse.json({ file: created, extraction: extracted ? { readable: extracted.readable, reader: extracted.reader, note: extracted.note } : null })
  } catch (error) {
    return NextResponse.json({ error: 'UPLOAD_FAILED', message: storageErrorMessage(error) }, { status: 500 })
  }
}
