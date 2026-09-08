import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'

// GET /api/admin/reports — تقارير مالية وإحصائية
// الإيرادات حسب البرنامج والدولة + أداء الوكلاء + معدلات القبول
export async function GET() {
  try {
    await requireAdmin()
    const payments = await db.payment.findMany({
      where: { status: 'PAID' },
      include: { admission: { select: { program: true, country: true } } },
    })
    const admissions = await db.admissionApplication.findMany({ select: { status: true, country: true, program: true } })
    const agents = await db.agentApplication.findMany({
      where: { kind: 'AGENCY', status: 'APPROVED' },
      include: { revenueShares: true },
    })

    // إيرادات حسب الغرض
    const byPurpose: Record<string, number> = {}
    for (const p of payments) byPurpose[p.purpose] = (byPurpose[p.purpose] || 0) + p.amount

    // إيرادات حسب الدولة
    const byCountry: Record<string, number> = {}
    for (const p of payments) {
      const c = p.payerCountry || p.admission?.country || 'غير محدد'
      byCountry[c] = (byCountry[c] || 0) + p.amount
    }

    // معدلات القبول
    const admissionStats = {
      total: admissions.length,
      approved: admissions.filter((a) => a.status !== 'PENDING' && a.status !== 'UNDER_REVIEW' && a.status !== 'REJECTED').length,
      rejected: admissions.filter((a) => a.status === 'REJECTED').length,
      pending: admissions.filter((a) => ['PENDING', 'UNDER_REVIEW', 'AWAITING_FEE'].includes(a.status)).length,
      certified: admissions.filter((a) => a.status === 'CERTIFIED').length,
    }

    // أداء الوكلاء
    const agentPerformance = agents.map((a) => ({
      orgName: a.orgName,
      territory: a.territory || a.country,
      due: a.revenueShares.filter((r) => r.status === 'DUE').reduce((s, r) => s + r.amount, 0),
      paid: a.revenueShares.filter((r) => r.status === 'PAID').reduce((s, r) => s + r.amount, 0),
      entries: a.revenueShares.length,
    }))

    const totalRevenue = payments.reduce((s, p) => s + p.amount, 0)

    return NextResponse.json({
      totalRevenue,
      byPurpose,
      byCountry,
      admissionStats,
      agentPerformance,
      collectedCount: payments.length,
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    }
    console.error('admin reports GET error:', e)
    return NextResponse.json({ error: 'تعذر تحميل التقارير' }, { status: 500 })
  }
}
