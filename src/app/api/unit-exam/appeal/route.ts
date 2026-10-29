import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { notify, notifyAdmins } from '@/lib/notify'
import { assignedSupervisorForStudent, studentHasHumanSupervisor } from '@/lib/supervisor-scope'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// التماس مراجعة تصحيح امتحان الوحدة — مرآة التماس الامتحان الفصلي،
// بشرط هاريس: متاح فقط للطالب الذي له مشرف بشري معيّن (الذكاء لا
// يراجع تصحيح نفسه)، ويُوجَّه الالتماس لذلك المشرف + إشعار للإدارة.

// POST /api/unit-exam/appeal — الطالب يقدّم الالتماس
export async function POST(req: NextRequest) {
  try {
    const user = await requireUser()
    const { attemptId, reason } = await req.json().catch(() => ({}))
    if (!attemptId || !String(reason || '').trim()) {
      return NextResponse.json({ error: 'اكتب سبب الالتماس بوضوح ليقيّمه مشرفك البشري' }, { status: 400 })
    }
    if (!(await studentHasHumanSupervisor(user.id))) {
      return NextResponse.json({ error: 'التماس المراجعة متاح عندما يكون لك مشرف بشري معيّن — راسل الإدارة إن احتجت مراجعة', code: 'NO_HUMAN_SUPERVISOR' }, { status: 403 })
    }
    const dbAny = db as any
    const attempt: any = await dbAny.examAttempt.findUnique({
      where: { id: String(attemptId) },
      include: { exam: { select: { title: true, unit: { select: { title: true } } } } },
    })
    if (!attempt || attempt.userId !== user.id) {
      return NextResponse.json({ error: 'المحاولة غير موجودة' }, { status: 404 })
    }
    if (attempt.status !== 'GRADED') {
      return NextResponse.json({ error: 'لا يمكن تقديم التماس إلا على محاولة مصححة ومعتمدة', code: 'APPEAL_REQUIRES_GRADED_ATTEMPT' }, { status: 409 })
    }
    if (attempt.appealStatus === 'PENDING') {
      return NextResponse.json({ error: 'التماسك قيد المراجعة بالفعل' }, { status: 409 })
    }
    if (attempt.appealStatus === 'REVIEWED') {
      return NextResponse.json({ error: 'تمت مراجعة التماسك مسبقًا — اطّلع على الرد' }, { status: 409 })
    }

    await dbAny.examAttempt.update({
      where: { id: attempt.id },
      data: { appealStatus: 'PENDING', appealReason: String(reason).trim().slice(0, 2000), appealedAt: new Date() },
    })

    const assigned = await assignedSupervisorForStudent(user.id)
    if (assigned?.supervisorId) {
      await notify(assigned.supervisorId, 'GENERAL', 'التماس مراجعة جديد من طالبك', `${user.name} التمس مراجعة تصحيح «${attempt.exam.title}» (وحدة: ${attempt.exam.unit?.title || ''}) — الالتماس بانتظار بتّك في بوابتك.`, '/?view=supervisor')
    }
    await notifyAdmins('GENERAL', 'التماس مراجعة على امتحان وحدة', `${user.name} التمس مراجعة تصحيح «${attempt.exam.title}» — وُجّه لمشرفه البشري للبتّ.`, 'admin')

    return NextResponse.json({ ok: true })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'يجب تسجيل الدخول أولًا' }, { status: 401 })
    console.error('unit-exam appeal POST error:', e)
    return NextResponse.json({ error: 'تعذر تقديم الالتماس' }, { status: 500 })
  }
}

// GET /api/unit-exam/appeal?attemptId=xxx — حالة الالتماس + هل هو متاح أصلًا
export async function GET(req: NextRequest) {
  try {
    const user = await requireUser()
    const attemptId = req.nextUrl.searchParams.get('attemptId')
    if (!attemptId) return NextResponse.json({ error: 'معرف المحاولة مطلوب' }, { status: 400 })
    const dbAny = db as any
    const attempt: any = await dbAny.examAttempt.findUnique({
      where: { id: attemptId },
      select: { id: true, userId: true, score: true, passed: true, status: true, appealStatus: true, appealReason: true, appealResponse: true, appealedAt: true },
    })
    if (!attempt || attempt.userId !== user.id) {
      return NextResponse.json({ error: 'المحاولة غير موجودة' }, { status: 404 })
    }
    const hasSupervisor = await studentHasHumanSupervisor(user.id)
    return NextResponse.json({ appeal: attempt, canAppeal: hasSupervisor && attempt.status === 'GRADED' && (attempt.appealStatus ?? 'NONE') === 'NONE' })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'يجب تسجيل الدخول أولًا' }, { status: 401 })
    return NextResponse.json({ error: 'خطأ في تحميل حالة الالتماس' }, { status: 500 })
  }
}
