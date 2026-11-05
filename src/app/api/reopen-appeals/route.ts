import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { createReopenAppeal } from '@/lib/reopen-appeals'
import { assignedSupervisorForStudent } from '@/lib/supervisor-scope'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// التماس إعادة فتح تسليم (المرحلة 4) — نظام مستقل عن التماسات الدرجات.
// POST: الطالب يقدّم الالتماس لوحدة انتهت نافذتها ما دام فصلها قائمًا.
// GET: التماسات الطالب نفسه.
export async function POST(req: NextRequest) {
  try {
    const user = await requireUser()
    const body = await req.json().catch(() => ({}))
    const assigned = await assignedSupervisorForStudent(user.id).catch(() => null)
    const result = await createReopenAppeal(db, {
      userId: user.id,
      unitId: body?.unitId ? String(body.unitId) : null,
      programId: body?.programId ? String(body.programId) : null,
      semester: body?.semester != null ? Number(body.semester) : null,
      reason: String(body?.reason || ''),
      supervisorUserId: (assigned as any)?.supervisorId || null,
    })
    if (!result.ok) {
      const status = result.code === 'SEMESTER_CLOSED' || result.code === 'APPEAL_ALREADY_PENDING' ? 409 : result.code === 'ENROLLMENT_NOT_FOUND' || result.code === 'UNIT_NOT_FOUND' ? 404 : 400
      const messages: Record<string, string> = {
        SEMESTER_CLOSED: 'أُغلق الفصل واعتُمدت نتيجته؛ انتهت التماسات إعادة الفتح لهذا الفصل.',
        APPEAL_ALREADY_PENDING: 'لديك التماس إعادة فتح قيد البتّ لهذه الوحدة بالفعل.',
        ENROLLMENT_NOT_FOUND: 'لا تسجيل مطابقًا في هذا البرنامج.',
        UNIT_NOT_FOUND: 'الوحدة غير موجودة.',
        INVALID_INPUT: 'اكتب سبب الالتماس بوضوح وحدّد الوحدة أو الفصل.',
      }
      return NextResponse.json({ error: messages[result.code] || 'تعذر تقديم الالتماس', code: result.code }, { status })
    }
    return NextResponse.json({ ok: true, appeal: result.appeal })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'يجب تسجيل الدخول أولًا' }, { status: 401 })
    console.error('reopen-appeal POST error:', e)
    return NextResponse.json({ error: 'تعذر تقديم الالتماس' }, { status: 500 })
  }
}

export async function GET() {
  try {
    const user = await requireUser()
    const appeals = await (db as any).reopenAppeal.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }).catch(() => [])
    return NextResponse.json({ ok: true, appeals })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'يجب تسجيل الدخول أولًا' }, { status: 401 })
    return NextResponse.json({ error: 'تعذر تحميل الالتماسات' }, { status: 500 })
  }
}
