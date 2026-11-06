import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireSupervisor } from '@/lib/supervisor-scope'
import { assignMercyActivity, gradeMercyActivity } from '@/lib/mercy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// استرحام طلاب المشرف (المرحلة 4): إسناد وتصحيح ضمن نطاق طلابه فقط —
// النطاق تفرضه المكتبة بإعادة فحص الإسناد، لا الواجهة.
export async function GET() {
  try {
    const supervisor = await requireSupervisor()
    const dbAny = db as any
    const applications = await dbAny.admissionApplication.findMany({
      where: { supervisorId: supervisor.id, userId: { not: null }, programId: { not: null } },
      select: { userId: true, programId: true },
    }).catch(() => [])
    // Scope each mercy request to the same student AND programme assignment.
    // Independent userId/programId lists would allow cross-product leakage.
    const assignedPairs = (applications as any[])
      .filter((a) => a.userId && a.programId)
      .map((a) => ({ userId: a.userId, programId: a.programId }))
    const requests = assignedPairs.length
      ? await dbAny.mercyRequest.findMany({ where: { OR: assignedPairs }, orderBy: { createdAt: 'desc' } }).catch(() => [])
      : []
    return NextResponse.json({ ok: true, requests })
  } catch {
    return NextResponse.json({ error: 'صلاحية مشرف مطلوبة' }, { status: 403 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const supervisor = await requireSupervisor()
    const body = await req.json().catch(() => ({}))
    const action = String(body?.action || '')
    let result: any
    if (action === 'assign') {
      result = await assignMercyActivity(db, {
        mercyId: String(body?.mercyId || ''),
        actor: { id: supervisor.id },
        title: String(body?.title || ''),
        instructions: body?.instructions ? String(body.instructions) : null,
        weightPercent: Number(body?.weightPercent),
        dueAt: body?.dueAt ? String(body.dueAt) : null,
      })
    } else if (action === 'grade') {
      result = await gradeMercyActivity(db, {
        mercyId: String(body?.mercyId || ''),
        actor: { id: supervisor.id },
        score: Number(body?.score),
      })
    } else {
      return NextResponse.json({ error: 'إجراء غير معروف', code: 'INVALID_INPUT' }, { status: 400 })
    }
    if (!result.ok) {
      const messages: Record<string, string> = {
        MERCY_DEADLINE_TOO_LONG: 'مهلة النشاط لا تتجاوز 7 أيام تقويمية من الإسناد.',
        MERCY_WEIGHT_INVALID: 'وزن النشاط بين 1 و50 بالمئة من معدل الفصل.',
        MERCY_WRONG_STATE: 'حالة الطلب لا تسمح بهذا الإجراء الآن.',
        MERCY_NOT_FOUND: 'الطلب غير موجود.',
        FORBIDDEN: 'هذا الطالب ليس من طلابك.',
        INVALID_INPUT: 'بيانات ناقصة أو غير صالحة.',
      }
      const status = result.code === 'MERCY_NOT_FOUND' ? 404 : result.code === 'FORBIDDEN' ? 403 : 409
      return NextResponse.json({ error: messages[result.code] || 'تعذر تنفيذ الإجراء', code: result.code }, { status })
    }
    return NextResponse.json({ ok: true, mercy: result.mercy })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED' || e?.message === 'FORBIDDEN') return NextResponse.json({ error: 'صلاحية مشرف مطلوبة' }, { status: 403 })
    console.error('supervisor mercy POST error:', e)
    return NextResponse.json({ error: 'تعذر تنفيذ الإجراء' }, { status: 500 })
  }
}
