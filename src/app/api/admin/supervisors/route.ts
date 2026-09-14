import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin, hashPassword } from '@/lib/auth'
import { audit, AUDIT_ACTIONS } from '@/lib/notify'

function publicSupervisor(u: any) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    phone: u.phone,
    country: u.country,
    role: u.role,
    createdAt: u.createdAt,
    supervisedCount: u._count?.supervisedAdmissions || 0,
  }
}

export async function GET() {
  try {
    await requireAdmin()
    const supervisors = await db.user.findMany({
      where: { role: 'SUPERVISOR' },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { supervisedAdmissions: true } } },
    })
    return NextResponse.json({ supervisors: supervisors.map(publicSupervisor) })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    console.error('admin supervisors GET error:', e)
    return NextResponse.json({ error: 'تعذر تحميل المشرفين' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const { name, email, password, phone, country } = await req.json()
    const emailNorm = String(email || '').trim().toLowerCase()
    if (!String(name || '').trim() || !emailNorm || !String(password || '')) {
      return NextResponse.json({ error: 'اسم المشرف والبريد وكلمة المرور مطلوبة' }, { status: 400 })
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm)) {
      return NextResponse.json({ error: 'صيغة بريد المشرف غير صحيحة' }, { status: 400 })
    }
    if (String(password).length < 6) {
      return NextResponse.json({ error: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' }, { status: 400 })
    }
    const existing = await db.user.findUnique({ where: { email: emailNorm } })
    if (existing) {
      if (existing.role !== 'SUPERVISOR') {
        const updated = await db.user.update({
          where: { id: existing.id },
          data: { role: 'SUPERVISOR', name: String(name).trim(), phone: String(phone || '').trim() || existing.phone, country: String(country || '').trim() || existing.country },
          include: { _count: { select: { supervisedAdmissions: true } } },
        })
        await audit(admin, AUDIT_ACTIONS.SYSTEM_UPDATE, 'User', updated.id, `ترقية المستخدم ${updated.email} إلى مشرف بشري`)
        return NextResponse.json({ ok: true, supervisor: publicSupervisor(updated), promoted: true })
      }
      return NextResponse.json({ error: 'هذا البريد مسجل مسبقاً كمشرف' }, { status: 409 })
    }
    const supervisor = await db.user.create({
      data: {
        name: String(name).trim(),
        email: emailNorm,
        password: hashPassword(String(password)),
        phone: String(phone || '').trim() || null,
        country: String(country || '').trim() || null,
        role: 'SUPERVISOR',
      },
      include: { _count: { select: { supervisedAdmissions: true } } },
    })
    await audit(admin, AUDIT_ACTIONS.SYSTEM_UPDATE, 'User', supervisor.id, `إنشاء حساب مشرف بشري ${supervisor.email}`)
    return NextResponse.json({ ok: true, supervisor: publicSupervisor(supervisor) })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    console.error('admin supervisors POST error:', e)
    return NextResponse.json({ error: e?.message || 'تعذر إنشاء المشرف' }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const { id, action, password } = await req.json()
    if (!id) return NextResponse.json({ error: 'معرّف المشرف مطلوب' }, { status: 400 })
    const sup = await db.user.findUnique({ where: { id } })
    if (!sup || sup.role !== 'SUPERVISOR') return NextResponse.json({ error: 'المشرف غير موجود' }, { status: 404 })
    if (action === 'reset-password') {
      if (!String(password || '') || String(password).length < 6) return NextResponse.json({ error: 'كلمة المرور الجديدة يجب أن تكون 6 أحرف على الأقل' }, { status: 400 })
      await db.user.update({ where: { id }, data: { password: hashPassword(String(password)) } })
      await audit(admin, AUDIT_ACTIONS.SYSTEM_UPDATE, 'User', id, `إعادة تعيين كلمة مرور المشرف ${sup.email}`)
      return NextResponse.json({ ok: true })
    }
    if (action === 'revoke-role') {
      const active = await db.admissionApplication.count({ where: { supervisorId: id } })
      if (active > 0) return NextResponse.json({ error: 'لا يمكن إلغاء صلاحية المشرف قبل نقل الطلاب المعيّنين له إلى مشرف آخر' }, { status: 400 })
      await db.user.update({ where: { id }, data: { role: 'STUDENT' } })
      await audit(admin, AUDIT_ACTIONS.SYSTEM_UPDATE, 'User', id, `إلغاء صلاحية المشرف ${sup.email}`)
      return NextResponse.json({ ok: true })
    }
    return NextResponse.json({ error: 'إجراء غير معروف' }, { status: 400 })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    console.error('admin supervisors PATCH error:', e)
    return NextResponse.json({ error: e?.message || 'تعذر تحديث المشرف' }, { status: 500 })
  }
}
