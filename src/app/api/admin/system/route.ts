import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { audit } from '@/lib/notify'
import { sendEmail, getSmtpConfig, emailTemplate } from '@/lib/mailer'
import { ensureGeminiKey, hasGemini, invalidateGeminiKeyCache, normalizeGeminiModelName, geminiActiveLiveModel, isValidGeminiLiveModel, geminiApiKey, isQuotaError, isAuthError, isModelUnavailableError, isInvalidArgumentError } from '@/lib/gemini'

const SYSTEM_KEYS = [
  'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'SMTP_NAME', 'SMTP_ENABLED',
  'PAYMENT_MODE', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET',
  'PAYPAL_CLIENT_ID', 'PAYPAL_SECRET', 'PAYPAL_API_BASE',
  'TURN_URL', 'TURN_TCP_URL', 'TURN_USERNAME', 'TURN_CREDENTIAL', 'STUN_URLS',
  'GEMINI_API_KEY', 'GEMINI_TEXT_MODEL', 'GEMINI_TTS_MODEL', 'GEMINI_LIVE_MODEL', 'GEMINI_TTS_VOICE',
]

const SECRET_KEYS = new Set(['SMTP_PASS', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'PAYPAL_SECRET', 'GEMINI_API_KEY'])

function mask(v: string): string {
  if (!v) return ''
  if (v.length <= 6) return '••••••'
  return `${v.slice(0, 3)}••••••${v.slice(-3)}`
}

// GET /api/admin/system — إعدادات النظام: البريد + الدفع + TURN (الأسرار مقنعة) + سجل البريد
export async function GET() {
  try {
    await requireAdmin()
    const rows = await db.setting.findMany({ where: { key: { in: SYSTEM_KEYS } } })
    const values: Record<string, string> = {}
    for (const k of SYSTEM_KEYS) values[k] = ''
    for (const r of rows) values[r.key] = SECRET_KEYS.has(r.key) ? mask(r.value) : r.value
    const smtp = await getSmtpConfig()
    const emails = await db.emailLog.findMany({ orderBy: { createdAt: 'desc' }, take: 50 })
    return NextResponse.json({
      values,
      secretsSet: {
        SMTP_PASS: !!(await db.setting.findUnique({ where: { key: 'SMTP_PASS' } }))?.value,
        STRIPE_SECRET_KEY: !!(await db.setting.findUnique({ where: { key: 'STRIPE_SECRET_KEY' } }))?.value,
        STRIPE_WEBHOOK_SECRET: !!(await db.setting.findUnique({ where: { key: 'STRIPE_WEBHOOK_SECRET' } }))?.value,
        PAYPAL_SECRET: !!(await db.setting.findUnique({ where: { key: 'PAYPAL_SECRET' } }))?.value,
        TURN_CREDENTIAL: !!(await db.setting.findUnique({ where: { key: 'TURN_CREDENTIAL' } }))?.value,
        GEMINI_API_KEY: !!(await db.setting.findUnique({ where: { key: 'GEMINI_API_KEY' } }))?.value,
      },
      smtpEnabled: smtp.enabled,
      paymentMode: (await db.setting.findUnique({ where: { key: 'PAYMENT_MODE' } }))?.value || 'SANDBOX',
      turnConfigured: !!(values.TURN_URL && (values.TURN_USERNAME || process.env.TURN_USERNAME)),
      emails,
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    return NextResponse.json({ error: 'خطأ في تحميل إعدادات النظام' }, { status: 500 })
  }
}

// PATCH /api/admin/system — حفظ إعدادات النظام (الأسرار تُحفظ فقط عند تغييرها)
export async function PATCH(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const body = await req.json()
    const updates: string[] = []
    for (const key of SYSTEM_KEYS) {
      if (!(key in body)) continue
      let value = String(body[key] ?? '').trim()
      // الحقول السرية: أرسل قيمة مقنعة أو فارغة = لا تغيير
      if (SECRET_KEYS.has(key) && (value.includes('••••') || value === '')) continue
      if (['GEMINI_TEXT_MODEL', 'GEMINI_TTS_MODEL', 'GEMINI_LIVE_MODEL'].includes(key)) {
        value = normalizeGeminiModelName(value)
        if (key === 'GEMINI_LIVE_MODEL' && value && !isValidGeminiLiveModel(value)) value = 'gemini-3.1-flash-live-preview'
      }
      await db.setting.upsert({
        where: { key },
        create: { key, value },
        update: { value },
      })
      updates.push(key)
    }
    if (updates.some((k) => k.startsWith('GEMINI_'))) invalidateGeminiKeyCache()
    await audit(admin, 'UPDATE_SETTINGS', 'Setting', null, `إعدادات النظام: ${updates.join(', ')}`)
    const rows = await db.setting.findMany({ where: { key: { in: SYSTEM_KEYS } } })
    const values: Record<string, string> = {}
    for (const k of SYSTEM_KEYS) values[k] = ''
    for (const r of rows) values[r.key] = SECRET_KEYS.has(r.key) ? mask(r.value) : r.value
    return NextResponse.json({ ok: true, values })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    return NextResponse.json({ error: 'تعذر حفظ الإعدادات' }, { status: 500 })
  }
}

// POST /api/admin/system — اختبار البريد (إرسال رسالة تجريبية إلى بريد الإدارة)
export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const { action } = await req.json()
    if (action === 'test-email') {
      const ok = await sendEmail({
        to: admin.email,
        event: 'TEST_EMAIL',
        subject: 'رسالة تجريبية من منصة الأكاديمية — البريد يعمل ✅',
        html: emailTemplate(
          'تهانينا — الإشعارات البريدية تعمل',
          `<p>هذه رسالة تجريبية أرسلتها الإدارة للتحقق من إعدادات SMTP في المنصة.</p>
           <p>إذا وصلتك هذه الرسالة فإن كل الإشعارات الآلية (طلبات الالتحاق، الإيصالات، الامتحانات، مواعيد المناقشات، الشهادات) ستصلك وستصل الطلاب بنجاح.</p>`
        ),
      })
      return NextResponse.json({ ok, message: ok ? 'أُرسلت رسالة الاختبار إلى بريدك — افحص صندوق الوارد' : 'لم يُرسل البريد — راجع الإعدادات وسجل البريد أدناه' })
    }
    if (action === 'test-gemini-live') {
      await ensureGeminiKey()
      if (!hasGemini()) {
        return NextResponse.json({ ok: false, title: 'مفتاح Gemini غير موجود', message: 'مفتاح Gemini غير موجود أو غير صالح.' })
      }
      const model = await geminiActiveLiveModel()
      if (!isValidGeminiLiveModel(model)) {
        return NextResponse.json({ ok: false, title: 'اسم نموذج Gemini Live غير صحيح', message: 'اسم نموذج Gemini Live غير صحيح، استخدم gemini-3.1-flash-live-preview.' })
      }
      try {
        const apiKey = await geminiApiKey()
        const now = Date.now()
        const r = await fetch('https://generativelanguage.googleapis.com/v1beta/auth_tokens', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify({
            uses: 1,
            expireTime: new Date(now + 30 * 60 * 1000).toISOString(),
            newSessionExpireTime: new Date(now + 60 * 1000).toISOString(),
            liveConnectConstraints: {
              model: `models/${model}`,
              config: {
                responseModalities: ['AUDIO'],
                sessionResumption: {},
              },
            },
          }),
        })
        const d: any = await r.json().catch(() => ({}))
        if (!r.ok) {
          const msg = d?.error?.message || d?.message || `Gemini Live HTTP ${r.status}`
          const err: any = new Error(msg)
          err.status = r.status
          if (isQuotaError(err)) return NextResponse.json({ ok: false, title: 'انتهت حصة Gemini', message: 'انتهت حصة Gemini مؤقتاً، فعّل Billing أو انتظر إعادة ضبط الحصة.', model })
          if (isAuthError(err)) return NextResponse.json({ ok: false, title: 'مفتاح Gemini غير صالح', message: 'مفتاح Gemini غير موجود أو غير صالح.', model })
          if (isModelUnavailableError(err) || isInvalidArgumentError(err)) return NextResponse.json({ ok: false, title: 'إعدادات Gemini Live غير مقبولة', message: 'اسم نموذج Gemini Live غير صحيح، استخدم gemini-3.1-flash-live-preview.', model })
          return NextResponse.json({ ok: false, title: 'فشل اختبار Gemini Live', message: msg.slice(0, 300), model })
        }
        return NextResponse.json({ ok: true, title: 'Gemini Live يعمل', message: `تم إنشاء رمز مؤقت بنجاح للنموذج ${model}`, model })
      } catch (e: any) {
        const msg = String(e?.message || e || '').slice(0, 300)
        return NextResponse.json({ ok: false, title: 'فشل اختبار Gemini Live', message: msg || 'تعذر اختبار Gemini Live', model })
      }
    }
    return NextResponse.json({ error: 'إجراء غير معروف' }, { status: 400 })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    return NextResponse.json({ error: 'تعذر تنفيذ الإجراء' }, { status: 500 })
  }
}
