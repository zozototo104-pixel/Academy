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

    const checklist = [
      { group: 'البيئة', item: 'قاعدة البيانات متصلة', ok: env.database, severity: 'CRITICAL', action: 'تحقق من DATABASE_URL في Vercel.' },
      { group: 'البيئة', item: 'Cloudflare R2 مهيأ', ok: env.r2, severity: 'HIGH', action: 'أكمل متغيرات R2_ACCOUNT_ID و R2_ACCESS_KEY_ID و R2_SECRET_ACCESS_KEY و R2_BUCKET.' },
      { group: 'البيئة', item: 'Gemini AI مهيأ', ok: env.gemini, severity: 'MEDIUM', action: 'أضف GEMINI_API_KEY حتى تعمل ميزات الذكاء.' },
      { group: 'البريد', item: 'البريد الرسمي مفعّل', ok: env.resend, severity: 'HIGH', action: 'أضف RESEND_API_KEY و MAIL_FROM أو فعّل SMTP من لوحة الإدارة.' },
      { group: 'الأمان', item: 'تهيئة القاعدة التلقائية معطلة', ok: !env.dbSetupEnabled, severity: 'CRITICAL', action: 'عطّل AACT_RUN_DB_SETUP بعد الإطلاق.' },
      { group: 'الأمان', item: 'إنشاء الأدمن التلقائي معطل', ok: !env.createAdminEnabled, severity: 'CRITICAL', action: 'عطّل AACT_CREATE_ADMIN بعد إنشاء حساب الإدارة.' },
      { group: 'الأمان', item: 'DB Push غير مفعل دائمًا', ok: !env.dbPushEnabled, severity: 'HIGH', action: 'استخدم AACT_RUN_DB_PUSH مرة واحدة فقط عند تحديث schema ثم عطّله.' },
      { group: 'المحتوى', item: 'يوجد برامج مفتوحة للتسجيل', ok: openPrograms > 0, severity: 'HIGH', action: 'افتح التسجيل على برنامج واحد على الأقل من الإدارة.' },
      { group: 'المحتوى', item: 'نسبة جيدة من البرامج معتمدة أكاديميًا', ok: programs === 0 ? false : approvedPrograms >= Math.ceil(programs * 0.75), severity: 'MEDIUM', action: 'راجع مركز الجودة واعتمد البرامج الجاهزة.' },
      { group: 'المحتوى', item: 'الكتب مرفوعة', ok: books > 0, severity: 'HIGH', action: 'ارفع كتب البرامج أو استوردها قبل فتح التسجيل الواسع.' },
      { group: 'التقييم', item: 'اختبارات البرامج جاهزة', ok: programExams > 0, severity: 'MEDIUM', action: 'أنشئ أو ولّد اختبارات نهائية للبرامج.' },
      { group: 'التقييم', item: 'الواجبات المنشورة موجودة', ok: assignments > 0, severity: 'LOW', action: 'انشر واجبات للبرامج التي تحتاج تقييمًا مستمرًا.' },
      { group: 'بحث التخرج', item: 'عناوين بحث معتمدة موجودة', ok: thesisTopics > 0, severity: 'MEDIUM', action: 'أضف أو ولّد عناوين بحث واعتمدها للطلاب.' },
      { group: 'البريد', item: 'لا توجد رسائل فاشلة', ok: failedEmails === 0, severity: 'MEDIUM', action: 'افتح حالة البريد وافحص أسباب الفشل.' },
      { group: 'البريد', item: 'لا توجد رسائل متخطاة', ok: skippedEmails === 0, severity: 'LOW', action: 'أرسل رسالة اختبار بعد تفعيل البريد.' },
    ]

    const failedChecklist = checklist.filter((item) => !item.ok)
    const critical = failedChecklist.filter((item) => item.severity === 'CRITICAL').length
    const high = failedChecklist.filter((item) => item.severity === 'HIGH').length
    const medium = failedChecklist.filter((item) => item.severity === 'MEDIUM').length
    const score = Math.max(0, Math.min(100,
      100
      - critical * 25
      - high * 10
      - medium * 5
      - failedChecklist.filter((item) => item.severity === 'LOW').length * 2
      + (programs && approvedPrograms ? 5 : 0)
      + (env.r2 ? 5 : 0)
      + (env.resend ? 5 : 0)
    ))

    const actionItems = failedChecklist
      .sort((a, b) => {
        const rank: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 }
        return rank[a.severity] - rank[b.severity]
      })
      .slice(0, 8)

    const launchScenarios = [
      { name: 'تقديم طلب التحاق', status: openPrograms > 0 ? 'READY' : 'BLOCKED', note: openPrograms > 0 ? 'يوجد برنامج مفتوح للتسجيل.' : 'لا يوجد برنامج مفتوح للتسجيل.' },
      { name: 'إرسال بريد للطالب', status: env.resend ? 'READY' : 'NEEDS_SETUP', note: env.resend ? 'Resend/MAIL_FROM مفعّل.' : 'فعّل Resend أو SMTP ثم أرسل رسالة اختبار.' },
      { name: 'فتح الكتب والملفات', status: env.r2 && books > 0 ? 'READY' : 'NEEDS_SETUP', note: env.r2 ? 'تحقق من وجود كتب مرفوعة.' : 'R2 غير مكتمل.' },
      { name: 'الاختبارات والواجبات', status: programExams > 0 || assignments > 0 ? 'READY' : 'NEEDS_CONTENT', note: 'يفضل وجود اختبار أو واجب منشور قبل إطلاق واسع.' },
      { name: 'بحث التخرج', status: thesisTopics > 0 ? 'READY' : 'NEEDS_CONTENT', note: thesisTopics > 0 ? 'توجد عناوين معتمدة.' : 'أضف عناوين بحث معتمدة.' },
      { name: 'الأمان التشغيلي', status: !env.dbSetupEnabled && !env.createAdminEnabled ? 'READY' : 'DANGER', note: 'يجب تعطيل متغيرات التهيئة بعد الإطلاق.' },
    ]

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
      checklist,
      actionItems,
      launchScenarios,
      recentEmails,
      recentAudits,
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('launch health error:', e)
    return NextResponse.json({ error: 'تعذر تحميل مراقبة الإطلاق' }, { status: 500 })
  }
}
