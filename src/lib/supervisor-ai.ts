import { db } from '@/lib/db'

/**
 * 12.1 — قاعدة معرفة خاصة بكل طالب (RAG)
 * تبني سياقاً تخصصياً حقيقياً من: برامج الطالب الفعّالة + وحداتها الدراسية +
 * الكتب المقررة المعتمدة (نصوصها المستخرجة) + تقدمه ونتائجه + بحث تخرجه ومواعيده
 * بحيث يكون المشرف الذكي ملمّاً فعلياً بتخصص الطالب وليس محادثة عامة.
 */
export async function buildSupervisorContext(userId: string): Promise<string> {
  try {
    const [enrollments, thesis, admission] = await Promise.all([
      db.enrollment.findMany({
        where: { userId, status: { in: ['ACTIVE', 'COMPLETED'] } },
        include: {
          program: {
            include: {
              units: { orderBy: { order: 'asc' }, select: { title: true, summary: true, objectives: true } },
              books: {
                orderBy: { createdAt: 'asc' },
                select: { title: true, titleEn: true, author: true, description: true, semester: true, textContent: true },
              },
              programExams: { select: { id: true, title: true, semester: true, status: true, passScore: true } },
            },
          },
        },
      }),
      db.thesisSubmission.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' } }),
      db.admissionApplication.findFirst({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        select: { reference: true, program: true, status: true, thesisDeadline: true },
      }),
    ])

    if (enrollments.length === 0 && !thesis && !admission) {
      return 'الطالب لم يسجل في أي برنامج بعد — ركّز على تقديم المشورة حول برامج الأكاديمية وإجراءات الالتحاق.'
    }

    const parts: string[] = []

    // ===== أولاً: أبحاث تخرج الطالب وسجل إجراءات الالتحاق =====
    if (admission) {
      const deadline = admission.thesisDeadline
        ? new Date(admission.thesisDeadline).toLocaleDateString('ar-EG', { day: 'numeric', month: 'long', year: 'numeric' })
        : null
      const daysLeft = deadline
        ? Math.ceil((new Date(admission.thesisDeadline as any).getTime() - Date.now()) / 86400000)
        : null
      parts.push(
        `ملف طلب الالتحاق: رقم ${admission.reference} — البرنامج: ${admission.program} — الحالة: ${admission.status}` +
          (deadline ? ` — مهلة تسليم بحث التخرج تنتهي في ${deadline}${daysLeft != null ? ` (متبقٍ ${daysLeft} يوم)` : ''}` : '')
      )
    }
    if (thesis) {
      parts.push(
        `بحث التخرج: «${thesis.title}» — الحالة: ${thesis.status}` +
          (thesis.defenseDate ? ` — موعد المناقشة: ${new Date(thesis.defenseDate).toLocaleDateString('ar-EG')}` : '') +
          (thesis.resultScore != null ? ` — نتيجة المناقشة النهائية: ${thesis.resultScore}` : '') +
          (thesis.aiScore != null ? ` — تقييم الخبير الذكي في الجلسة: ${thesis.aiScore}/100` : '')
      )
    }

    // ===== ثانياً: لكل برنامج مسجل — المنهج والكتب والتقدم =====
    for (const enr of enrollments) {
      const p = enr.program
      const totalUnits = p.units.length
      const done = enr.completedUnits ? JSON.parse(enr.completedUnits) : []
      const pct = totalUnits ? Math.round((done.length / totalUnits) * 100) : 0

      const unitLines = p.units
        .slice(0, 12)
        .map((u, i) => {
          const obj = u.objectives ? (() => { try { const a = JSON.parse(u.objectives); return Array.isArray(a) ? ` — أهدافه: ${a.slice(0, 3).join('؛ ')}` : '' } catch { return '' } })() : ''
          return `${i + 1}. ${u.title}${u.summary ? `: ${u.summary.slice(0, 140)}` : ''}${obj}`
        })
      parts.push(
        `البرنامج المسجل به: «${p.titleAr}» (${p.category}) — تقدم الطالب: ${done.length}/${totalUnits} وحدة (${pct}%)` +
          (enr.finalScore != null ? ` — النتيجة النهائية: ${enr.finalScore}` : '') +
          `\nوحدات المنهج:\n${unitLines.join('\n')}`
      )

      // الكتب المقررة المعتمدة — مقتطفات من نصوصها الفعلية (RAG)
      if (p.books.length > 0) {
        const bookBlocks = p.books.slice(0, 6).map((b) => {
          const excerpt = (b.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 1100)
          return `- «${b.title}»${b.author ? ` (${b.author})` : ''}${b.semester ? ` — فصل ${b.semester === 1 ? 'أول' : 'ثانٍ'}` : ''}${b.description ? ` — ${b.description.slice(0, 110)}` : ''}${excerpt ? `\n  مقتطف من محتواه: «${excerpt}…»` : ''}`
        })
        parts.push(`الكتب المقررة المعتمدة لهذا التخصص (يُمتحَن بها الطالب):\n${bookBlocks.join('\n')}`)
      }

      // الامتحانات الشاملة المتاحة ونتائجه فيها
      const readyExams = p.programExams.filter((e) => e.status === 'READY')
      if (readyExams.length > 0) {
        parts.push(
          `الامتحانات: ${readyExams.map((e) => `${e.title} (فصل ${e.semester === 2 ? 'ثانٍ' : 'أول'} — حد النجاح ${e.passScore}%)`).join(' | ')}`
        )
      }
    }

    // محاولات الامتحان الشامل وأفضل النتائج
    const attempts = await db.programExamAttempt.findMany({
      where: { userId },
      include: { exam: { select: { title: true } } },
      orderBy: { createdAt: 'desc' },
      take: 5,
    })
    if (attempts.length > 0) {
      parts.push(
        `آخر محاولاته في الامتحانات الشاملة: ${attempts
          .map((a) => `${a.exam.title}: ${a.score != null ? `${a.score}%` : 'قيد التصحيح'}${a.appealStatus === 'PENDING' ? ' (اعتراض قيد المراجعة)' : ''}`)
          .join(' | ')}`
      )
    }

    let ctx = parts.join('\n\n')
    if (ctx.length > 14000) ctx = ctx.slice(0, 14000) + '…'
    return ctx
  } catch (e) {
    console.error('supervisor-ai context error:', e)
    return ''
  }
}

/** يبني رسالة النظام للمشرف الذكي متضمنة سياق الطالب التخصصي */
export function mergeContext(ragContext: string, uiContext?: string): string {
  const blocks: string[] = []
  if (ragContext) blocks.push(`ملف الطالب ومعرفته التخصصية (من قاعدة معرفة الأكاديمية — استند إليها في إجاباتك):\n${ragContext}`)
  if (uiContext) blocks.push(`سياق إضافي من الواجهة:\n${uiContext}`)
  return blocks.join('\n\n')
}
