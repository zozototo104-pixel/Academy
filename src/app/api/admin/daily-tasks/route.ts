import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'

export const runtime = 'nodejs'

export async function GET() {
  try {
    await requireAdmin()
    const [
      admissions,
      pendingPayments,
      assignmentSubmissions,
      thesisTopicRequests,
      planReviews,
      finalReviews,
      scheduledDefenses,
      problemStudents,
    ] = await Promise.all([
      db.admissionApplication.findMany({
        where: { status: { in: ['PENDING', 'SUBMITTED', 'UNDER_REVIEW'] } },
        orderBy: { createdAt: 'asc' },
        take: 20,
        select: { id: true, reference: true, fullName: true, email: true, status: true, program: true, createdAt: true, programRef: { select: { titleAr: true } } },
      }),
      db.payment.findMany({
        where: { status: { in: ['PENDING', 'REVIEW', 'AWAITING_REVIEW'] } },
        orderBy: { createdAt: 'asc' },
        take: 20,
        select: { id: true, invoiceNo: true, amount: true, status: true, purpose: true, user: { select: { name: true, email: true } }, createdAt: true },
      }),
      db.assignmentSubmission.findMany({
        where: { status: { in: ['SUBMITTED', 'NEEDS_REVIEW'] } },
        orderBy: { submittedAt: 'asc' },
        take: 20,
        select: { id: true, status: true, submittedAt: true, user: { select: { name: true, email: true } }, assignment: { select: { title: true, program: { select: { titleAr: true } } } } },
      }),
      db.thesisTopicRequest.findMany({
        where: { status: { in: ['PENDING', 'NEEDS_REVISION'] } },
        orderBy: { createdAt: 'asc' },
        take: 20,
        select: { id: true, proposedTitle: true, status: true, createdAt: true, user: { select: { name: true, email: true } }, program: { select: { titleAr: true } } },
      }),
      db.thesisSubmission.findMany({
        where: { status: 'PLAN_SUBMITTED' },
        orderBy: { updatedAt: 'asc' },
        take: 20,
        select: { id: true, title: true, status: true, updatedAt: true, user: { select: { name: true, email: true } } },
      }),
      db.thesisSubmission.findMany({
        where: { status: 'SUBMITTED' },
        orderBy: { updatedAt: 'asc' },
        take: 20,
        select: { id: true, title: true, status: true, updatedAt: true, user: { select: { name: true, email: true } } },
      }),
      db.thesisSubmission.findMany({
        where: { status: 'SCHEDULED' },
        orderBy: { defenseDate: 'asc' },
        take: 20,
        select: { id: true, title: true, defenseDate: true, defenseStatus: true, user: { select: { name: true, email: true } } },
      }),
      db.user.findMany({
        where: { role: 'STUDENT', status: { in: ['DISABLED', 'ARCHIVED'] } },
        orderBy: { updatedAt: 'desc' },
        take: 20,
        select: { id: true, name: true, email: true, status: true, updatedAt: true },
      }),
    ])

    const groups = [
      { key: 'admissions', title: 'طلبات التحاق جديدة', count: admissions.length, items: admissions.map((x) => ({ id: x.id, title: `${x.fullName} · ${x.reference || '-'}`, subtitle: x.programRef?.titleAr || x.program || x.email, status: x.status, createdAt: x.createdAt })) },
      { key: 'payments', title: 'مدفوعات بانتظار مراجعة', count: pendingPayments.length, items: pendingPayments.map((x) => ({ id: x.id, title: `${x.invoiceNo || 'فاتورة'} · ${x.amount}`, subtitle: x.user?.name || x.user?.email || x.purpose || '-', status: x.status, createdAt: x.createdAt })) },
      { key: 'assignments', title: 'واجبات تحتاج تصحيح', count: assignmentSubmissions.length, items: assignmentSubmissions.map((x) => ({ id: x.id, title: x.assignment?.title || 'واجب', subtitle: `${x.user?.name || x.user?.email || 'طالب'} · ${x.assignment?.program?.titleAr || '-'}`, status: x.status, createdAt: x.submittedAt })) },
      { key: 'topics', title: 'عناوين بحث تحتاج اعتماد', count: thesisTopicRequests.length, items: thesisTopicRequests.map((x) => ({ id: x.id, title: x.proposedTitle, subtitle: `${x.user?.name || x.user?.email || 'طالب'} · ${x.program?.titleAr || '-'}`, status: x.status, createdAt: x.createdAt })) },
      { key: 'plans', title: 'خطط بحث تحتاج مراجعة', count: planReviews.length, items: planReviews.map((x) => ({ id: x.id, title: x.title, subtitle: x.user?.name || x.user?.email || 'طالب', status: x.status, createdAt: x.updatedAt })) },
      { key: 'finals', title: 'أبحاث نهائية تحتاج قرار', count: finalReviews.length, items: finalReviews.map((x) => ({ id: x.id, title: x.title, subtitle: x.user?.name || x.user?.email || 'طالب', status: x.status, createdAt: x.updatedAt })) },
      { key: 'defenses', title: 'مناقشات مجدولة للمتابعة', count: scheduledDefenses.length, items: scheduledDefenses.map((x) => ({ id: x.id, title: x.title, subtitle: x.user?.name || x.user?.email || 'طالب', status: x.defenseStatus || 'SCHEDULED', createdAt: x.defenseDate })) },
      { key: 'students', title: 'طلاب معطلون أو مؤرشفون', count: problemStudents.length, items: problemStudents.map((x) => ({ id: x.id, title: x.name || x.email, subtitle: x.email, status: x.status, createdAt: x.updatedAt })) },
    ]

    const total = groups.reduce((sum, g) => sum + g.count, 0)
    return NextResponse.json({ total, groups })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('admin daily tasks error:', e)
    return NextResponse.json({ error: 'تعذر تحميل مهام الإدارة اليوم' }, { status: 500 })
  }
}
