import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'
import { audit } from '@/lib/notify'
import { analyzeAdmission } from '@/lib/admission-ai'

// POST /api/admin/admissions/ai-review — تحليل ذكي لطلب التحاق قبل قرار الإدارة
// خبير الذكاء الاصطناعي يقرأ مدخلات الطالب ومرفقاته ويقارنها بمتطلبات البرنامج
// (مثال: شهادة الثانوية للدبلوم، الماجستير المهني أو الأكاديمي للدكتوراة) ويفحص منطقية البيانات
export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser()
    if (!user || user.role !== 'ADMIN') {
      return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    }
    const { id, force } = await req.json()
    if (!id) return NextResponse.json({ error: 'معرف الطلب مطلوب' }, { status: 400 })

    const app = await db.admissionApplication.findUnique({ where: { id }, select: { id: true, reference: true, fullName: true } })
    if (!app) return NextResponse.json({ error: 'الطلب غير موجود' }, { status: 404 })

    const { review, cached } = await analyzeAdmission(id, { force: !!force })

    if (!cached) {
      await audit(user, 'AI_ADMISSION_REVIEW', 'AdmissionApplication', id, `تقييم ذكي للطلب ${app.reference} (${app.fullName}) — الحكم: ${review.verdict} (${review.fitScore}%)`)
    }
    return NextResponse.json({ review, cached })
  } catch (e: any) {
    console.error('ai-review error:', e)
    return NextResponse.json({ error: e?.message || 'تعذر تشغيل التحليل الذكي' }, { status: 500 })
  }
}
