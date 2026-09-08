import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { audit, notify } from '@/lib/notify'

// GET /api/admin/revenue — مستحقات كل الوكلاء (عمولات 25% + لجان 100$)
export async function GET() {
  try {
    await requireAdmin()
    const agents = await db.agentApplication.findMany({
      where: { kind: 'AGENCY', status: 'APPROVED' },
      include: { revenueShares: { orderBy: { createdAt: 'desc' } } },
    })
    return NextResponse.json({ agents })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    }
    console.error('admin revenue GET error:', e)
    return NextResponse.json({ error: 'تعذر تحميل المستحقات' }, { status: 500 })
  }
}

// POST /api/admin/revenue — تسجيل مستحق جديد لوكيل (عمولة أو لجنة)
export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const { agentId, type, description, amount, programCountry } = await req.json()
    if (!agentId || !amount || !description?.trim()) {
      return NextResponse.json({ error: 'الوكيل والمبلغ والوصف مطلوبة' }, { status: 400 })
    }
    const agent = await db.agentApplication.findUnique({ where: { id: agentId } })
    if (!agent) return NextResponse.json({ error: 'الوكيل غير موجود' }, { status: 404 })
    const dueDate = new Date()
    dueDate.setDate(dueDate.getDate() + 14) // التحويل خلال 14 يوماً وفق العقد
    const share = await db.revenueShareTransaction.create({
      data: {
        agentId,
        type: type === 'COMMITTEE_FEE' ? 'COMMITTEE_FEE' : 'REVENUE_SHARE',
        description: description.trim().slice(0, 300),
        amount: parseFloat(String(amount)),
        dueDate,
        programCountry: programCountry?.trim() || agent.country,
      },
    })
    await audit(admin, 'ADD_REVENUE_SHARE', 'RevenueShareTransaction', share.id,
      `${agent.orgName} — ${amount}$ (${share.type === 'COMMITTEE_FEE' ? 'لجنة مناقشة' : 'عمولة برامج'})`)
    return NextResponse.json({ ok: true, share })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    }
    console.error('admin revenue POST error:', e)
    return NextResponse.json({ error: 'تعذر التسجيل' }, { status: 500 })
  }
}

// PATCH /api/admin/revenue — تأكيد تحويل مستحق (DUE → PAID)
export async function PATCH(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const { id } = await req.json()
    const share = await db.revenueShareTransaction.findUnique({
      where: { id },
      include: { agent: true },
    })
    if (!share) return NextResponse.json({ error: 'السجل غير موجود' }, { status: 404 })
    const updated = await db.revenueShareTransaction.update({
      where: { id },
      data: { status: 'PAID', paidAt: new Date() },
    })
    const owner = await db.user.findUnique({ where: { email: share.agent.email } })
    if (owner) {
      await notify(owner.id, 'AGENT', 'تم تحويل مستحقاتك', `حولت الأكاديمية مستحق «${share.description}» بمبلغ ${share.amount}$. شكراً لشراكتك.`, 'agent')
    }
    await audit(admin, 'MARK_SHARE_PAID', 'RevenueShareTransaction', id, `${share.agent.orgName} — ${share.amount}$`)
    return NextResponse.json({ ok: true, share: updated })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    }
    console.error('admin revenue PATCH error:', e)
    return NextResponse.json({ error: 'تعذر التحديث' }, { status: 500 })
  }
}
