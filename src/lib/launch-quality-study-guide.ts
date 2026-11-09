import { db } from '@/lib/db'

// دليل الدراسة العام لبرنامج فحص جاهزية الإطلاق (فصل 1، بلا وحدة).
// النموذج ProgramStudyGuide لا يملك قيداً فريداً على (programId, semester)
// — عنده فهرس فقط — فالـupsert بالمفتاح المركّب programId_semester يرمي
// PrismaClientValidationError (عطل بوابة #703). هنا بحث-أو-إنشاء آمن عند
// إعادة التشغيل: قفل استشاري داخل معاملة يُسلسِل النداءات المتزامنة على
// نفس البرنامج، والبحث مقصور على الدليل العام (unitId: null) فلا تُلمس
// أدلة الوحدات أبداً، وأي إعادة تشغيل تحدّث الدليل نفسه بدل إنشاء نسخة.
const GUIDE_LOCK_NAMESPACE = 741209

const GUIDE_UPDATE_DATA = {
  title: 'دليل دراسة الفصل الأول: الحوكمة والمخاطر',
  overview: 'يركز هذا الدليل على قراءة الكتاب المقرر، فهم سجل المخاطر، وتطبيق الضوابط على حالة عملية.',
  objectives: JSON.stringify(['تلخيص مفاهيم الحوكمة', 'تحليل سجل مخاطر', 'اقتراح ضوابط قابلة للقياس']),
  keyTerms: JSON.stringify(['الحوكمة', 'سجل المخاطر', 'الخطر المتبقي', 'مؤشرات المخاطر']),
  sections: JSON.stringify(['مفاهيم أساسية', 'تطبيقات عملية', 'أسئلة مراجعة']),
  discussionQuestions: JSON.stringify(['لماذا لا يكفي وجود ضابط دون مؤشر قياس؟', 'كيف تشرح الفرق بين الخطر المتأصل والمتبقي؟']),
  status: 'PUBLISHED',
}

export async function ensureLaunchQualityStudyGuide(programId: string) {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${GUIDE_LOCK_NAMESPACE}, hashtext(${'launch-quality-guide:' + programId}))`
    const existing = await tx.programStudyGuide.findFirst({
      where: { programId, semester: 1, unitId: null },
      orderBy: { createdAt: 'asc' },
    })
    if (existing) {
      return tx.programStudyGuide.update({ where: { id: existing.id }, data: GUIDE_UPDATE_DATA })
    }
    return tx.programStudyGuide.create({
      data: {
        programId,
        semester: 1,
        ...GUIDE_UPDATE_DATA,
        activities: JSON.stringify(['ارسم سجل مخاطر مختصر', 'اكتب توصية رقابية قابلة للتنفيذ']),
        generatedBy: 'ADMIN',
      },
    })
  })
}
