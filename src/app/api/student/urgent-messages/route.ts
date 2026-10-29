import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'

export const runtime = 'nodejs'

// تنبيه «الخبر العاجل» عند الطالب: رسائل الإدارة (ADMIN_MESSAGE) ورسائل
// المشرف البشري (SUPERVISION) غير المقروءة. النوعان لا يُنتجهما إلا إرسال
// الإدارة/المشرف من خدمة الرسائل — ردود الذكاء لا تُنشئ إشعارات فلا تدخل
// هنا أبدًا. حالة القراءة هي حقل read الموجود أصلًا على الإشعار.
const TYPE_BY_KIND: Record<string, string> = { ADMIN: 'ADMIN_MESSAGE', SUPERVISION: 'SUPERVISION' }

// GET /api/student/urgent-messages — عدد غير المقروء من كل نوع + أحدث إشعار
// (رابط محادثة الإدارة يأتي من حقل link بصيغة admin-messages:<id>).
export async function GET() {
  try {
    const user = await requireUser()
    if (user.role !== 'STUDENT') return NextResponse.json({ ok: true, admin: { count: 0, latestAt: null, admissionId: null }, supervisor: { count: 0, latestAt: null } })
    const [adminCount, adminLatest, supervisorCount, supervisorLatest] = await Promise.all([
      db.notification.count({ where: { userId: user.id, type: 'ADMIN_MESSAGE', read: false } }),
      db.notification.findFirst({ where: { userId: user.id, type: 'ADMIN_MESSAGE', read: false }, orderBy: { createdAt: 'desc' }, select: { createdAt: true, link: true } }),
      db.notification.count({ where: { userId: user.id, type: 'SUPERVISION', read: false } }),
      db.notification.findFirst({ where: { userId: user.id, type: 'SUPERVISION', read: false }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
    ])
    const admissionId = adminLatest?.link?.startsWith('admin-messages:') ? adminLatest.link.slice('admin-messages:'.length) || null : null
    return NextResponse.json({
      ok: true,
      admin: { count: adminCount, latestAt: adminLatest?.createdAt || null, admissionId },
      supervisor: { count: supervisorCount, latestAt: supervisorLatest?.createdAt || null },
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ ok: true, admin: { count: 0, latestAt: null, admissionId: null }, supervisor: { count: 0, latestAt: null } })
    console.error('urgent messages GET error', e)
    return NextResponse.json({ ok: false, error: 'تعذر تحميل التنبيهات العاجلة' }, { status: 500 })
  }
}

// POST /api/student/urgent-messages { kind: 'ADMIN' | 'SUPERVISION' | 'ALL' }
// يعلّم إشعارات النوع المطلوب كمقروءة (فتح المحادثة أو تجاهل الشريط).
export async function POST(req: NextRequest) {
  try {
    const user = await requireUser()
    if (user.role !== 'STUDENT') return NextResponse.json({ ok: true, updated: 0 })
    const body = await req.json().catch(() => ({}))
    const kind = String(body?.kind || 'ALL').toUpperCase()
    const types = kind === 'ALL' ? Object.values(TYPE_BY_KIND) : TYPE_BY_KIND[kind] ? [TYPE_BY_KIND[kind]] : []
    if (!types.length) return NextResponse.json({ ok: false, error: 'نوع تنبيه غير صالح' }, { status: 400 })
    const result = await db.notification.updateMany({ where: { userId: user.id, type: { in: types }, read: false }, data: { read: true } })
    return NextResponse.json({ ok: true, updated: result.count })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ ok: false, error: 'يجب تسجيل الدخول' }, { status: 401 })
    console.error('urgent messages POST error', e)
    return NextResponse.json({ ok: false, error: 'تعذر تحديث التنبيهات' }, { status: 500 })
  }
}
