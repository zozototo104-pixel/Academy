import { NextRequest, NextResponse } from 'next/server'
import { requireSupervisor } from '@/lib/supervisor-scope'
import { approveGrade, type GradeTargetType } from '@/lib/grade-approval'

// اعتماد الدرجات بيد المشرف البشري (المرحلة 2 من خطة دورة التخرج): المشرف
// يعتمد درجات طلابه هو فقط — النطاق تفرضه approveGrade نفسها خادميًا
// (التعيين مصدره طلبات الالتحاق)، فطلب اعتماد درجة طالب غيره يُرفض
// GRADE_APPROVAL_FORBIDDEN من المكتبة لا من الواجهة.

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
  GRADE_APPROVAL_FORBIDDEN: 'هذه الدرجة ليست ضمن طلابك',
}

export async function POST(req: NextRequest) {
  try {
    const actor = await requireSupervisor()
    const body = (await req.json().catch(() => null)) as {
      targetType?: string
      attemptId?: string
      note?: string
    } | null
    const result = await approveGrade({
      targetType: String(body?.targetType || '') as GradeTargetType,
      attemptId: String(body?.attemptId || ''),
      actor: { id: actor.id, name: actor.name ?? '' },
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
