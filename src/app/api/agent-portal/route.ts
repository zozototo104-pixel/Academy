import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'

// GET /api/agent-portal — بوابة الوكيل: بيانات العقد + العمولات والمستحقات
// يطابق الوكيل المُعتمد عبر بريد حسابه المسجل
export async function GET() {
  try {
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ portal: null })
    const app = await db.agentApplication.findFirst({
      where: { email: user.email, status: 'APPROVED' },
      orderBy: { createdAt: 'desc' },
      include: {
        revenueShares: { orderBy: { createdAt: 'desc' } },
        certificates: { orderBy: { issuedAt: 'desc' } },
      },
    })
    if (!app) return NextResponse.json({ portal: null })

    const due = app.revenueShares.filter((r) => r.status === 'DUE')
    const paid = app.revenueShares.filter((r) => r.status === 'PAID')
    // أقرب موعد تحويل مستحق (خلال 14 يوماً وفق العقد)
    const nextDueDate = due
      .map((d) => d.dueDate)
      .filter(Boolean)
      .sort((a, b) => new Date(a!).getTime() - new Date(b!).getTime())[0] || null

    return NextResponse.json({
      portal: {
        contract: {
          contractNo: app.contractNo,
          orgName: app.orgName,
          repName: app.repName,
          territory: app.territory || app.country,
          exclusive: app.exclusive,
          commissionRate: app.commissionRate,
          committeeFee: app.committeeFee,
          startDate: app.startDate,
          endDate: app.endDate,
          kind: app.kind,
          accreditationType: app.accreditationType,
          country: app.country,
        },
        shares: app.revenueShares,
        certificates: app.certificates,
        totals: {
          due: due.reduce((s, r) => s + r.amount, 0),
          paid: paid.reduce((s, r) => s + r.amount, 0),
          dueCount: due.length,
        },
        nextDueDate,
      },
    })
  } catch (e) {
    console.error('agent portal GET error:', e)
    return NextResponse.json({ error: 'تعذر تحميل بوابة الوكيل' }, { status: 500 })
  }
}
