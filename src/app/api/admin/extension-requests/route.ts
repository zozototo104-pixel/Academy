import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'
import { notify, audit } from '@/lib/notify'
import { sendEmail, emailTemplate } from '@/lib/mailer'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/admin/extension-requests — قائمة طلبات التمديد (المعلقة أولًا).
export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser()
    if (!user || user.role !== 'ADMIN') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    const status = req.nextUrl.searchParams.get('status') || 'PENDING'
    const requests = await db.programExtensionRequest.findMany({
      where: status === 'ALL' ? {} : { status },
      orderBy: { createdAt: 'asc' },
      take: 100,
      include: {
        user: { select: { name: true, email: true } },
        program: { select: { titleAr: true } },
        enrollment: { select: { status: true, extensionDays: true, createdAt: true } },
      },
    })
    return NextResponse.json({ requests })
  } catch (e) {
    console.error('admin extension requests error', e)
    return NextResponse.json({ error: 'تعذر تحميل طلبات التمديد' }, { status: 500 })
  }
}

// POST /api/admin/extension-requests — اعتماد أو رفض.
// الاعتماد: تُضاف الأيام الممنوحة للتمديد، وإذا كان البرنامج مغلقًا (EXPIRED)
// يُعاد فتحه (ACTIVE) وتُلغى الدرجة المرصودة حتى تُعاد حسابها عند الإغلاق أو الإكمال التالي.
export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser()
    if (!user || user.role !== 'ADMIN') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    const body = await req.json().catch(() => ({}))
    const requestId = String(body.requestId || '')
    const action = String(body.action || '')
    const adminNote = String(body.adminNote || '').slice(0, 2000)
    if (!requestId || !['APPROVE', 'REJECT'].includes(action)) {
      return NextResponse.json({ error: 'طلب غير صالح' }, { status: 400 })
    }
    const request = await db.programExtensionRequest.findUnique({
      where: { id: requestId },
      include: { enrollment: true, user: { select: { name: true, email: true } }, program: { select: { titleAr: true } } },
    })
    if (!request) return NextResponse.json({ error: 'الطلب غير موجود' }, { status: 404 })
    if (request.status !== 'PENDING') return NextResponse.json({ error: 'هذا الطلب سبق البتّ فيه' }, { status: 409 })
    if (action === 'REJECT') {
      await db.programExtensionRequest.update({ where: { id: requestId }, data: { status: 'REJECTED', adminNote: adminNote || null, decidedById: user.id, decidedAt: new Date() } })
      await audit(user, 'EXTENSION_REQUEST_REJECTED', 'ProgramExtensionRequest', requestId, `رفض طلب تمديد ${request.requestedDays} يومًا للطالب ${request.user.name}`)
      const title = `تمت مراجعة طلب تمديد برنامج «${request.program.titleAr}»`
      const notifyBody = `للأسف، لم يُعتمد طلب تمديدك (${request.requestedDays} يومًا)${adminNote ? ` — ملاحظة الأدمن: ${adminNote}` : ''}.`
      await notify(request.userId, 'GENERAL', title, notifyBody, '/?view=dashboard')
      if (request.user.email) {
        await sendEmail({ to: request.user.email, event: 'EXTENSION_REQUEST_DECISION', subject: title, html: emailTemplate(title, `<p>${notifyBody.replace(/[<>]/g, '')}</p>`) }).catch(() => {})
      }
      return NextResponse.json({ ok: true })
    }
    const grantedDays = Number(body.grantedDays)
    if (!Number.isFinite(grantedDays) || grantedDays < 1 || grantedDays > 365) {
      return NextResponse.json({ error: 'عدد الأيام الممنوحة يجب أن يكون بين 1 و 365' }, { status: 400 })
    }
    await db.$transaction([
      db.programExtensionRequest.update({ where: { id: requestId }, data: { status: 'APPROVED', grantedDays: Math.floor(grantedDays), adminNote: adminNote || null, decidedById: user.id, decidedAt: new Date() } }),
      db.enrollment.update({
        where: { id: request.enrollmentId },
        data: {
          extensionDays: { increment: Math.floor(grantedDays) },
          ...(request.enrollment.status === 'EXPIRED' ? { status: 'ACTIVE', finalScore: null } : {}),
        },
      }),
    ])
    await audit(user, 'EXTENSION_REQUEST_APPROVED', 'ProgramExtensionRequest', requestId, `اعتمد تمديد ${grantedDays} يومًا للطالب ${request.user.name} (كان يطلب ${request.requestedDays})`)
    const title = `تم اعتماد تمديد برنامج «${request.program.titleAr}»`
    const notifyBody = `تم اعتماد تمديد ${grantedDays} يومًا لبرنامجك${request.enrollment.status === 'EXPIRED' ? '، وأُعيد فتح البرنامج' : ''}${adminNote ? ` — ملاحظة الأدمن: ${adminNote}` : ''}.`
    await notify(request.userId, 'GENERAL', title, notifyBody, '/?view=dashboard')
    if (request.user.email) {
      await sendEmail({ to: request.user.email, event: 'EXTENSION_REQUEST_DECISION', subject: title, html: emailTemplate(title, `<p>${notifyBody.replace(/[<>]/g, '')}</p>`) }).catch(() => {})
    }
    return NextResponse.json({ ok: true, grantedDays: Math.floor(grantedDays) })
  } catch (e) {
    console.error('admin extension decision error', e)
    return NextResponse.json({ error: 'تعذر تنفيذ القرار' }, { status: 500 })
  }
}
