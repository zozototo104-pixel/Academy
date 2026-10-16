import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { hashPassword, requireAdmin } from '@/lib/auth'
import { audit } from '@/lib/notify'
import { enforceApiRateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'

function clean(value: unknown, max = 500) {
  return String(value || '').trim().slice(0, max)
}

function normalizeEmail(value: unknown) {
  return clean(value, 254).toLowerCase()
}

function validEmail(value: unknown) {
  const email = normalizeEmail(value)
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : ''
}

function passwordStrengthError(value: unknown) {
  const password = String(value || '')
  if (password.length < 10) return 'كلمة المرور يجب أن تكون 10 أحرف على الأقل.'
  if (!/[A-Za-z]/.test(password)) return 'كلمة المرور يجب أن تحتوي أحرفاً لاتينية على الأقل لتسهيل إدخالها من كل الأجهزة.'
  if (!/\d/.test(password)) return 'كلمة المرور يجب أن تحتوي رقماً واحداً على الأقل.'
  if (!/[^A-Za-z0-9]/.test(password)) return 'كلمة المرور يجب أن تحتوي رمزاً خاصاً واحداً على الأقل.'
  return null
}

function supervisorPayload(row: any) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone || null,
    country: row.country || null,
    status: row.status,
    createdAt: row.createdAt,
    supervisedCount: row._count?.supervisedAdmissions || 0,
  }
}

export async function GET() {
  try {
    await requireAdmin()
    const supervisors = await db.user.findMany({
      where: { role: 'SUPERVISOR' },
      orderBy: [{ createdAt: 'desc' }],
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        country: true,
        status: true,
        createdAt: true,
        _count: { select: { supervisedAdmissions: true } },
      },
    })
    return NextResponse.json({ supervisors: supervisors.map(supervisorPayload) })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('admin supervisors GET error:', e)
    return NextResponse.json({ error: 'تعذر تحميل المشرفين' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const limited = enforceApiRateLimit(req, 'admin-supervisors:create', 12, 60 * 1000, admin.id)
    if (limited) return limited
    const body = await req.json().catch(() => ({}))
    const name = clean(body.name, 120)
    const email = validEmail(body.email)
    const password = String(body.password || '')
    const phone = clean(body.phone, 80) || null
    const country = clean(body.country, 80) || null
    if (!name) return NextResponse.json({ error: 'اسم المشرف مطلوب' }, { status: 400 })
    if (!email) return NextResponse.json({ error: 'صيغة بريد المشرف غير صحيحة' }, { status: 400 })
    const passwordError = passwordStrengthError(password)
    if (passwordError) return NextResponse.json({ error: passwordError }, { status: 400 })

    const duplicate = await db.user.findUnique({ where: { email }, select: { id: true } })
    if (duplicate) return NextResponse.json({ error: 'يوجد حساب بهذا البريد مسبقاً' }, { status: 409 })

    const supervisor = await db.user.create({
      data: { name, email, password: hashPassword(password), phone, country, role: 'SUPERVISOR', status: 'ACTIVE' },
      select: { id: true, name: true, email: true, phone: true, country: true, status: true, createdAt: true, _count: { select: { supervisedAdmissions: true } } },
    })
    await audit({ id: admin.id, name: admin.name }, 'CREATE_SUPERVISOR', 'User', supervisor.id, `إنشاء حساب مشرف ${email}`)
    return NextResponse.json({ ok: true, supervisor: supervisorPayload(supervisor) }, { status: 201 })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('admin supervisors POST error:', e)
    return NextResponse.json({ error: 'تعذر تنفيذ العملية' }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const limited = enforceApiRateLimit(req, 'admin-supervisors:update', 24, 60 * 1000, admin.id)
    if (limited) return limited
    const body = await req.json().catch(() => ({}))
    const action = clean(body.action, 80)
    const id = clean(body.id || body.userId, 120)
    if (!id) return NextResponse.json({ error: 'معرف المشرف مطلوب' }, { status: 400 })
    const supervisor = await db.user.findFirst({
      where: { id, role: 'SUPERVISOR' },
      select: { id: true, email: true, name: true, _count: { select: { supervisedAdmissions: true } } },
    })
    if (!supervisor) return NextResponse.json({ error: 'المشرف غير موجود' }, { status: 404 })

    if (action === 'reset-supervisor-password') {
      const password = String(body.password || '')
      const passwordError = passwordStrengthError(password)
      if (passwordError) return NextResponse.json({ error: passwordError }, { status: 400 })
      await db.$transaction([
        db.user.update({ where: { id }, data: { password: hashPassword(password) } }),
        db.session.deleteMany({ where: { userId: id } }),
      ])
      await audit({ id: admin.id, name: admin.name }, 'RESET_SUPERVISOR_PASSWORD', 'User', id, `إعادة تعيين كلمة مرور المشرف ${supervisor.email} وإبطال جلساته`)
      return NextResponse.json({ ok: true })
    }

    if (action === 'revoke-supervisor') {
      const supervisedCount = supervisor._count.supervisedAdmissions || 0
      if (supervisedCount > 0) {
        return NextResponse.json({ error: `لا يمكن إلغاء صلاحية المشرف قبل نقل ${supervisedCount} طالب/طلب مرتبط به.`, code: 'SUPERVISOR_HAS_STUDENTS', supervisedCount }, { status: 409 })
      }
      const updated = await db.$transaction(async (tx) => {
        const user = await tx.user.update({ where: { id }, data: { role: 'STUDENT' }, select: { id: true, name: true, email: true, role: true, status: true } })
        await tx.session.deleteMany({ where: { userId: id } })
        return user
      })
      await audit({ id: admin.id, name: admin.name }, 'REVOKE_SUPERVISOR', 'User', id, `إلغاء صلاحية المشرف ${supervisor.email}`)
      return NextResponse.json({ ok: true, user: updated })
    }

    return NextResponse.json({ error: 'إجراء مشرف غير معروف' }, { status: 400 })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('admin supervisors PATCH error:', e)
    return NextResponse.json({ error: 'تعذر تنفيذ العملية' }, { status: 500 })
  }
}
