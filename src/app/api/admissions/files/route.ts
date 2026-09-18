import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'

const MAX_FILE_SIZE = 4 * 1024 * 1024 // 4MB لكل ملف — لا نقلل الحد؛ فقط نرفع كل ملف بطلب مستقل لتجنب 413.
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
    if (me && me.role === 'STUDENT' && app.userId && app.userId !== me.id) {
      return NextResponse.json({ error: 'لا تملك صلاحية رفع مستندات لهذا الطلب' }, { status: 403 })
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

    await db.admissionDocument.deleteMany({ where: { admissionId: app.id, docType } })
    const saved = await db.admissionDocument.create({
      data: {
        admissionId: app.id,
        docType,
        fileName: file.name.slice(0, 180),
        mimeType: mime,
        size: file.size,
        data: buf.toString('base64'),
      },
      select: { id: true, docType: true, fileName: true, size: true },
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
