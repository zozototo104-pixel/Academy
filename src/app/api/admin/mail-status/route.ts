import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'

export const runtime = 'nodejs'

function mask(value?: string | null) {
  if (!value) return null
  if (value.length <= 8) return '••••'
  return `${value.slice(0, 4)}••••${value.slice(-4)}`
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
