import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { validateAnnouncementMediaSignature } from '@/lib/file-signature'
import { audit } from '@/lib/notify'
import { canManageSiteAnnouncements } from '@/lib/site-announcements'
import { createAnnouncementMediaStorageKey, createSignedStorageUrlForKey, deleteStoredFile, getStorageDownloadPathForKey, inspectUploadedAnnouncementMedia, storageErrorMessage, storeFileBuffer } from '@/lib/storage'

// رفع وسائط الإعلانات (فيديو واحد أو صور) إلى التخزين الخارجي نفسه.
// الحدود صريحة وموثقة: فيديو حتى 500MB (الفيديو التعليمي ~5MB)، صورة حتى 10MB.
// لا متغيرات بيئة جديدة. الرابط العام المخزّن يجب أن يكون قابلاً للوصول
// علنًا (الزوار بلا تسجيل)، لذا نتحقق منه بـ HEAD بعد الرفع؛ إن فشل
// نحذف الملف اليتيم ونرجع 422 بدل حفظ رابط مكسور.

const ANNOUNCEMENT_VIDEO_MAX_BYTES = 500 * 1024 * 1024
const ANNOUNCEMENT_IMAGE_MAX_BYTES = 10 * 1024 * 1024

const ALLOWED_MIME_TYPES = new Set([
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'image/jpeg',
  'image/png',
  'image/webp',
])

async function requireAnnouncementAdmin() {
  const user = await getCurrentUser()
  if (!user) return { user: null, error: NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 }) }
  if (!canManageSiteAnnouncements(user)) return { user: null, error: NextResponse.json({ error: 'FORBIDDEN' }, { status: 403 }) }
  return { user, error: null }
}

function jsonError(error: unknown, status = 400) {
  const message = error instanceof Error ? error.message : 'تعذر تنفيذ العملية'
  return NextResponse.json({ error: message }, { status })
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAnnouncementAdmin()
    if (auth.error || !auth.user) return auth.error || NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })

    // Large files bypass Vercel's request-body cap: the browser uploads
    // directly to the existing PRIVATE R2 bucket using a short-lived PUT URL.
    if (req.headers.get('content-type')?.includes('application/json')) {
      const body = await req.json().catch(() => null)
      if (!body || typeof body !== 'object') return NextResponse.json({ error: 'طلب الرفع غير صالح' }, { status: 400 })
      if (body.action === 'INIT') {
        const fileName = String(body.fileName || '')
        const mimeType = String(body.mimeType || '').split(';')[0].trim().toLowerCase()
        const size = Number(body.size)
        if (!ALLOWED_MIME_TYPES.has(mimeType)) return NextResponse.json({ error: 'صيغة الملف غير مدعومة' }, { status: 400 })
        const maxBytes = mimeType.startsWith('video/') ? ANNOUNCEMENT_VIDEO_MAX_BYTES : ANNOUNCEMENT_IMAGE_MAX_BYTES
        if (!Number.isSafeInteger(size) || size <= 0 || size > maxBytes) {
          return NextResponse.json({ error: 'حجم الملف غير صالح أو يتجاوز الحد المسموح' }, { status: 400 })
        }
        let key: string
        try {
          key = createAnnouncementMediaStorageKey(fileName)
        } catch {
          return NextResponse.json({ error: 'اسم الملف أو امتداده غير صالح' }, { status: 400 })
        }
        const uploadUrl = createSignedStorageUrlForKey(key, 300, 'PUT')
        if (!uploadUrl) return NextResponse.json({ error: 'التخزين الخارجي غير مهيأ للرفع المباشر' }, { status: 422 })
        return NextResponse.json({ uploadUrl, key, expiresInSec: 300 })
      }
      if (body.action === 'COMPLETE') {
        const key = String(body.key || '')
        if (!/^announcements\/media\/\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36}-.+\.(?:mp4|mov|webm|jpe?g|png|webp)$/i.test(key)) {
          return NextResponse.json({ error: 'مفتاح وسائط الإعلان غير صالح' }, { status: 400 })
        }
        const inspected = await inspectUploadedAnnouncementMedia(key)
        if (!inspected) return NextResponse.json({ error: 'الملف المرفوع غير موجود' }, { status: 404 })
        const maxBytes = inspected.mimeType.startsWith('video/') ? ANNOUNCEMENT_VIDEO_MAX_BYTES : ANNOUNCEMENT_IMAGE_MAX_BYTES
        const signature = validateAnnouncementMediaSignature({
          buffer: inspected.signatureBytes, fileName: key.split('/').pop() || '', mimeType: inspected.mimeType,
        })
        if (!ALLOWED_MIME_TYPES.has(inspected.mimeType) || inspected.size > maxBytes || !signature.ok) {
          await deleteStoredFile(key)
          return NextResponse.json({ error: 'محتوى الملف أو حجمه لا يطابق شروط الرفع' }, { status: 400 })
        }
        const url = new URL(getStorageDownloadPathForKey(key), req.url).toString()
        await audit(auth.user, 'SYSTEM_UPDATE', 'SITE_ANNOUNCEMENT', key, 'رفع وسائط إعلان مباشرة إلى التخزين الخاص')
        return NextResponse.json({ url, key, size: inspected.size, mimeType: signature.mimeType })
      }
      return NextResponse.json({ error: 'عملية الرفع غير معروفة' }, { status: 400 })
    }

    let form: FormData
    try {
      form = await req.formData()
    } catch {
      return NextResponse.json({ error: 'نموذج الرفع غير صالح' }, { status: 400 })
    }
    const file = form.get('file')
    if (!file || typeof file === 'string' || typeof (file as File).arrayBuffer !== 'function') {
      return NextResponse.json({ error: 'اختر ملف فيديو أو صورة للرفع' }, { status: 400 })
    }
    const upload = file as File
    const mimeType = String(upload.type || '').split(';')[0].trim().toLowerCase()
    if (!ALLOWED_MIME_TYPES.has(mimeType)) {
      return NextResponse.json({ error: 'صيغة الملف غير مدعومة — المسموح: فيديو mp4/webm/mov أو صورة jpg/png/webp' }, { status: 400 })
    }
    const isVideo = mimeType.startsWith('video/')
    const maxBytes = isVideo ? ANNOUNCEMENT_VIDEO_MAX_BYTES : ANNOUNCEMENT_IMAGE_MAX_BYTES
    if (upload.size <= 0) return NextResponse.json({ error: 'الملف فارغ أو غير صالح.' }, { status: 400 })
    if (upload.size > maxBytes) {
      return NextResponse.json({ error: isVideo ? 'حجم الفيديو يجب ألا يتجاوز 500MB' : 'حجم الصورة يجب ألا يتجاوز 10MB' }, { status: 400 })
    }

    const buffer = Buffer.from(await upload.arrayBuffer())
    // البايتات السحرية أولاً: لا نثق بالـ MIME المعلن من المتصفح وحده.
    const signature = validateAnnouncementMediaSignature({ buffer, fileName: upload.name, mimeType })
    if (!signature.ok) return NextResponse.json({ error: signature.error }, { status: 400 })

    let stored
    try {
      stored = await storeFileBuffer({
        buffer,
        fileName: upload.name,
        mimeType: signature.mimeType,
        namespace: 'announcements/media',
      })
    } catch (error) {
      return NextResponse.json({ error: storageErrorMessage(error) }, { status: 422 })
    }

    // Stable same-origin media URL: visitors receive a fresh short-lived S3
    // redirect on every GET. Never make the existing R2 bucket public.
    const publicUrl = new URL(getStorageDownloadPathForKey(stored.key), req.url).toString()

    await audit(auth.user, 'SYSTEM_UPDATE', 'SITE_ANNOUNCEMENT', stored.key, `رفع وسائط إعلان: ${upload.name}`)
    return NextResponse.json({ url: publicUrl, key: stored.key, size: stored.size, mimeType: stored.mimeType })
  } catch (error) {
    return jsonError(error, 500)
  }
}
