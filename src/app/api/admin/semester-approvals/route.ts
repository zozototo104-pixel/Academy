import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import {
  SEMESTER_APPROVAL_ACTIVE,
  approveSemesterResult,
  collectSemesterApprovalBlockers,
  storedSemesterApproval,
} from '@/lib/semester-approval'

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
      select: { id: true, userId: true, programId: true },
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
    return NextResponse.json({
      ok: true,
      enrollmentId,
      semester,
      approvalActive: SEMESTER_APPROVAL_ACTIVE,
      blockers,
      approval,
    })
  } catch {
    return NextResponse.json({ ok: false, code: 'UNAUTHORIZED' }, { status: 401 })
  }
}

const STATUS_BY_CODE: Record<string, number> = {
  INVALID_SEMESTER_APPROVAL_INPUT: 400,
  ENROLLMENT_NOT_FOUND: 404,
  SEMESTER_GRADES_INCOMPLETE: 409,
  SEMESTER_APPROVAL_NOT_ACTIVE: 409,
  SEMESTER_APPROVAL_FORBIDDEN: 403,
  SEMESTER_SCORE_NOT_VERIFIED: 409,
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
        { ok: false, code: result.code, blockers: result.blockers ?? [] },
        { status: STATUS_BY_CODE[result.code] ?? 400 },
      )
    }
    return NextResponse.json({ ok: true, approval: result.approval })
  } catch {
    return NextResponse.json({ ok: false, code: 'UNAUTHORIZED' }, { status: 401 })
  }
}
