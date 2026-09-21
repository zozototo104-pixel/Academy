import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'

export const runtime = 'nodejs'

function enabled(value?: string) {
  return Boolean(value && value.trim() && value.trim().toLowerCase() !== 'no' && value.trim().toLowerCase() !== 'false')
}

export async function GET() {
  try {
    await requireAdmin()
    const [
      users,
      students,
      activeEnrollments,
      programs,
      approvedPrograms,
      openPrograms,
      books,
      units,
      programExams,
      assignments,
      thesisTopics,
      thesisSubmissions,
      paidPayments,
      certificates,
      failedEmails,
      skippedEmails,
      recentEmails,
      recentAudits,
    ] = await Promise.all([
      db.user.count(),
      db.user.count({ where: { role: 'STUDENT' } }),
      db.enrollment.count({ where: { status: 'ACTIVE' } }),
      db.program.count({ where: { active: true } }),
      db.program.count({ where: { active: true, academicReadinessStatus: 'APPROVED' } }),
      db.program.count({ where: { active: true, registrationStatus: 'OPEN' } }),
      db.book.count(),
      db.unit.count(),
      db.programExam.count({ where: { status: 'READY' } }),
      db.programAssignment.count({ where: { status: 'PUBLISHED' } }),
      db.thesisTopic.count({ where: { status: 'APPROVED' } }),
      db.thesisSubmission.count(),
      db.payment.count({ where: { status: 'PAID' } }),
      db.certificate.count(),
      db.emailLog.count({ where: { status: 'FAILED' } }),
      db.emailLog.count({ where: { status: 'SKIPPED' } }),
      db.emailLog.findMany({ orderBy: { createdAt: 'desc' }, take: 10, select: { id: true, to: true, subject: true, event: true, status: true, error: true, createdAt: true } }),
      db.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 15, select: { id: true, actorName: true, action: true, entity: true, details: true, createdAt: true } }),
    ])

    const env = {
      database: enabled(process.env.DATABASE_URL),
      r2: enabled(process.env.R2_ACCOUNT_ID) && enabled(process.env.R2_ACCESS_KEY_ID) && enabled(process.env.R2_SECRET_ACCESS_KEY) && enabled(process.env.R2_BUCKET),
      gemini: enabled(process.env.GEMINI_API_KEY),
      resend: enabled(process.env.RESEND_API_KEY) && enabled(process.env.MAIL_FROM || process.env.RESEND_FROM),
      dbPushEnabled: enabled(process.env.AACT_RUN_DB_PUSH),
      dbSetupEnabled: enabled(process.env.AACT_RUN_DB_SETUP),
      createAdminEnabled: enabled(process.env.AACT_CREATE_ADMIN),
    }

    const warnings = [
      !env.database ? 'DATABASE_URL غير موجود: المنصة لن تعمل دون قاعدة البيانات.' : null,
      !env.r2 ? 'Cloudflare R2 غير مكتمل: قد تفشل ملفات الكتب/الواجبات/المناقشات.' : null,
      !env.gemini ? 'GEMINI_API_KEY غير موجود: ميزات الذكاء الاصطناعي لن تعمل.' : null,
      !env.resend ? 'Resend/MAIL_FROM غير مفعّل: رسائل البريد قد لا تصل إلا إذا كان SMTP مهيأً من لوحة الإدارة.' : null,
      env.dbPushEnabled ? 'AACT_RUN_DB_PUSH ما زال مفعّلًا. عطّله بعد تحديث قاعدة البيانات.' : null,
      env.dbSetupEnabled ? 'AACT_RUN_DB_SETUP مفعّل. هذا خطر بعد الإطلاق ويجب تعطيله.' : null,
      env.createAdminEnabled ? 'AACT_CREATE_ADMIN مفعّل. عطّله بعد إنشاء حساب الإدارة.' : null,
      programs > 0 && approvedPrograms < Math.ceil(programs * 0.75) ? 'نسبة البرامج المعتمدة أكاديميًا منخفضة مقارنة بعدد البرامج النشطة.' : null,
      openPrograms === 0 ? 'لا يوجد أي برنامج مفتوح للتسجيل.' : null,
      books === 0 ? 'لا توجد كتب مرفوعة بعد.' : null,
      programExams === 0 ? 'لا توجد اختبارات برامج جاهزة.' : null,
      failedEmails > 0 ? `يوجد ${failedEmails} رسالة بريد فاشلة في السجل.` : null,
      skippedEmails > 0 ? `يوجد ${skippedEmails} رسالة بريد تم تخطيها لأن البريد لم يكن مهيأً وقتها.` : null,
    ].filter(Boolean)

    const critical = warnings.filter((w) => /DATABASE_URL|AACT_RUN_DB_SETUP|AACT_CREATE_ADMIN/.test(String(w))).length
    const score = Math.max(0, Math.min(100,
      100
      - critical * 25
      - warnings.length * 4
      + (programs && approvedPrograms ? 5 : 0)
      + (env.r2 ? 5 : 0)
      + (env.resend ? 5 : 0)
    ))

    return NextResponse.json({
      score,
      level: score >= 85 ? 'READY' : score >= 65 ? 'NEEDS_ATTENTION' : 'NOT_READY',
      env,
      counts: {
        users,
        students,
        activeEnrollments,
        programs,
        approvedPrograms,
        openPrograms,
        books,
        units,
        programExams,
        assignments,
        thesisTopics,
        thesisSubmissions,
        paidPayments,
        certificates,
        failedEmails,
        skippedEmails,
      },
      warnings,
      recentEmails,
      recentAudits,
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('launch health error:', e)
    return NextResponse.json({ error: 'تعذر تحميل مراقبة الإطلاق' }, { status: 500 })
  }
}
