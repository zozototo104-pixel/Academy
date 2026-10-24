import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { checkDatabaseRateLimit } from '@/lib/rate-limit'
import { emailVerificationUrl, issueEmailVerificationToken, shouldIssueNewVerification } from '@/lib/email-verification'
import { hashWhatsAppId, recordWhatsAppOutboundMessage } from '@/lib/whatsapp-conversations'
import { sendOfficialWhatsAppHumanFollowup, sendOfficialWhatsAppText } from '@/lib/whatsapp-cloud'

export const runtime = 'nodejs'

const WHATSAPP_WINDOW_MS = 24 * 60 * 60 * 1000

function clean(value: unknown, max = 500) {
  return String(value || '').trim().slice(0, max)
}

export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const body = await req.json().catch(() => ({}))
    const email = clean(body?.email, 200).toLowerCase()
    if (!email) return NextResponse.json({ ok: false, error: 'البريد مطلوب' }, { status: 400 })
    const user = await db.user.findUnique({
      where: { email },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        role: true,
        emailVerifiedAt: true,
        emailVerificationSentAt: true,
        emailVerificationExpiresAt: true,
      },
    })
    if (!user) return NextResponse.json({ ok: false, error: 'لا يوجد حساب طالب مرتبط بهذا البريد' }, { status: 404 })
    if (user.role !== 'STUDENT') return NextResponse.json({ ok: false, error: 'الحساب ليس حساب طالب' }, { status: 409 })
    if (user.emailVerifiedAt) return NextResponse.json({ ok: false, error: 'الإيميل موثّق أصلاً' }, { status: 409 })
    const digits = String(user.phone || '').replace(/\D/g, '')
    if (digits.length < 8 || digits.length > 15) return NextResponse.json({ ok: false, error: 'لا يوجد رقم هاتف صالح محفوظ للطالب' }, { status: 409 })
    if (!shouldIssueNewVerification(user)) return NextResponse.json({ ok: false, error: 'تم إرسال رابط تحقق مؤخراً، انتظر قليلاً قبل إعادة الإرسال' }, { status: 409 })
    const recipientLimit = await checkDatabaseRateLimit(`whatsapp-verify:recipient:${digits}`, 3, 60 * 60 * 1000)
    if (!recipientLimit.ok) return NextResponse.json({ ok: false, error: 'تم تجاوز حد الإرسال لهذا الرقم، حاول لاحقاً' }, { status: 429 })
    const adminLimit = await checkDatabaseRateLimit(`whatsapp-verify:admin:${admin.id}`, 30, 60 * 60 * 1000)
    if (!adminLimit.ok) return NextResponse.json({ ok: false, error: 'تم تجاوز حد الإرسال، حاول لاحقاً' }, { status: 429 })
    const verification = await issueEmailVerificationToken(user.id)
    const url = emailVerificationUrl(req, verification.token)
    const conversation = await db.whatsAppConversation.findUnique({
      where: { waIdHash: hashWhatsAppId(digits) },
      select: { lastInboundAt: true },
    })
    const lastInboundAt = conversation?.lastInboundAt?.getTime() || 0
    const windowOpen = Boolean(lastInboundAt && Date.now() - lastInboundAt >= 0 && Date.now() - lastInboundAt < WHATSAPP_WINDOW_MS)
    if (windowOpen) {
      const text = `مرحباً ${user.name}، رابط التحقق الخاص بك في أكاديمية AACT: ${url} — الرابط صالح لمدة 24 ساعة.`
      const result = await sendOfficialWhatsAppText(digits, text)
      await recordWhatsAppOutboundMessage({
        waId: digits,
        phoneNumberId: null,
        text,
        sender: 'HUMAN',
        whatsappMessageId: (result as any)?.messages?.[0]?.id || null,
        sentById: admin.id,
        sentByName: admin.name,
      })
      return NextResponse.json({ ok: true, sent: 'link', message: 'تم إرسال رابط التحقق إلى واتساب الطالب' })
    }
    const result = await sendOfficialWhatsAppHumanFollowup(digits, user.name)
    await recordWhatsAppOutboundMessage({
      waId: digits,
      phoneNumberId: null,
      text: `تم إرسال قالب المتابعة المعتمد human_followup_ar إلى ${user.name}. رابط التحقق يُرسل بعد أن يرد الطالب.`,
      sender: 'HUMAN',
      whatsappMessageId: (result as any)?.messages?.[0]?.id || null,
      sentById: admin.id,
      sentByName: admin.name,
    })
    return NextResponse.json({ ok: true, sent: 'template', message: 'تم إرسال الرسالة المعتمدة — بيوصل الرابط لما الطالب يرد' })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ ok: false, error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('admin whatsapp verification send error:', e)
    return NextResponse.json({ ok: false, error: 'تعذر إرسال التحقق عبر واتساب' }, { status: 500 })
  }
}
