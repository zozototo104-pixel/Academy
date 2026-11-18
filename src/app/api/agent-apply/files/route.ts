// POST /api/agent-apply/files — ترحيل ملف واحد من وثائق الوكالة/الاعتماد
// (مرحلة 2 — 2026-11-18): كل ملف يُرفع بطلب مستقل فور اختياره، فيرجع
// مفتاحه ورمز ربطه، ويُرسل الطلب بعدها JSON بالمفاتيح فقط — فلا يجمع
// التقديم كل الملفات في طلب واحد ولا يصطدم بحد 4.5MB، ولا تضيع الملفات
// المرحّلة إن فشل الإرسال. الدخول أولاً (بلا صف في قاعدة البيانات بعد —
// الربط يتم عند التقديم عبر الرمز)، والملفات المرحّلة بلا طلب تبقى خاصة
// وغير قابلة للتخمين، وتُنظَّف عند الاستبدال عبر DELETE أدناه.

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'
import { deleteStoredFile, getStorageDownloadPathForKey, storageErrorMessage, storeFileBuffer } from '@/lib/storage'
import { createAgentUploadToken, verifyAgentUploadToken } from '@/lib/agent-upload-token'
import { enforceDatabaseApiRateLimit } from '@/lib/rate-limit'

const MAX_FILE_SIZE = 4 * 1024 * 1024 // 4MB
const ALLOWED_MIME = ['image/jpeg', 'image/png', 'application/pdf']

function normalizeDocType(raw: string) {
  return String(raw || '').replace(/^doc_/, '').toUpperCase().slice(0, 40)
}

export async function POST(req: NextRequest) {
  try {
    const owner = await getCurrentUser().catch(() => null)
    if (!owner) {
      return NextResponse.json(
        { error: 'نرجو تسجيل الدخول لاستكمال الطلب', code: 'LOGIN_REQUIRED' },
        { status: 401 }
      )
    }
    if (owner.role === 'ADMIN' || owner.role === 'SUPERVISOR') {
      return NextResponse.json(
        { error: 'حساب الإدارة/المشرف لا يقدم طلب وكالة أو اعتماد.' },
        { status: 403 }
      )
    }

    // Account + IP limits run BEFORE reading or storing uploaded bytes.
    const burstLimit = await enforceDatabaseApiRateLimit(req, 'agent-doc-stage-burst', 12, 15 * 60 * 1000, owner.id)
    if (burstLimit) return burstLimit
    const dailyLimit = await enforceDatabaseApiRateLimit(req, 'agent-doc-stage-daily', 40, 24 * 60 * 60 * 1000, owner.id)
    if (dailyLimit) return dailyLimit

    const form = await req.formData()
    const docType = normalizeDocType(String(form.get('docType') || ''))
    const file = form.get('file') as File | null
    if (!docType) {
      return NextResponse.json({ error: 'نوع الوثيقة مطلوب' }, { status: 400 })
    }
    if (!file || typeof file !== 'object' || !('arrayBuffer' in file) || !file.size) {
      return NextResponse.json({ error: 'لم يتم اختيار ملف للرفع' }, { status: 400 })
    }
    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json({ error: `حجم ملف «${file.name}» يتجاوز الحد الأقصى 4 ميجابايت — يرجى ضغطه أو تصغيره` }, { status: 400 })
    }
    const mime = file.type || 'application/octet-stream'
    if (!ALLOWED_MIME.includes(mime)) {
      return NextResponse.json({ error: `صيغة ملف «${file.name}» غير مدعومة — المسموح: صور JPG/PNG أو PDF` }, { status: 400 })
    }

    const buf = Buffer.from(await file.arrayBuffer())
    let stored
    try {
      stored = await storeFileBuffer({
        buffer: buf,
        fileName: file.name,
        mimeType: mime,
        namespace: `agent-documents/${docType.toLowerCase()}`,
      })
    } catch (error) {
      return NextResponse.json({ error: storageErrorMessage(error) }, { status: 500 })
    }

    // الرمز يوقّع بيانات الملف الحقيقية أيضاً: عند تقديم الطلب لا نثق
    // بـ MIME أو الحجم أو نوع التخزين أو رابط يرسله المتصفح.
    let uploadToken: string
    try {
      if (stored.provider !== 's3' && stored.provider !== 'local') throw new Error('INVALID_AGENT_STORAGE_PROVIDER')
      uploadToken = createAgentUploadToken({
        userId: owner.id, docType, storageKey: stored.key,
        storageProvider: stored.provider,
        fileName: file.name.slice(0, 180),
        mimeType: stored.mimeType || mime,
        size: stored.size || file.size,
      })
      await db.agentPendingUpload.create({ data: { storageKey: stored.key } })
    } catch (error) {
      await deleteStoredFile(stored.key)
      throw error
    }

    return NextResponse.json({
      ok: true,
      document: {
        docType,
        storageKey: stored.key,
        uploadToken,
        fileUrl: getStorageDownloadPathForKey(stored.key),
        fileName: file.name.slice(0, 180),
        mimeType: stored.mimeType || mime,
        size: stored.size || file.size,
      },
    })
  } catch (e) {
    console.error('Agent file stage error:', e)
    return NextResponse.json({ error: 'تعذر رفع الملف، حاول مرة أخرى' }, { status: 500 })
  }
}

// DELETE /api/agent-apply/files — حذف مفتاح مرحّل عند استبدال الملف أو
// إزالته قبل التقديم، حتى لا تتراكم مفاتيح يتيمة في التخزين. الرمز هو
// الإثبات: بلا رمز صالح للمفتاح وصاحبه ونوعه يُرفض الحذف. والوثيقة
// المرتبطة بطلب محفوظ لا تُحذف حتى مع الرمز نفسه.
export async function DELETE(req: NextRequest) {
  try {
    const owner = await getCurrentUser().catch(() => null)
    if (!owner) {
      return NextResponse.json(
        { error: 'نرجو تسجيل الدخول لاستكمال الطلب', code: 'LOGIN_REQUIRED' },
        { status: 401 }
      )
    }
    const body = await req.json().catch(() => ({}))
    const storageKey = String(body?.storageKey || '')
    const uploadToken = String(body?.uploadToken || '')
    const match = storageKey.match(/^agent-documents\/([a-z0-9_-]+)\//)
    if (!match) {
      return NextResponse.json({ error: 'مفتاح غير صالح' }, { status: 400 })
    }
    const docType = match[1].toUpperCase()
    if (!verifyAgentUploadToken(uploadToken, { userId: owner.id, docType, storageKey })) {
      return NextResponse.json({ error: 'رمز الرفع غير صالح لهذا الملف' }, { status: 403 })
    }
    const linkedDoc = await db.agentDocument.findFirst({ where: { storageKey }, select: { id: true } })
    if (linkedDoc) {
      return NextResponse.json({ error: 'الوثيقة مرتبطة بطلب محفوظ ولا يمكن حذفها' }, { status: 409 })
    }
    // Commit cancellation before touching the object. A simultaneous submit
    // consumes this same row only while cancelled is false.
    const claim = await db.agentPendingUpload.updateMany({
      where: { storageKey }, data: { cancelled: true },
    })
    if (!claim.count) return NextResponse.json({ error: 'الملف غير متاح للإلغاء' }, { status: 409 })
    const deleted = await deleteStoredFile(storageKey)
    if (!deleted) return NextResponse.json({ error: 'تعذر حذف الملف من التخزين' }, { status: 500 })
    await db.agentPendingUpload.deleteMany({ where: { storageKey, cancelled: true } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('Agent file delete error:', e)
    return NextResponse.json({ error: 'تعذر حذف الملف' }, { status: 500 })
  }
}
