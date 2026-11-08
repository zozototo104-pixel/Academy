import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { audit, notify } from '@/lib/notify'
import { registerGraduationRequest } from '@/lib/enrollment-completion'
import { SEMESTER_DECISION_ACTIVE, isGraduationRaiseEligible, lockSemesterDecision, raiseGateOf, type RaiseGate } from '@/lib/semester-decision'
import { getSemesterWindows } from '@/lib/semester-lifecycle'

// معاملات التخرج: السجلّ المحفوظ الذي يوثّق فحص الأهلية والمصادقة الإدارية.
// لا يصدر أي مسار شهادة برنامج دون طلب بحالة APPROVED هنا، والإصدار نفسه
// يعيد فحص الشروط طازجة داخل معاملته قبل إنشاء الشهادة.

function snapshotOf(request: any) {
  const raw = request.snapshot
  if (raw && typeof raw === 'object') return raw
  try { return JSON.parse(String(raw || '{}')) } catch { return {} }
}

// Read the last semester's actual raise right from the server. A stored
// eligibility snapshot alone must never authorize administrative approval.
async function liveGraduationRaiseGate(
  client: Pick<typeof db, 'enrollment' | 'unit' | 'semesterDecision'>,
  enrollmentId: string,
): Promise<{ gate: RaiseGate | null; semester: number | null }> {
  const enrollment = await client.enrollment.findUnique({
    where: { id: enrollmentId },
    select: {
      createdAt: true,
      extensionDays: true,
      programId: true,
      program: { select: { category: true, maxStudyDays: true, semestersCount: true } },
    },
  })
  if (!enrollment?.program) return { gate: null, semester: null }
  const units = await client.unit.findMany({
    where: { programId: enrollment.programId },
    select: { id: true, semester: true, order: true },
  })
  const windows = getSemesterWindows(
    new Date(enrollment.createdAt),
    enrollment.program,
    units,
    enrollment.extensionDays ?? 0,
  )
  const last = windows[windows.length - 1]
  if (!last) return { gate: null, semester: null }
  const decision = await client.semesterDecision.findUnique({
    where: { enrollmentId_semester: { enrollmentId, semester: last.semester } },
    select: { status: true },
  })
  return {
    gate: raiseGateOf(decision, Date.now() > last.endAt.getTime()),
    semester: last.semester,
  }
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
    // بوابة رفع الطالب لكل معاملة (الخطوة 5): أين يقف ملفه بالنسبة
    // لرفعه هو — تُحسب دفعة واحدة من سجلات القرار ونوافذ الفصول،
    // ودفاعيًا: أي غياب يترك البوابة فارغة ولا يُسقط القائمة.
    const gateByEnrollment = new Map<string, RaiseGate>()
    if (SEMESTER_DECISION_ACTIVE && requests.length) {
      try {
        const enrollmentIds = [...new Set(requests.map((r) => r.enrollmentId))]
        const [enrollments, programRows, units, decisions]: [any[], any[], any[], any[]] = await Promise.all([
          db.enrollment.findMany({ where: { id: { in: enrollmentIds } }, select: { id: true, programId: true, createdAt: true, extensionDays: true } }),
          db.program.findMany({ where: { id: { in: programIds } }, select: { id: true, category: true, maxStudyDays: true, semestersCount: true } }),
          db.unit.findMany({ where: { programId: { in: programIds } }, select: { id: true, programId: true, semester: true, order: true } }),
          (db as any).semesterDecision?.findMany
            ? (db as any).semesterDecision.findMany({ where: { enrollmentId: { in: enrollmentIds } } })
            : Promise.resolve([]),
        ])
        const enrollmentById = new Map(enrollments.map((e) => [e.id, e]))
        const gateProgramById = new Map(programRows.map((p) => [p.id, p]))
        const unitsByProgram = new Map<string, { id: string; semester: number; order: number }[]>()
        for (const u of units) {
          const list = unitsByProgram.get(u.programId) || []
          list.push({ id: u.id, semester: u.semester ?? 1, order: u.order ?? 0 })
          unitsByProgram.set(u.programId, list)
        }
        const decisionByKey = new Map(decisions.map((d) => [`${d.enrollmentId}:${d.semester}`, d]))
        const nowMs = Date.now()
        for (const r of requests) {
          const enr = enrollmentById.get(r.enrollmentId)
          const prog = gateProgramById.get(r.programId)
          if (!enr || !prog) continue
          const windows = getSemesterWindows(new Date(enr.createdAt), prog, unitsByProgram.get(r.programId) || [], enr.extensionDays ?? 0)
          if (!windows.length) continue
          const last = windows[windows.length - 1]
          const decision = decisionByKey.get(`${r.enrollmentId}:${last.semester}`) ?? null
          gateByEnrollment.set(r.enrollmentId, raiseGateOf(decision, nowMs > last.endAt.getTime()))
        }
      } catch (error) {
        // A failed raise scan must never expose unraised drafts as
        // actionable graduation files or silently hide legitimate ones.
        console.error('graduation raise-gate read error:', error)
        throw error
      }
    }
    const admissionById = new Map(admissions.map((a) => [a.id, a]))
    // Keep live eligibility records in the DB; the admin graduation
    // decisions list includes PENDING only once the student has raised
    // the last semester or its legal window has ended. Historical
    // APPROVED/REJECTED/ISSUED records remain visible for audit.
    const actionableRequests = requests.filter((r) =>
      !SEMESTER_DECISION_ACTIVE || r.status !== 'PENDING' ||
      isGraduationRaiseEligible(gateByEnrollment.get(r.enrollmentId)),
    )
    return NextResponse.json({
      requests: actionableRequests.map((r) => ({
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
        raiseGate: gateByEnrollment.get(r.enrollmentId) ?? null,
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
      // Protect the graduation decision against withdrawing a student
      // raise concurrently. Use the SAME pair lock as the student and
      // the semester-approval route, and re-read the gate under it.
      const approvalWrite = {
        where: { id: requestId, status: fresh.status, ready: true, score: fresh.score, updatedAt: fresh.updatedAt },
        data: { status: 'APPROVED' as const, decidedById: admin.id, decidedAt: new Date(), decisionNote: note },
      }
      const decision = SEMESTER_DECISION_ACTIVE
        ? await db.$transaction(async (tx) => {
            const initial = await liveGraduationRaiseGate(tx, fresh.enrollmentId)
            if (initial.semester == null) return { count: 0, raiseNotAllowed: true }
            await lockSemesterDecision(tx, fresh.enrollmentId, initial.semester)
            const live = await liveGraduationRaiseGate(tx, fresh.enrollmentId)
            if (live.semester !== initial.semester || !isGraduationRaiseEligible(live.gate)) {
              return { count: 0, raiseNotAllowed: true }
            }
            const updated = await tx.graduationRequest.updateMany(approvalWrite)
            return { count: updated.count, raiseNotAllowed: false }
          })
        : { ...(await db.graduationRequest.updateMany(approvalWrite)), raiseNotAllowed: false }
      if (decision.raiseNotAllowed) {
        return NextResponse.json({
          error: 'لا يجوز اعتماد معاملة تخرج قبل رفع الطالب فصله الأخير أو انتهاء مدته النظامية.',
          code: 'GRADUATION_NOT_RAISED',
        }, { status: 409 })
      }
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
