import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { getStudentFollowUpRecord, listFollowUpBoard } from '@/lib/student-follow-up'

export const runtime = 'nodejs'

// GET /api/admin/student-follow-up — لوحة متابعة الطلاب (واجبات كل طالب +
// حالة غيابه ومتابعته). ومع ?userId= يعيد سجل متابعات الطالب نفسه.
export async function GET(req: NextRequest) {
  try {
    await requireAdmin()
    const userId = req.nextUrl.searchParams.get('userId')
    if (userId) {
      const record = await getStudentFollowUpRecord(userId)
      return NextResponse.json({ ok: true, record })
    }
    const students = await listFollowUpBoard()
    return NextResponse.json({ ok: true, students })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ ok: false, error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('admin student follow-up error', e)
    return NextResponse.json({ ok: false, error: 'تعذر تحميل متابعة الطلاب' }, { status: 500 })
  }
}
