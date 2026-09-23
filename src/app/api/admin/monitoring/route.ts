import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { appVersion, serviceConfigurationStatus, timed } from '@/lib/monitoring'
import { backupConfigurationStatus } from '@/lib/backups'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function since(minutes: number) {
  return new Date(Date.now() - minutes * 60 * 1000)
}

export async function GET() {
  try {
    await requireAdmin()
    const startedAt = Date.now()
    const dbCheck = await timed('database', async () => {
      await db.$queryRaw`SELECT 1`
      return true
    })

    const [users, students, admins, admissionsPending, servicesPending, paymentsUnpaid, paymentsPaid, certificates, contactsOpen, audit24h, recentVitals] = await Promise.all([
      db.user.count(),
      db.user.count({ where: { role: 'STUDENT' } }),
      db.user.count({ where: { role: 'ADMIN' } }),
      db.admissionApplication.count({ where: { status: { in: ['SUBMITTED', 'UNDER_REVIEW', 'DOCS_REQUESTED'] } } }),
      db.admissionApplication.count({ where: { status: { in: ['PAID', 'APPROVED'] } } }),
      db.payment.count({ where: { status: 'UNPAID' } }),
      db.payment.count({ where: { status: 'PAID' } }),
      db.certificate.count(),
      db.contactMessage.count({ where: { handled: false } }),
      db.auditLog.count({ where: { createdAt: { gte: since(24 * 60) } } }),
      db.auditLog.findMany({
        where: {
          action: 'WEB_VITAL',
          createdAt: { gte: since(24 * 60) },
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: { createdAt: true, details: true },
      }),
    ])

    const vitalSummary = recentVitals.reduce<Record<string, { count: number; poor: number; needsImprovement: number; good: number }>>((acc, row) => {
      const parts = String(row.details || '').split('|').map((x) => x.trim())
      const name = parts.find((p) => p.startsWith('name='))?.replace('name=', '') || 'UNKNOWN'
      const rating = parts.find((p) => p.startsWith('rating='))?.replace('rating=', '') || 'unknown'
      acc[name] ||= { count: 0, poor: 0, needsImprovement: 0, good: 0 }
      acc[name].count += 1
      if (rating === 'poor') acc[name].poor += 1
      else if (rating === 'needs-improvement') acc[name].needsImprovement += 1
      else if (rating === 'good') acc[name].good += 1
      return acc
    }, {})

    return NextResponse.json({
      status: dbCheck.ok ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      responseMs: Date.now() - startedAt,
      uptimeSeconds: Math.round(process.uptime()),
      version: appVersion(),
      configured: serviceConfigurationStatus(),
      backup: backupConfigurationStatus(),
      checks: {
        database: { ok: dbCheck.ok, ms: dbCheck.ms },
      },
      counters: {
        users,
        students,
        admins,
        admissionsPending,
        servicesPending,
        paymentsUnpaid,
        paymentsPaid,
        certificates,
        contactsOpen,
        audit24h,
      },
      webVitals24h: vitalSummary,
    }, { headers: { 'Cache-Control': 'no-store, max-age=0' } })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    console.error('admin monitoring error:', e)
    return NextResponse.json({ error: 'تعذر تحميل مراقبة الأداء' }, { status: 500 })
  }
}
