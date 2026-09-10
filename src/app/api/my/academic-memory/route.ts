import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { getStudentAcademicMemorySnapshot } from '@/lib/supervisor-ai'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const user = await requireUser()
    const memory = await getStudentAcademicMemorySnapshot(user.id)
    return NextResponse.json({ memory })
  } catch (e: any) {
    const status = e?.message === 'UNAUTHORIZED' ? 401 : 500
    return NextResponse.json({ error: status === 401 ? 'غير مصرح' : 'تعذر تحميل ذاكرة المشرف الأكاديمية' }, { status })
  }
}
