import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { hashPassword, requireAdmin } from '@/lib/auth'
import { audit, AUDIT_ACTIONS } from '@/lib/notify'

// GET /api/admin/students — قائمة الطلاب مع تسجيلاتهم ونتائجهم
// GET /api/admin/students?role=supervisors — قائمة المشرفين البشريين
export async function GET(req: NextRequest) {
  try {
    await requireAdmin()
    if (req.nextUrl.searchParams.get('role') === 'supervisors') {
      const supervisors = await db.user.findMany({
        where: { role: 'SUPERVISOR' },
        orderBy: { createdAt: 'desc' },
        include: { _count: { select: { supervisedAdmissions: true } } },
      })
      return NextResponse.json({ supervisors: supervisors.map(publicSupervisor) })
    }

    const students = await db.user.findMany({
      where: { role: 'STUDENT' },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: {
        enrollments: {
          include: { program: { select: { titleAr: true } } },
        },
        examAttempts: {
          orderBy: { submittedAt: 'desc' },
          take: 5,
          select: { score: true, passed: true, submittedAt: true },
        },
        _count: { select: { chatMessages: { where: { role: 'user' } } } },
      },
    })

    const studentIds = students.map((s) => s.id)
    const studentEmails = students.map((s) => s.email).filter(Boolean)
    const admissions = students.length
      ? await db.admissionApplication.findMany({
          where: {
            OR: [
              { userId: { in: studentIds } },
              { email: { in: studentEmails } },
            ],
          },
          orderBy: { createdAt: 'desc' },
          select: { id: true, reference: true, userId: true, email: true, status: true, program: true, createdAt: true },
        })
      : []

    const latestAdmissionByStudent = new Map<string, typeof admissions[number]>()
    for (const app of admissions) {
      if (app.userId && !latestAdmissionByStudent.has(app.userId)) latestAdmissionByStudent.set(app.userId, app)
      const emailKey = app.email.toLowerCase()
      if (emailKey && !latestAdmissionByStudent.has(emailKey)) latestAdmissionByStudent.set(emailKey, app)
    }

    return NextResponse.json({
      students: students.map((s) => {
        const latestAdmission = latestAdmissionByStudent.get(s.id) || latestAdmissionByStudent.get(s.email.toLowerCase()) || null
        return ({
        id: s.id,
        name: s.name,
        email: s.email,
        country: s.country,
        createdAt: s.createdAt,
        enrollments: s.enrollments.map((e) => ({
          program: e.program.titleAr,
          status: e.status,
          progress: (() => {
            try {
              const done = JSON.parse(e.completedUnits || '[]').length
              return e.program ? done : 0
            } catch {
              return 0
            }
          })(),
          certificateNo: e.certificateNo,
          finalScore: e.finalScore,
        })),
        attemptsCount: s.examAttempts.length,
        bestScore: s.examAttempts.reduce<number | null>(
          (best, a) => (a.score !== null && (best === null || (a.score || 0) > best) ? a.score : best),
          null
        ),
        aiChats: s._count.chatMessages,
        latestAdmission: latestAdmission
          ? {
              id: latestAdmission.id,
              reference: latestAdmission.reference,
              status: latestAdmission.status,
              program: latestAdmission.program,
              createdAt: latestAdmission.createdAt,
            }
          : null,
        })
      }),
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    }
    console.error('Admin students error:', e)
    return NextResponse.json({ error: 'خطأ في تحميل الطلاب' }, { status: 500 })
  }
}

function publicSupervisor(u: any) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    phone: u.phone,
    country: u.country,
    createdAt: u.createdAt,
    supervisedCount: u._count?.supervisedAdmissions || 0,
  }
}

// إنشاء حساب مشرف بشري من لوحة الإدارة عبر نفس مسار الطلاب حتى لا نحتاج مسار API جديد.
export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const body = await req.json()
    if (body?.action !== 'create-supervisor') return NextResponse.json({ error: 'إجراء غير معروف' }, { status: 400 })

    const name = String(body.name || '').trim()
    const email = String(body.email || '').trim().toLowerCase()
    const password = String(body.password || '')
    const phone = String(body.phone || '').trim()
    const country = String(body.country || '').trim()
    if (!name || !email || !password) return NextResponse.json({ error: 'اسم المشرف والبريد وكلمة المرور مطلوبة' }, { status: 400 })
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return NextResponse.json({ error: 'صيغة البريد الإلكتروني غير صحيحة' }, { status: 400 })
    if (password.length < 6) return NextResponse.json({ error: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' }, { status: 400 })

    const existing = await db.user.findUnique({ where: { email } })
    if (existing) {
      if (existing.role === 'SUPERVISOR') return NextResponse.json({ error: 'هذا البريد مسجل مسبقاً كمشرف' }, { status: 409 })
      const updated = await db.user.update({
        where: { id: existing.id },
        data: { role: 'SUPERVISOR', name, phone: phone || existing.phone, country: country || existing.country },
        include: { _count: { select: { supervisedAdmissions: true } } },
      })
      await audit(admin, AUDIT_ACTIONS.SYSTEM_UPDATE, 'User', updated.id, `ترقية ${updated.email} إلى مشرف بشري`)
      return NextResponse.json({ ok: true, supervisor: publicSupervisor(updated), promoted: true })
    }

    const supervisor = await db.user.create({
      data: { name, email, password: hashPassword(password), phone: phone || null, country: country || null, role: 'SUPERVISOR' },
      include: { _count: { select: { supervisedAdmissions: true } } },
    })
    await audit(admin, AUDIT_ACTIONS.SYSTEM_UPDATE, 'User', supervisor.id, `إنشاء حساب مشرف بشري ${supervisor.email}`)
    return NextResponse.json({ ok: true, supervisor: publicSupervisor(supervisor) })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    console.error('Admin create supervisor error:', e)
    return NextResponse.json({ error: e?.message || 'تعذر إنشاء المشرف' }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const body = await req.json()
    const id = String(body.id || '')
    if (!id) return NextResponse.json({ error: 'معرّف المشرف مطلوب' }, { status: 400 })
    const supervisor = await db.user.findUnique({ where: { id } })
    if (!supervisor || supervisor.role !== 'SUPERVISOR') return NextResponse.json({ error: 'المشرف غير موجود' }, { status: 404 })

    if (body.action === 'reset-supervisor-password') {
      const password = String(body.password || '')
      if (password.length < 6) return NextResponse.json({ error: 'كلمة المرور الجديدة يجب أن تكون 6 أحرف على الأقل' }, { status: 400 })
      await db.user.update({ where: { id }, data: { password: hashPassword(password) } })
      await audit(admin, AUDIT_ACTIONS.SYSTEM_UPDATE, 'User', id, `إعادة تعيين كلمة مرور المشرف ${supervisor.email}`)
      return NextResponse.json({ ok: true })
    }

    if (body.action === 'revoke-supervisor') {
      const assigned = await db.admissionApplication.count({ where: { supervisorId: id } })
      if (assigned > 0) return NextResponse.json({ error: 'لا يمكن إلغاء صلاحية المشرف قبل نقل الطلاب المعيّنين له إلى مشرف آخر' }, { status: 400 })
      await db.user.update({ where: { id }, data: { role: 'STUDENT' } })
      await audit(admin, AUDIT_ACTIONS.SYSTEM_UPDATE, 'User', id, `إلغاء صلاحية المشرف ${supervisor.email}`)
      return NextResponse.json({ ok: true })
    }

    return NextResponse.json({ error: 'إجراء غير معروف' }, { status: 400 })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    console.error('Admin supervisor patch error:', e)
    return NextResponse.json({ error: e?.message || 'تعذر تعديل المشرف' }, { status: 500 })
  }
}
