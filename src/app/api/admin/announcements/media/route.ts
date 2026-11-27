import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { validateAnnouncementMediaSignature } from '@/lib/file-signature'
import { audit } from '@/lib/notify'
import { canManageSiteAnnouncements } from '@/lib/site-announcements'
import { deleteStoredFile, getPublicStorageUrlForKey, storageErrorMessage, storeFileBuffer } from '@/lib/storage'

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

    const publicUrl = stored.url || getPublicStorageUrlForKey(stored.key) || ''
    if (!publicUrl) {
      await deleteStoredFile(stored.key)
      return NextResponse.json({ error: 'تعذر تحديد رابط عام للملف المرفوع — تحقق من إعدادات التخزين العام.' }, { status: 422 })
    }
    // رابط محلي نسبي (/uploads/...) يعمل في بيئة التطوير فقط؛ في الإنتاج
    // الرفع المحلي محظور أصلاً. الروابط المطلقة يجب أن ترد 2xx علنًا.
    if (/^https?:\/\//i.test(publicUrl)) {
      let reachable = false
      try {
        const head = await fetch(publicUrl, { method: 'HEAD', signal: AbortSignal.timeout(8000) })
        reachable = head.ok
      } catch {
        reachable = false
      }
      if (!reachable) {
        await deleteStoredFile(stored.key)
        return NextResponse.json({ error: 'تم رفع الملف لكن رابطه العام غير قابل للوصول — تحقق من أن حاوية التخزين عامة القراءة.' }, { status: 422 })
      }
    }

    await audit(auth.user, 'SYSTEM_UPDATE', 'SITE_ANNOUNCEMENT', stored.key, `رفع وسائط إعلان: ${upload.name}`)
    return NextResponse.json({ url: publicUrl, key: stored.key, size: stored.size, mimeType: stored.mimeType })
  } catch (error) {
    return jsonError(error, 500)
  }
}
