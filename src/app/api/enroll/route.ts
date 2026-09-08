import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { audit } from '@/lib/notify'

// POST /api/enroll — التسجيل في برنامج يتم الآن عبر إجراءات الالتحاق الرسمية وفق دليل الإجراءات:
// (1) بيانات كاملة (2) رفع الوثائق الرسمية (3) الإقرار (4) سداد رسوم التقديم 30$
// ثم دراسة الملف من الإدارة وتعيين المشرف، وبعد القبول يسدد الطالب الرسوم الدراسية كاملة
// فيتم التسجيل النهائي وتفعيل الالتحاق تلقائياً.
// هذا المسار يوجّه العميل إلى نموذج طلب الالتحاق الكامل بدلاً من التسجيل المباشر.
export async function POST(req: NextRequest) {
  try {
    const user = await requireUser()
    const { programId } = await req.json()
    if (!programId) return NextResponse.json({ error: 'معرف البرنامج مطلوب' }, { status: 400 })

    const program = await db.program.findUnique({ where: { id: programId } })
    if (!program) return NextResponse.json({ error: 'البرنامج غير موجود' }, { status: 404 })

    const existing = await db.enrollment.findUnique({
      where: { userId_programId: { userId: user.id, programId } },
    })
    if (existing && existing.status !== 'PENDING_PAYMENT') {
      return NextResponse.json({ ok: true, enrollment: existing, message: 'أنت مسجل بالفعل في هذا البرنامج' })
    }

    // هل يوجد طلب التحاق قائم لهذا البرنامج؟
    const pendingApp = await db.admissionApplication.findFirst({
      where: {
        userId: user.id,
        programId,
        status: { in: ['AWAITING_FEE', 'UNDER_REVIEW', 'AWAITING_TUITION'] },
      },
      orderBy: { createdAt: 'desc' },
      select: { reference: true, status: true },
    })
    if (pendingApp) {
      return NextResponse.json({
        ok: true,
        needApplication: true,
        reference: pendingApp.reference,
        message: `لديك طلب التحاق قائم (${pendingApp.reference}) بهذا البرنامج — تابع حالته وسدد الرسوم المطلوبة من صفحة طلب الالتحاق`,
      })
    }

    await audit({ id: user.id, name: user.name }, 'REQUEST_ENROLLMENT', 'Program', programId, `${program.titleAr} — توجيه لنموذج طلب الالتحاق الرسمي`)
    return NextResponse.json({
      ok: true,
      needApplication: true,
      programTitle: program.titleAr,
      message: `الالتحاق ببرنامج «${program.titleAr}» يتم عبر إجراءات التقديم الرسمية: بيانات كاملة + المستندات الرسمية + الإقرار + رسوم تقديم 30$، وبعد موافقة الإدارة تسدد الرسوم الدراسية كاملة ويُفعَّل تسجيلك — فتحنا لك نموذج طلب الالتحاق`,
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'يجب تسجيل الدخول أولاً' }, { status: 401 })
    }
    console.error('Enroll error:', e)
    return NextResponse.json({ error: 'خطأ في التسجيل بالبرنامج' }, { status: 500 })
  }
}
