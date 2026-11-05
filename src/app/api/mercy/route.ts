import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { requestMercy } from '@/lib/mercy'
import { assignedSupervisorForStudent } from '@/lib/supervisor-scope'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// استرحام الطالب (المرحلة 4): طلب لفصل مغلق بنتيجة راسب معتمدة فقط.
// GET يعرض فصول الطالب المغلقة الراسبة + طلباته (لعرض زر الطلب).
export async function POST(req: NextRequest) {
  try {
    const user = await requireUser()
    const body = await req.json().catch(() => ({}))
    const assigned = await assignedSupervisorForStudent(user.id).catch(() => null)
    const result = await requestMercy(db, {
      userId: user.id,
      programId: String(body?.programId || ''),
      semester: Number(body?.semester),
      supervisorUserId: (assigned as any)?.supervisorId || null,
    })
    if (!result.ok) {
      const messages: Record<string, string> = {
        SEMESTER_NOT_FAILED: 'الاسترحام متاح فقط لفصل أُغلق بنتيجة راسب معتمدة.',
        MERCY_ALREADY_EXISTS: 'سبق أن استُخدم مسار الاسترحام لهذا الفصل.',
        ENROLLMENT_NOT_FOUND: 'لا تسجيل مطابقًا في هذا البرنامج.',
        INVALID_INPUT: 'بيانات الطلب ناقصة.',
      }
      const status = result.code === 'ENROLLMENT_NOT_FOUND' ? 404 : result.code === 'MERCY_ALREADY_EXISTS' ? 409 : 400
      return NextResponse.json({ error: messages[result.code] || 'تعذر تقديم الطلب', code: result.code }, { status })
    }
    return NextResponse.json({ ok: true, mercy: result.mercy })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'يجب تسجيل الدخول أولًا' }, { status: 401 })
    console.error('mercy POST error:', e)
    return NextResponse.json({ error: 'تعذر تقديم الطلب' }, { status: 500 })
  }
}

export async function GET() {
  try {
    const user = await requireUser()
    const dbAny = db as any
    const requests = await dbAny.mercyRequest.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
    }).catch(() => [])
    const enrollments = await db.enrollment.findMany({
      where: { userId: user.id },
      select: { id: true, programId: true },
    }).catch(() => [])
    const eligible: { enrollmentId: string; programId: string; semester: number }[] = []
    for (const enr of enrollments as any[]) {
      const states = await dbAny.enrollmentSemesterState.findMany({
        where: { enrollmentId: enr.id, status: 'CLOSED', result: 'FAILED' },
        select: { semester: true },
      }).catch(() => [])
      for (const s of states as any[]) {
        if (!(requests as any[]).some((r) => r.enrollmentId === enr.id && r.semester === s.semester)) {
          eligible.push({ enrollmentId: enr.id, programId: enr.programId, semester: s.semester })
        }
      }
    }
    return NextResponse.json({ ok: true, requests, eligible })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'يجب تسجيل الدخول أولًا' }, { status: 401 })
    return NextResponse.json({ error: 'تعذر تحميل بيانات الاسترحام' }, { status: 500 })
  }
}
