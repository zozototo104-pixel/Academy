import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import {
  SEMESTER_APPROVAL_ACTIVE,
  approveSemesterResult,
  collectSemesterApprovalBlockers,
  evaluateContextualFinality,
  storedSemesterApproval,
} from '@/lib/semester-approval'
import { calculateSemesterAverages } from '@/lib/semester-grade'
import { readEnrollmentSnapshot } from '@/lib/rules-snapshot'
import { getSemesterStanding } from '@/lib/student-standing'
import { summarizeSemesterDecision } from '@/lib/semester-decision'

// اعتماد نتيجة الفصل بيد الإدارة (المرحلة 2 من خطة دورة التخرج).
// GET يعرض بيانات شاشة المصادقة: موانع الاعتماد الحالية + الاعتماد المحفوظ
// إن وجد + هل الاعتماد مفعّل أصلًا. POST هو إجراء القرار نفسه عبر الحارس
// الخادمي approveSemesterResult — وفي هذه المرحلة يرفض الحارسُ الاعتمادَ
// النهائي بقرار الترتيب (SEMESTER_APPROVAL_NOT_ACTIVE) حتى يكتمل حساب
// معدلات الفصول (المرحلة 3) ودورة حياة الفصل (المرحلة 4)، والرفض يصدر من
// هذا المسار نفسه عند أي استدعاء مباشر، لا من إخفاء زر.

export async function GET(req: NextRequest) {
  try {
    await requireAdmin()
    const sp = req.nextUrl.searchParams
    const enrollmentId = String(sp.get('enrollmentId') || '').trim()
    const semester = Number(sp.get('semester') || '')
    if (!enrollmentId || !Number.isInteger(semester) || semester < 1) {
      return NextResponse.json({ ok: false, code: 'INVALID_QUERY' }, { status: 400 })
    }
    const enrollment = await db.enrollment.findUnique({
      where: { id: enrollmentId },
      select: {
        id: true,
        userId: true,
        programId: true,
        createdAt: true,
        status: true,
        extensionDays: true,
        program: { select: { category: true, maxStudyDays: true, semestersCount: true } },
      },
    })
    if (!enrollment) {
      return NextResponse.json({ ok: false, code: 'ENROLLMENT_NOT_FOUND' }, { status: 404 })
    }
    const [blockers, approval] = await Promise.all([
      collectSemesterApprovalBlockers(db, {
        userId: enrollment.userId,
        programId: enrollment.programId,
        semester,
      }),
      storedSemesterApproval(db, enrollmentId, semester),
    ])
    // معدلات الفصول المحسوبة من الخادم (المرحلة 3): قيم قرار معروضة بجانب
    // الشروط — معدل كل فصل والمعدل النهائي المركّب. دفاعي: أي فشل في
    // الحساب لا يُسقط بيانات الشروط.
    let averages: Awaited<ReturnType<typeof calculateSemesterAverages>> | null = null
    try {
      averages = await calculateSemesterAverages({
        userId: enrollment.userId,
        programId: enrollment.programId,
      })
    } catch {
      averages = null
    }
    // لقطة القواعد المجمّدة لهذا الالتحاق (المرحلة 3): إثبات مرئي أن
    // المعدلات المعروضة محسوبة من قواعد الطالب المجمّدة لا من إعدادات
    // البرنامج الحالية.
    let snapshot: { basis: string; capturedAt: unknown; weightSource: string } | null = null
    try {
      const snap = await readEnrollmentSnapshot(db, enrollmentId)
      if (snap) snapshot = { basis: snap.basis, capturedAt: snap.capturedAt, weightSource: snap.weightSource }
    } catch {
      snapshot = null
    }
    // كشف وضع الطالب في هذا الفصل (قرار المالك 2026-11-08): وقائع
    // التقديم والمواعيد التي يحتاجها قرار الاعتماد — ما قُدّم وما لم
    // يُقدَّم بالأسماء، جلسة امتحان الفصل، نوافذ الوحدات، ومهلة
    // التسجيل. قراءة فقط من lib/student-standing؛ دفاعي كالمعدلات:
    // أي فشل لا يُسقط بيانات الشروط.
    let standing: Awaited<ReturnType<typeof getSemesterStanding>> | null = null
    try {
      standing = await getSemesterStanding(db, {
        userId: enrollment.userId,
        programId: enrollment.programId,
        enrollment: {
          createdAt: enrollment.createdAt,
          status: enrollment.status,
          extensionDays: enrollment.extensionDays,
        },
        program: enrollment.program,
        semester,
      })
    } catch {
      standing = null
    }
    // قرار الطالب وحق الإغلاق (سجل القرار): تعرضه الشاشة من نفس مصدر
    // حارس الخادم — حالة الرفع، نهاية فترة الفصل، وهل الاعتماد مشروع
    // الآن ولماذا. دفاعي كالباقي: أي فشل لا يُسقط بيانات الشروط.
    let decisionSummary: Awaited<ReturnType<typeof summarizeSemesterDecision>> | null = null
    try {
      decisionSummary = await summarizeSemesterDecision(db, {
        enrollmentId,
        programId: enrollment.programId,
        enrollmentCreatedAt: enrollment.createdAt,
        extensionDays: enrollment.extensionDays,
        program: enrollment.program,
        semester,
      })
    } catch {
      decisionSummary = null
    }
    // Use the SAME grading-finality rule as approveSemesterResult.
    // An empty blocker list alone does not prove completion: omissions
    // are final zeros only after the right to close is established.
    const entry = averages?.semesters.find((s) => s.semester === semester)
    const closureAllowed = Boolean(approval || decisionSummary?.closure.allowed)
    let gradesFinal = entry?.gradesComplete === true
    if (!gradesFinal && entry && closureAllowed && blockers.length === 0) {
      try {
        gradesFinal = (await evaluateContextualFinality(db, {
          userId: enrollment.userId,
          programId: enrollment.programId,
          semester,
          entry,
        })).final
      } catch {
        gradesFinal = false
      }
    }
    const canApprove = Boolean(
      SEMESTER_APPROVAL_ACTIVE &&
      blockers.length === 0 &&
      closureAllowed &&
      entry?.average != null &&
      gradesFinal,
    )
    return NextResponse.json({
      ok: true,
      enrollmentId,
      semester,
      approvalActive: SEMESTER_APPROVAL_ACTIVE,
      canApprove,
      blockers,
      approval,
      averages,
      snapshot,
      standing,
      decisionSummary,
    })
  } catch (error: any) {
    if (error?.message === 'UNAUTHORIZED') return NextResponse.json({ ok: false, code: 'UNAUTHORIZED' }, { status: 401 })
    if (error?.message === 'FORBIDDEN') return NextResponse.json({ ok: false, code: 'FORBIDDEN' }, { status: 403 })
    console.error('semester-approval check failed:', error)
    return NextResponse.json({ ok: false, code: 'SEMESTER_CHECK_FAILED', error: 'تعذر قراءة بيانات اعتماد الفصل' }, { status: 503 })
  }
}

const STATUS_BY_CODE: Record<string, number> = {
  INVALID_SEMESTER_APPROVAL_INPUT: 400,
  ENROLLMENT_NOT_FOUND: 404,
  SEMESTER_GRADES_INCOMPLETE: 409,
  SEMESTER_NOT_RAISED: 409,
  SEMESTER_APPROVAL_NOT_ACTIVE: 409,
  SEMESTER_APPROVAL_FORBIDDEN: 403,
  SEMESTER_SCORE_NOT_VERIFIED: 409,
}

const ERROR_BY_CODE: Record<string, string> = {
  INVALID_SEMESTER_APPROVAL_INPUT: 'طلب اعتماد غير صالح',
  ENROLLMENT_NOT_FOUND: 'التسجيل غير موجود',
  SEMESTER_GRADES_INCOMPLETE: 'توجد في هذا الفصل درجات غير مكتملة أو غير معتمدة أو إجراءات مفتوحة تمنع الاعتماد',
  SEMESTER_NOT_RAISED: 'لا يمكن اعتماد هذا الفصل الآن: فترته ما زالت مفتوحة والطالب لم يرفع نتيجته للاعتماد بعد — الاعتماد يتم بطلب الطالب أو عند انتهاء فترة الفصل',
  SEMESTER_APPROVAL_NOT_ACTIVE: 'اعتماد نتيجة الفصل النهائي غير مفعّل بعد — يُفعَّل بعد اكتمال حساب معدلات الفصول ودورة حياة الفصل',
  SEMESTER_APPROVAL_FORBIDDEN: 'قرار اعتماد نتيجة الفصل للإدارة فقط',
  SEMESTER_SCORE_NOT_VERIFIED: 'الدرجة الرسمية للفصل غير متاحة بعد — لا تُقبل درجة مرسلة يدويًا',
}

export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const body = (await req.json().catch(() => null)) as {
      enrollmentId?: string
      semester?: number
      score?: number | null
      note?: string | null
    } | null
    const result = await approveSemesterResult({
      enrollmentId: String(body?.enrollmentId || ''),
      semester: Number(body?.semester || 0),
      actor: { id: admin.id },
      score: body?.score ?? null,
      note: body?.note ?? null,
    })
    if (!result.ok) {
      return NextResponse.json(
        { ok: false, code: result.code, error: ERROR_BY_CODE[result.code] || 'تعذر اعتماد نتيجة الفصل', blockers: result.blockers ?? [] },
        { status: STATUS_BY_CODE[result.code] ?? 400 },
      )
    }
    return NextResponse.json({ ok: true, approval: result.approval })
  } catch (error: any) {
    if (error?.message === 'UNAUTHORIZED') return NextResponse.json({ ok: false, code: 'UNAUTHORIZED' }, { status: 401 })
    if (error?.message === 'FORBIDDEN') return NextResponse.json({ ok: false, code: 'FORBIDDEN' }, { status: 403 })
    console.error('semester-approval decision failed:', error)
    return NextResponse.json({ ok: false, code: 'SEMESTER_DECISION_FAILED', error: 'تعذر اعتماد نتيجة الفصل بسبب خطأ خادمي' }, { status: 503 })
  }
}
