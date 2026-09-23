import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'
import { storageErrorMessage, storeFileBuffer } from '@/lib/storage'
import { verifyAdmissionUploadToken } from '@/lib/admission-upload-token'

const MAX_FILE_SIZE = 4 * 1024 * 1024 // 4MB لكل ملف — نرفع كل ملف بطلب مستقل لتجنب 413.
const ALLOWED_MIME = [
  'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'text/plain', 'text/csv', 'application/csv',
]
const ALLOWED_FILE_RE = /\.(jpe?g|png|webp|heic|heif|pdf|docx|xlsx|xls|txt|csv)$/i

function normalizeDocType(key: string) {
  return key.replace(/^doc_/, '').toUpperCase().slice(0, 40)
}

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData()
    const applicationId = String(form.get('applicationId') || '').trim()
    const reference = String(form.get('reference') || '').trim()
    const uploadToken = String(form.get('uploadToken') || '').trim()
    const docTypeRaw = String(form.get('docType') || '').trim()
    const file = form.get('file') as File | null

    if (!applicationId && !reference) {
      return NextResponse.json({ error: 'معرّف الطلب أو كود التتبع مطلوب قبل رفع المستند' }, { status: 400 })
    }
    if (!file || typeof file !== 'object' || !('arrayBuffer' in file) || !file.size) {
      return NextResponse.json({ error: 'لم يتم اختيار ملف للرفع' }, { status: 400 })
    }

    const app = await db.admissionApplication.findFirst({
      where: applicationId ? { id: applicationId } : { reference },
      select: { id: true, reference: true, email: true, userId: true, status: true },
    })
    if (!app) return NextResponse.json({ error: 'لم يتم العثور على طلب الالتحاق' }, { status: 404 })

    const me = await getCurrentUser().catch(() => null)
    const sessionAllowed = Boolean(
      me && (
        me.role === 'ADMIN' ||
        me.role === 'STAFF' ||
        (me.role === 'STUDENT' && app.userId && app.userId === me.id)
      )
    )
    const tokenAllowed = verifyAdmissionUploadToken(uploadToken, app)
    if (!sessionAllowed && !tokenAllowed) {
      return NextResponse.json({ error: 'رابط رفع المستندات غير صالح أو انتهت صلاحيته. أعد فتح نموذج التقديم وأرسل الطلب من جديد.' }, { status: 403 })
    }

    if (!['UPLOADING_DOCUMENTS', 'PENDING', 'AWAITING_FEE', 'UNDER_REVIEW'].includes(app.status)) {
      return NextResponse.json({ error: 'لا يمكن تعديل مستندات هذا الطلب بعد انتقاله لمرحلة لاحقة' }, { status: 400 })
    }

    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json({ error: `حجم ملف «${file.name}» يتجاوز الحد الأقصى 4 ميجابايت — ارفع كل ملف منفصلاً أو اضغط الملف` }, { status: 400 })
    }
    const mime = file.type || 'application/octet-stream'
    if (!ALLOWED_MIME.includes(mime) && !ALLOWED_FILE_RE.test(file.name)) {
      return NextResponse.json({ error: `صيغة ملف «${file.name}» غير مدعومة — المسموح: صور أو PDF أو Word أو Excel أو TXT/CSV` }, { status: 400 })
    }

    const docType = normalizeDocType(docTypeRaw || file.name)
    const buf = Buffer.from(await file.arrayBuffer())
    let stored
    try {
      stored = await storeFileBuffer({
        buffer: buf,
        fileName: file.name,
        mimeType: mime,
        namespace: `admissions/${app.reference.toLowerCase()}/${docType.toLowerCase()}`,
      })
    } catch (error) {
      return NextResponse.json({ error: storageErrorMessage(error) }, { status: 500 })
    }

    await db.admissionDocument.deleteMany({ where: { admissionId: app.id, docType } })
    const saved = await db.admissionDocument.create({
      data: {
        admissionId: app.id,
        docType,
        fileName: file.name.slice(0, 180),
        mimeType: stored.mimeType || mime,
        size: stored.size || file.size,
        data: null,
        storageProvider: stored.provider,
        storageKey: stored.key,
        fileUrl: stored.url,
      },
      select: { id: true, docType: true, fileName: true, size: true, storageProvider: true },
    })

    const docs = await db.admissionDocument.findMany({
      where: { admissionId: app.id },
      select: { docType: true },
      orderBy: { createdAt: 'asc' },
    })
    await db.admissionApplication.update({
      where: { id: app.id },
      data: { documents: JSON.stringify(docs.map((d) => d.docType)) },
    }).catch(() => {})

    return NextResponse.json({ ok: true, reference: app.reference, document: saved, documentsCount: docs.length })
  } catch (e: any) {
    console.error('admissions file upload error:', e)
    return NextResponse.json({ error: 'تعذر رفع المستند، حاول مرة أخرى' }, { status: 500 })
  }
}
