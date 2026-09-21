import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { sendEmail } from '@/lib/mailer'

export const runtime = 'nodejs'

function mask(value?: string | null) {
  if (!value) return null
  if (value.length <= 8) return '••••'
  return `${value.slice(0, 4)}••••${value.slice(-4)}`
}

function mailHtml(title: string, body: string) {
  return `
    <div dir="rtl" style="font-family:Arial,Tahoma,sans-serif;background:#f5f0e1;padding:24px;color:#0f2b46">
      <div style="max-width:640px;margin:0 auto;background:#fff;border:1px solid #eadfbf;border-radius:18px;padding:24px">
        <h1 style="font-size:22px;margin:0 0 12px;font-weight:800;color:#0f2b46">${title}</h1>
        <p style="font-size:15px;line-height:1.9;margin:0;color:#334155">${body}</p>
        <hr style="border:none;border-top:1px solid #eee;margin:24px 0" />
        <p style="font-size:12px;color:#64748b;margin:0">رسالة اختبار آلية من منصة الأكاديمية.</p>
      </div>
    </div>
  `
}

export async function GET() {
  try {
    await requireAdmin()
    const resendEnabled = Boolean(process.env.RESEND_API_KEY && (process.env.MAIL_FROM || process.env.RESEND_FROM))
    const smtpConfigured = Boolean(
      process.env.SMTP_HOST &&
      process.env.SMTP_USER &&
      process.env.SMTP_PASS &&
      (process.env.SMTP_FROM || process.env.MAIL_FROM)
    )

    const [recent, sent, failed, skipped] = await Promise.all([
      db.emailLog.findMany({
        orderBy: { createdAt: 'desc' },
        take: 25,
        select: { id: true, to: true, subject: true, event: true, status: true, error: true, createdAt: true },
      }),
      db.emailLog.count({ where: { status: 'SENT' } }),
      db.emailLog.count({ where: { status: 'FAILED' } }),
      db.emailLog.count({ where: { status: 'SKIPPED' } }),
    ])

    return NextResponse.json({
      config: {
        smtpConfigured,
        resendEnabled,
        mailFrom: process.env.MAIL_FROM || process.env.RESEND_FROM || process.env.SMTP_FROM || null,
        resendKey: mask(process.env.RESEND_API_KEY),
      },
      stats: { sent, failed, skipped, total: sent + failed + skipped },
      recent,
      warnings: [
        !smtpConfigured && !resendEnabled ? 'البريد غير مفعّل. أضف SMTP من لوحة الإدارة أو RESEND_API_KEY و MAIL_FROM في Vercel.' : null,
        failed > 0 ? `يوجد ${failed} رسالة بريد فاشلة في السجل.` : null,
        skipped > 0 ? `يوجد ${skipped} رسالة تم تخطيها لأن البريد لم يكن مهيأً وقتها.` : null,
      ].filter(Boolean),
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('mail status error:', e)
    return NextResponse.json({ error: 'تعذر تحميل حالة البريد' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const body = await req.json().catch(() => ({}))
    const to = String(body?.to || admin.email || '').trim()
    if (!to || !to.includes('@')) return NextResponse.json({ error: 'اكتب بريدًا صحيحًا لإرسال رسالة اختبار' }, { status: 400 })
    const ok = await sendEmail({
      to,
      event: 'MAIL_TEST',
      subject: 'رسالة اختبار من منصة الأكاديمية',
      html: mailHtml('اختبار البريد ناجح ✅', 'هذه رسالة اختبار للتأكد من أن إعدادات البريد في المنصة تعمل بشكل صحيح.'),
      text: 'هذه رسالة اختبار للتأكد من أن إعدادات البريد في المنصة تعمل بشكل صحيح.',
    })
    return NextResponse.json({ ok, to })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('mail test error:', e)
    return NextResponse.json({ error: 'تعذر إرسال رسالة الاختبار' }, { status: 500 })
  }
}
