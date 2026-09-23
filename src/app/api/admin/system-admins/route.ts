import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { hashPassword } from '@/lib/password'
import { audit } from '@/lib/notify'

const MIN_PASSWORD_LENGTH = 12

function normalizeEmail(value: unknown) {
  return String(value || '').trim().toLowerCase()
}

function adminSelect() {
  return {
    id: true,
    name: true,
    email: true,
    role: true,
    status: true,
    createdAt: true,
    updatedAt: true,
  } as const
}

function isActiveAdmin(user: { role?: string | null; status?: string | null }) {
  return user.role === 'ADMIN' && user.status !== 'DISABLED' && user.status !== 'ARCHIVED'
}

// GET /api/admin/system-admins — قائمة مدراء النظام فقط للإدارة
export async function GET() {
  try {
    await requireAdmin()
    const admins = await db.user.findMany({
      where: { role: 'ADMIN' },
      select: adminSelect(),
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    })
    const activeAdmins = admins.filter(isActiveAdmin).length
    return NextResponse.json({ admins, activeAdmins })
  } catch (e) {
    console.error('system-admins GET error:', e)
    return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
  }
}

// POST /api/admin/system-admins — إنشاء أدمن اختباري/إضافي أو تحديث أدمن موجود
export async function POST(req: NextRequest) {
  try {
    const actor = await requireAdmin()
    const body = await req.json().catch(() => ({}))
    const email = normalizeEmail(body.email)
    const password = String(body.password || '')
    const name = String(body.name || '').trim() || 'إدارة الأكاديمية'

    if (!email || !email.includes('@')) {
      return NextResponse.json({ error: 'أدخل بريداً إلكترونياً صحيحاً' }, { status: 400 })
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      return NextResponse.json({ error: `كلمة المرور يجب أن تكون ${MIN_PASSWORD_LENGTH} حرفاً على الأقل` }, { status: 400 })
    }

    const existing = await db.user.findUnique({ where: { email } })
    if (existing && existing.role !== 'ADMIN') {
      return NextResponse.json(
        { error: 'هذا البريد مستخدم لحساب طالب/مشرف. استخدم بريداً آخر لحساب الإدارة الاختباري.' },
        { status: 409 }
      )
    }

    const passwordHash = hashPassword(password)
    const admin = existing
      ? await db.user.update({
          where: { id: existing.id },
          data: {
            name,
            password: passwordHash,
            status: 'ACTIVE',
            archivedAt: null,
          },
          select: adminSelect(),
        })
      : await db.user.create({
          data: {
            email,
            name,
            password: passwordHash,
            role: 'ADMIN',
            status: 'ACTIVE',
            country: 'USA',
          },
          select: adminSelect(),
        })

    await audit(
      actor,
      existing ? 'UPDATE_ADMIN_ACCOUNT' : 'CREATE_ADMIN_ACCOUNT',
      'User',
      admin.id,
      `${existing ? 'تحديث' : 'إنشاء'} حساب إدارة: ${admin.email}`
    )

    return NextResponse.json({ admin })
  } catch (e) {
    console.error('system-admins POST error:', e)
    return NextResponse.json({ error: 'تعذر إنشاء/تحديث حساب الإدارة' }, { status: 500 })
  }
}

// DELETE /api/admin/system-admins?id=... — حذف آمن: تعطيل وأرشفة لا حذف قاسٍ لحماية السجلات
export async function DELETE(req: NextRequest) {
  try {
    const actor = await requireAdmin()
    const id = req.nextUrl.searchParams.get('id') || ''
    if (!id) return NextResponse.json({ error: 'معرّف الحساب مطلوب' }, { status: 400 })
    if (id === actor.id) {
      return NextResponse.json({ error: 'لا يمكنك تعطيل حسابك الحالي من نفس الجلسة' }, { status: 400 })
    }

    const target = await db.user.findUnique({ where: { id } })
    if (!target || target.role !== 'ADMIN') {
      return NextResponse.json({ error: 'حساب الإدارة غير موجود' }, { status: 404 })
    }

    const activeAdmins = await db.user.count({
      where: {
        role: 'ADMIN',
        status: { notIn: ['DISABLED', 'ARCHIVED'] },
      },
    })
    if (isActiveAdmin(target) && activeAdmins <= 1) {
      return NextResponse.json({ error: 'لا يمكن تعطيل آخر حساب إدارة نشط' }, { status: 400 })
    }

    const disabled = await db.$transaction(async (tx) => {
      await tx.session.deleteMany({ where: { userId: id } })
      return tx.user.update({
        where: { id },
        data: { status: 'DISABLED', archivedAt: new Date() },
        select: adminSelect(),
      })
    })

    await audit(actor, 'DISABLE_ADMIN_ACCOUNT', 'User', disabled.id, `تعطيل حساب إدارة: ${disabled.email}`)
    return NextResponse.json({ admin: disabled })
  } catch (e) {
    console.error('system-admins DELETE error:', e)
    return NextResponse.json({ error: 'تعذر تعطيل حساب الإدارة' }, { status: 500 })
  }
}
