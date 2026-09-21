import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { audit } from '@/lib/notify'
import { sendEmail, getSmtpConfig, emailTemplate } from '@/lib/mailer'
import { ensureGeminiKey, hasGemini, invalidateGeminiKeyCache, normalizeGeminiModelName, geminiActiveLiveModel, isValidGeminiLiveModel, geminiApiKey, isQuotaError, isAuthError, isModelUnavailableError, isInvalidArgumentError, geminiKeyDiagnostics, geminiTestConnection } from '@/lib/gemini'
import { localAgentDiagnostics, testLocalAgentConnection } from '@/lib/open-source-llm'
import { getGatewayConfig, paymentDiagnostics } from '@/lib/payments'
import { textAiDiagnostics, textAiTestConnection } from '@/lib/text-ai'

const SYSTEM_KEYS = [
  'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'SMTP_NAME', 'SMTP_ENABLED',
  'RESEND_API_KEY', 'MAIL_FROM', 'RESEND_FROM',
  'PAYMENT_MODE', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET',
  'PAYPAL_CLIENT_ID', 'PAYPAL_SECRET', 'PAYPAL_API_BASE',
  'TURN_URL', 'TURN_TCP_URL', 'TURN_USERNAME', 'TURN_CREDENTIAL', 'STUN_URLS',
  'GEMINI_API_KEY', 'GEMINI_TEXT_MODEL', 'GEMINI_TTS_MODEL', 'GEMINI_LIVE_MODEL', 'GEMINI_SUPERVISOR_LIVE_MODEL', 'GEMINI_DISCUSSION_LIVE_MODEL', 'GEMINI_DISCUSSION_THINKING_LEVEL', 'GEMINI_TTS_VOICE',
  'AI_TEXT_PROVIDER', 'OPENAI_API_KEY', 'OPENAI_TEXT_MODEL', 'OPENAI_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_TEXT_MODEL', 'ZAI_API_KEY', 'ZAI_TEXT_MODEL', 'ZAI_API_BASE',
  'AI_AGENT_PROVIDER', 'AI_AGENT_BASE_URL', 'AI_AGENT_MODEL', 'AI_AGENT_API_KEY',
]

const SECRET_KEYS = new Set(['SMTP_PASS', 'RESEND_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'PAYPAL_SECRET', 'GEMINI_API_KEY', 'AI_AGENT_API_KEY'])

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
    const gemini = await geminiKeyDiagnostics()
    const agent = await localAgentDiagnostics()
    const payment = paymentDiagnostics(await getGatewayConfig())
    const resendKeyRow = await db.setting.findUnique({ where: { key: 'RESEND_API_KEY' } }).catch(() => null)
    const mailFromRow = await db.setting.findUnique({ where: { key: 'MAIL_FROM' } }).catch(() => null)
    const resendFromRow = await db.setting.findUnique({ where: { key: 'RESEND_FROM' } }).catch(() => null)
    const resendConfigured = !!((resendKeyRow?.value || process.env.RESEND_API_KEY) && (mailFromRow?.value || resendFromRow?.value || process.env.MAIL_FROM || process.env.RESEND_FROM))
    const appUrlConfigured = !!(process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL)
    const launchReadiness = [
      { id: 'database', label: 'قاعدة البيانات', status: 'ok', detail: 'الاتصال بقاعدة البيانات يعمل وتم تحميل الإعدادات.' },
      { id: 'mail', label: 'Resend / البريد', status: resendConfigured || smtp.enabled ? 'ok' : 'warn', detail: resendConfigured ? 'Resend مضبوط لإرسال الإشعارات.' : smtp.enabled ? 'SMTP مضبوط كبديل لإرسال الإشعارات.' : 'الإشعارات البريدية غير مفعلة بعد؛ اضبط RESEND_API_KEY و MAIL_FROM أو SMTP.' },
      { id: 'payment', label: 'الدفع الإلكتروني', status: payment.trueGatewayCount > 0 ? 'ok' : payment.errors.length > 0 ? 'error' : 'warn', detail: payment.trueGatewayCount > 0 ? `بوابات الدفع الحقيقية المفعلة: ${payment.trueGatewayCount}.` : payment.errors[0] || 'لا توجد بوابة دفع حقيقية مفعلة حالياً؛ Stripe/PayPal بحاجة لإعداد live.' },
      { id: 'gemini', label: 'Gemini / الذكاء الاصطناعي', status: gemini.source === 'none' ? 'warn' : 'ok', detail: gemini.source === 'none' ? 'مفتاح Gemini غير موجود؛ وظائف الذكاء الاصطناعي ستكون محدودة.' : `مفتاح Gemini مستخدم من ${gemini.source === 'db' ? 'لوحة الإدارة' : 'Vercel'}.` },
      { id: 'turn', label: 'TURN للفيديو', status: !!(values.TURN_URL && (values.TURN_USERNAME || process.env.TURN_USERNAME)) ? 'ok' : 'warn', detail: values.TURN_URL ? 'TURN مضبوط جزئياً؛ تأكد من اسم المستخدم وكلمة المرور.' : 'TURN غير مضبوط؛ الفيديو يعتمد على STUN/P2P فقط.' },
      { id: 'app-url', label: 'رابط التطبيق', status: appUrlConfigured ? 'ok' : 'warn', detail: appUrlConfigured ? 'رابط التطبيق مضبوط في البيئة.' : 'اضبط NEXT_PUBLIC_APP_URL في Vercel قبل الإطلاق.' },
    ]
    return NextResponse.json({
      values,
      secretsSet: {
        SMTP_PASS: !!(await db.setting.findUnique({ where: { key: 'SMTP_PASS' } }))?.value,
        RESEND_API_KEY: !!(await db.setting.findUnique({ where: { key: 'RESEND_API_KEY' } }))?.value,
        STRIPE_SECRET_KEY: !!(await db.setting.findUnique({ where: { key: 'STRIPE_SECRET_KEY' } }))?.value,
        STRIPE_WEBHOOK_SECRET: !!(await db.setting.findUnique({ where: { key: 'STRIPE_WEBHOOK_SECRET' } }))?.value,
        PAYPAL_SECRET: !!(await db.setting.findUnique({ where: { key: 'PAYPAL_SECRET' } }))?.value,
        TURN_CREDENTIAL: !!(await db.setting.findUnique({ where: { key: 'TURN_CREDENTIAL' } }))?.value,
        GEMINI_API_KEY: !!(await db.setting.findUnique({ where: { key: 'GEMINI_API_KEY' } }))?.value,
        AI_AGENT_API_KEY: !!(await db.setting.findUnique({ where: { key: 'AI_AGENT_API_KEY' } }))?.value,
      },
      smtpEnabled: smtp.enabled,
      resendConfigured,
      paymentMode: payment.mode,
      payment,
      launchReadiness,
      turnConfigured: !!(values.TURN_URL && (values.TURN_USERNAME || process.env.TURN_USERNAME)),
      gemini,
      agent,
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
      // الحقول السرية: القيمة المقنعة = لا تغيير. أمّا مفتاح Gemini تحديداً فيمكن تفريغه للرجوع إلى مفتاح Vercel الافتراضي.
      if (SECRET_KEYS.has(key) && value.includes('••••')) continue
      if (SECRET_KEYS.has(key) && value === '') {
        if (key === 'GEMINI_API_KEY' || key === 'AI_AGENT_API_KEY') {
          await db.setting.delete({ where: { key } }).catch(() => null)
          updates.push(key)
        }
        continue
      }
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
    const gemini = await geminiKeyDiagnostics()
    const agent = await localAgentDiagnostics()
    return NextResponse.json({ ok: true, values, gemini, agent })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    return NextResponse.json({ error: 'تعذر حفظ الإعدادات' }, { status: 500 })
  }
}

// POST /api/admin/system — اختبار البريد (إرسال رسالة تجريبية إلى بريد الإدارة)
export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const { action, model: selectedLiveModel } = await req.json()
    if (action === 'test-email') {
      const ok = await sendEmail({
        to: admin.email,
        event: 'TEST_EMAIL',
        subject: 'رسالة تجريبية من منصة الأكاديمية — البريد يعمل ✅',
        html: emailTemplate(
          'تهانينا — الإشعارات البريدية تعمل',
          `<p>هذه رسالة تجريبية أرسلتها الإدارة للتحقق من إعدادات Resend أو SMTP في المنصة.</p>
           <p>إذا وصلتك هذه الرسالة فإن كل الإشعارات الآلية (طلبات الالتحاق، الإيصالات، الامتحانات، مواعيد المناقشات، الشهادات) ستصلك وستصل الطلاب بنجاح.</p>`
        ),
      })
      return NextResponse.json({ ok, message: ok ? 'أُرسلت رسالة الاختبار إلى بريدك — افحص صندوق الوارد' : 'لم يُرسل البريد — راجع الإعدادات وسجل البريد أدناه' })
    }
    if (action === 'test-local-agent') {
      const diag = await localAgentDiagnostics()
      const test = await testLocalAgentConnection()
      return NextResponse.json({
        ok: test.ok,
        title: test.ok ? 'الوكيل المحلي يعمل' : 'فشل اختبار الوكيل المحلي',
        message: test.ok
          ? `تم الاتصال بالنموذج المفتوح المصدر بنجاح: ${test.model || diag.model}`
          : `${test.message}${test.error ? ` — ${test.error}` : ''}`,
        agent: diag,
      })
    }
    if (action === 'test-gemini-text') {
      await ensureGeminiKey()
      const diag = await geminiKeyDiagnostics()
      if (!hasGemini()) {
        return NextResponse.json({ ok: false, title: 'مفتاح Gemini غير موجود', message: 'لا يوجد مفتاح Gemini فعّال في لوحة الإدارة أو Vercel.', gemini: diag })
      }
      const test = await geminiTestConnection()
      if (test.ok) {
        return NextResponse.json({ ok: true, title: 'Gemini يعمل', message: `تم اختبار نموذج النصوص بنجاح: ${test.model || 'تلقائي'} — المفتاح المستخدم: ${diag.source === 'db' ? 'لوحة الإدارة' : 'Vercel'} ${diag.activeMask}`, gemini: diag, model: test.model })
      }
      if (test.quotaExhausted) {
        return NextResponse.json({ ok: false, title: 'انتهت حصة Gemini', message: `المفتاح المستخدم الآن: ${diag.source === 'db' ? 'لوحة الإدارة' : diag.source === 'env' ? 'Vercel' : 'لا يوجد'} ${diag.activeMask}. الخطأ من الحصة/429 وليس من حفظ الإعدادات.`, gemini: diag })
      }
      return NextResponse.json({ ok: false, title: 'فشل اختبار Gemini', message: String(test.error || 'تعذر الاتصال بـ Gemini').slice(0, 300), gemini: diag })
    }
    if (action === 'test-gemini-live') {
      await ensureGeminiKey()
      if (!hasGemini()) {
        return NextResponse.json({ ok: false, title: 'مفتاح Gemini غير موجود', message: 'مفتاح Gemini غير موجود أو غير صالح.' })
      }
      const selected = normalizeGeminiModelName(selectedLiveModel)
      const model = selected || await geminiActiveLiveModel()
      if (!isValidGeminiLiveModel(model)) {
        return NextResponse.json({ ok: false, title: 'اسم نموذج Gemini Live غير صحيح', message: 'اسم نموذج Gemini Live غير صحيح، اختر نموذجاً من القائمة ثم احفظ/اختبر.' })
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
