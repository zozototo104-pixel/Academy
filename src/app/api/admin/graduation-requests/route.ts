import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { audit, notify } from '@/lib/notify'
import { registerGraduationRequest } from '@/lib/enrollment-completion'

// معاملات التخرج: السجلّ المحفوظ الذي يوثّق فحص الأهلية والمصادقة الإدارية.
// لا يصدر أي مسار شهادة برنامج دون طلب بحالة APPROVED هنا، والإصدار نفسه
// يعيد فحص الشروط طازجة داخل معاملته قبل إنشاء الشهادة.

function snapshotOf(request: any) {
  const raw = request.snapshot
  if (raw && typeof raw === 'object') return raw
  try { return JSON.parse(String(raw || '{}')) } catch { return {} }
}

export async function GET(req: NextRequest) {
  try {
    await requireAdmin()
    const status = String(req.nextUrl.searchParams.get('status') || '').trim().toUpperCase()
    const where: any = status && ['PENDING', 'APPROVED', 'REJECTED', 'ISSUED'].includes(status) ? { status } : {}
    const requests = await db.graduationRequest.findMany({ where, orderBy: { updatedAt: 'desc' }, take: 200 })
    const userIds = [...new Set(requests.map((r) => r.userId))]
    const programIds = [...new Set(requests.map((r) => r.programId))]
    const admissionIds = [...new Set(requests.map((r) => r.admissionId).filter(Boolean) as string[])]
    const [users, programs, admissions]: [
      Array<{ id: string; name: string | null; email: string }>,
      Array<{ id: string; titleAr: string | null; titleEn: string | null }>,
      Array<{ id: string; fullName: string }>,
    ] = await Promise.all([
      userIds.length ? db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } }) : [],
      programIds.length ? db.program.findMany({ where: { id: { in: programIds } }, select: { id: true, titleAr: true, titleEn: true } }) : [],
      admissionIds.length ? db.admissionApplication.findMany({ where: { id: { in: admissionIds } }, select: { id: true, fullName: true } }) : [],
    ])
    const userById = new Map(users.map((u) => [u.id, u]))
    const programById = new Map(programs.map((p) => [p.id, p]))
    const admissionById = new Map(admissions.map((a) => [a.id, a]))
    return NextResponse.json({
      requests: requests.map((r) => ({
        id: r.id,
        enrollmentId: r.enrollmentId,
        userId: r.userId,
        programId: r.programId,
        admissionId: r.admissionId,
        status: r.status,
        ready: r.ready,
        score: r.score,
        snapshot: snapshotOf(r),
        decidedById: r.decidedById,
        decidedAt: r.decidedAt,
        decisionNote: r.decisionNote,
        certificateId: r.certificateId,
        issuedAt: r.issuedAt,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        studentName: admissionById.get(r.admissionId || '')?.fullName || userById.get(r.userId)?.name || null,
        studentEmail: userById.get(r.userId)?.email || null,
        programTitle: programById.get(r.programId)?.titleAr || programById.get(r.programId)?.titleEn || null,
      })),
    })
  } catch (error: any) {
    if (error?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('graduation requests list error:', error)
    return NextResponse.json({ error: 'تعذر جلب طلبات التخرج' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const body = await req.json().catch(() => ({}))
    const action = String(body?.action || '').trim().toUpperCase()

    if (action === 'REGISTER') {
      // إنشاء معاملة يدويًا لتسجيل قائم (مثلًا طالب أنهى متطلباته قبل
      // وجود هذا النظام ولم يعد يمرّ بحدث أكاديمي ينشئها تلقائيًا).
      const result = await registerGraduationRequest({
        enrollmentId: body?.enrollmentId || null,
        userId: body?.userId || null,
        programId: body?.programId || null,
        admissionId: body?.admissionId || null,
      })
      if (!result.registered && !result.requestId) {
        return NextResponse.json({ error: 'تعذر إنشاء معاملة التخرج لهذا التسجيل.', result }, { status: 422 })
      }
      await audit(admin, 'REGISTER_GRADUATION_REQUEST', 'GraduationRequest', result.requestId || null, 'إنشاء معاملة تخرج يدويًا من لوحة الإدارة')
      return NextResponse.json({ ok: true, result })
    }

    if (action !== 'APPROVE' && action !== 'REJECT' && action !== 'REFRESH') {
      return NextResponse.json({ error: 'إجراء غير معروف' }, { status: 400 })
    }
    const requestId = String(body?.requestId || '').trim()
    if (!requestId) return NextResponse.json({ error: 'رقم الطلب مطلوب' }, { status: 400 })
    const request = await db.graduationRequest.findUnique({ where: { id: requestId } })
    if (!request) return NextResponse.json({ error: 'طلب التخرج غير موجود' }, { status: 404 })
    if (request.status === 'ISSUED') {
      return NextResponse.json({ error: 'صُدّرت شهادة هذا الطلب من قبل — لا يمكن تغيير قراره.', code: 'ALREADY_ISSUED' }, { status: 409 })
    }
    const note = String(body?.note || '').trim().slice(0, 1000) || null

    // Academic-event callers intentionally swallow registration failures so a
    // saved grade is never rolled back. Administrative refresh/approval must
    // instead fail closed: no success toast or approval on an old snapshot.
    let fresh = request
    if (action === 'REFRESH' || action === 'APPROVE') {
      const refreshed = await registerGraduationRequest({ enrollmentId: request.enrollmentId })
      if (!refreshed.registered || refreshed.requestId !== requestId) {
        return NextResponse.json(
          { error: 'تعذر تحديث فحص معاملة التخرج؛ لم تُحفظ مصادقة جديدة. أعد المحاولة.', code: 'GRADUATION_REFRESH_FAILED' },
          { status: 503 },
        )
      }
      const current = await db.graduationRequest.findUnique({ where: { id: requestId } })
      if (!current || current.enrollmentId !== request.enrollmentId) {
        return NextResponse.json(
          { error: 'تعذر التحقق من معاملة التخرج بعد تحديث الفحص.', code: 'GRADUATION_REFRESH_FAILED' },
          { status: 503 },
        )
      }
      fresh = current
    }

    if (action === 'REFRESH') {
      await audit(admin, 'REFRESH_GRADUATION_REQUEST', 'GraduationRequest', requestId, 'تحديث فحص أهلية معاملة التخرج من لوحة الإدارة')
      return NextResponse.json({ ok: true, request: fresh })
    }

    if (action === 'APPROVE') {
      if (fresh.status === 'ISSUED') {
        return NextResponse.json({ error: 'صُدّرت شهادة هذا الطلب من قبل — لا يمكن تغيير قراره.', code: 'ALREADY_ISSUED' }, { status: 409 })
      }
      if (fresh.status !== 'PENDING' && fresh.status !== 'REJECTED') {
        return NextResponse.json({ error: 'حالة الطلب الحالية لا تسمح بالاعتماد.', code: 'INVALID_TRANSITION' }, { status: 409 })
      }
      // The stored readiness snapshot is informational; it must at least
      // be ready before approval. Issuance independently re-checks live facts.
      if (!fresh.ready) {
        return NextResponse.json({ error: 'لا يمكن مصادقة طلب تخرج غير مستوفٍ للشروط الحالية.', code: 'GRADUATION_NOT_READY' }, { status: 409 })
      }
      // Compare-and-set: a concurrent rejection/approval or readiness refresh
      // must never be overwritten by a decision based on an older snapshot.
      const decision = await db.graduationRequest.updateMany({
        where: { id: requestId, status: fresh.status, ready: true, score: fresh.score, updatedAt: fresh.updatedAt },
        data: { status: 'APPROVED', decidedById: admin.id, decidedAt: new Date(), decisionNote: note },
      })
      if (decision.count !== 1) {
        return NextResponse.json({ error: 'تغيّرت حالة طلب التخرج أثناء اعتماد القرار. حدّث القائمة وأعد المحاولة.', code: 'GRADUATION_DECISION_CONFLICT' }, { status: 409 })
      }
      const updated = await db.graduationRequest.findUnique({ where: { id: requestId } })
      await audit(admin, 'APPROVE_GRADUATION_REQUEST', 'GraduationRequest', requestId, `اعتماد طلب تخرج الطالب ${fresh.userId} — الإصدار ما زال مشروطًا بإعادة فحص الشروط وقت التنفيذ`)
      return NextResponse.json({ ok: true, request: updated })
    }

    if (request.status !== 'PENDING' && request.status !== 'APPROVED') {
      return NextResponse.json({ error: 'حالة الطلب الحالية لا تسمح بالرفض.', code: 'INVALID_TRANSITION' }, { status: 409 })
    }
    const decision = await db.graduationRequest.updateMany({
      where: { id: requestId, status: request.status, updatedAt: request.updatedAt },
      data: { status: 'REJECTED', decidedById: admin.id, decidedAt: new Date(), decisionNote: note },
    })
    if (decision.count !== 1) {
      return NextResponse.json({ error: 'تغيّرت حالة طلب التخرج أثناء تسجيل الرفض. حدّث القائمة وأعد المحاولة.', code: 'GRADUATION_DECISION_CONFLICT' }, { status: 409 })
    }
    const updated = await db.graduationRequest.findUnique({ where: { id: requestId } })
    await audit(admin, 'REJECT_GRADUATION_REQUEST', 'GraduationRequest', requestId, `رفض طلب تخرج الطالب ${request.userId}${note ? ` — ${note}` : ''}`)
    await notify(
      request.userId,
      'GENERAL',
      'قرار طلب التخرج',
      `راجعت الإدارة طلب تخرجك وقررت عدم اعتماده حاليًا.${note ? ` السبب: ${note}` : ''} عند استكمال المتطلبات ستُحدّث معاملتك ويمكن للإدارة اعتمادها.`,
      '/?view=dashboard',
    ).catch(() => null)
    return NextResponse.json({ ok: true, request: updated })
  } catch (error: any) {
    if (error?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('graduation request decision error:', error)
    return NextResponse.json({ error: 'تعذر تنفيذ قرار طلب التخرج' }, { status: 500 })
  }
}
