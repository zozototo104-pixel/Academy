import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { DEMO_ACCOUNTS } from '@/lib/demo-accounts'

async function safeCount(label: string, fn: () => Promise<number>) {
  try {
    return { label, ok: true, count: await fn() }
  } catch (e: any) {
    return { label, ok: false, count: 0, error: e?.message || 'failed' }
  }
}

export async function GET() {
  try {
    await requireAdmin()

    const checks = await Promise.all([
      safeCount('users', () => db.user.count()),
      safeCount('programs', () => db.program.count({ where: { active: true } })),
      safeCount('program_units', () => db.unit.count()),
      safeCount('book_bank', () => db.book.count()),
      safeCount('knowledge_items', () => db.bookKnowledgeItem.count()),
      safeCount('study_guides', () => db.programStudyGuide.count()),
      safeCount('assignments', () => db.programAssignment.count()),
      safeCount('program_exams', () => db.programExam.count()),
      safeCount('admissions', () => db.admissionApplication.count()),
      safeCount('enrollments', () => db.enrollment.count()),
      safeCount('payments', () => db.payment.count()),
      safeCount('theses', () => db.thesisSubmission.count()),
      safeCount('defense_participants', () => db.defenseParticipant.count()),
      safeCount('certificates', () => db.certificate.count()),
      safeCount('agent_applications', () => db.agentApplication.count()),
    ])

    const demoEmails = Object.values(DEMO_ACCOUNTS).map((a) => a.email)
    const demoUsers = await db.user.findMany({
      where: { email: { in: demoEmails } },
      select: { email: true, role: true, name: true },
      orderBy: { email: 'asc' },
    })

    const env = {
      database: Boolean(process.env.DATABASE_URL || process.env.DIRECT_URL),
      directUrl: Boolean(process.env.DIRECT_URL),
      gemini: Boolean(process.env.GEMINI_API_KEY),
      google: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
      siteUrl: Boolean(process.env.NEXTAUTH_URL || process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL),
    }

    const failed = checks.filter((c) => !c.ok)
    return NextResponse.json({
      ok: failed.length === 0,
      generatedAt: new Date().toISOString(),
      env,
      checks,
      demoUsers,
      recommendations: [
        env.google ? 'Google Login configured' : 'أضف GOOGLE_CLIENT_ID و GOOGLE_CLIENT_SECRET لتفعيل دخول Google',
        env.gemini ? 'Gemini configured' : 'أضف GEMINI_API_KEY لتفعيل وظائف الذكاء الاصطناعي',
        env.directUrl ? 'DIRECT_URL configured' : 'يفضل إضافة DIRECT_URL المباشر من Neon للعمليات الإدارية',
      ],
    })
  } catch (e: any) {
    const status = e?.message === 'UNAUTHORIZED' ? 401 : 500
    return NextResponse.json({ error: status === 401 ? 'UNAUTHORIZED' : 'تعذر فحص المنصة' }, { status })
  }
}
