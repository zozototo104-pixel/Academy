import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { approveGrade, type GradeTargetType } from '@/lib/grade-approval'

// اعتماد الدرجات بيد الإدارة (المرحلة 2 من خطة دورة التخرج): صلاحية أصلية
// كاملة بالتوازي مع المشرف — الإدارة تعتمد درجة أي طالب، بوجود مشرف مُسند
// له أو بغيابه. الاعتماد سجل محفوظ (مَن ومتى والقيمة) عبر approveGrade،
// وصلاحيته مشروطة ببقاء درجة المحاولة الحالية مساوية للدرجة المعتمدة.

const STATUS_BY_CODE: Record<string, number> = {
  INVALID_GRADE_APPROVAL_INPUT: 400,
  ATTEMPT_NOT_FOUND: 404,
  GRADE_NOT_FINAL: 409,
  GRADE_APPROVAL_FORBIDDEN: 403,
}

const ERROR_BY_CODE: Record<string, string> = {
  INVALID_GRADE_APPROVAL_INPUT: 'طلب اعتماد غير صالح',
  ATTEMPT_NOT_FOUND: 'المحاولة غير موجودة',
  GRADE_NOT_FINAL: 'الدرجة ليست نهائية بعد — إما قيد التصحيح أو المراجعة، أو عليها التماس معلّق، أو فيها إجابات بلا نقاط',
  GRADE_APPROVAL_FORBIDDEN: 'لا تملك صلاحية اعتماد هذه الدرجة',
}

export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const body = (await req.json().catch(() => null)) as {
      targetType?: string
      attemptId?: string
      note?: string
    } | null
    const result = await approveGrade({
      targetType: String(body?.targetType || '') as GradeTargetType,
      attemptId: String(body?.attemptId || ''),
      actor: { id: admin.id, name: admin.name ?? '' },
      note: body?.note,
    })
    if (!result.ok) {
      return NextResponse.json(
        { ok: false, code: result.code, error: ERROR_BY_CODE[result.code] || 'تعذر اعتماد الدرجة' },
        { status: STATUS_BY_CODE[result.code] ?? 400 },
      )
    }
    return NextResponse.json({ ok: true, approval: result.approval })
  } catch {
    return NextResponse.json({ ok: false, code: 'UNAUTHORIZED' }, { status: 401 })
  }
}

// قائمة اعتمادات درجات طالب في برنامج وفصل — بيانات شاشة المصادقة.
export async function GET(req: NextRequest) {
  try {
    await requireAdmin()
    const sp = req.nextUrl.searchParams
    const userId = String(sp.get('userId') || '').trim()
    const programId = String(sp.get('programId') || '').trim()
    const semester = Number(sp.get('semester') || '')
    if (!userId || !programId || !Number.isInteger(semester)) {
      return NextResponse.json({ ok: false, code: 'INVALID_QUERY' }, { status: 400 })
    }
    const approvals = await db.gradeApproval.findMany({
      where: { userId, programId, semester },
      orderBy: { approvedAt: 'desc' },
    })
    return NextResponse.json({ ok: true, approvals })
  } catch {
    return NextResponse.json({ ok: false, code: 'UNAUTHORIZED' }, { status: 401 })
  }
}
