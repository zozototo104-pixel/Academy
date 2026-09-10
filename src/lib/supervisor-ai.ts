import { db } from '@/lib/db'
import { getProgramKnowledgeItems } from '@/lib/knowledge-bank'

/**
 * 12.1 — قاعدة معرفة خاصة بكل طالب (RAG)
 * تبني سياقاً تخصصياً حقيقياً من: كتالوج البرامج النشطة + برامج الطالب الفعّالة +
 * وحداتها الدراسية + الكتب المقررة المعتمدة + تقدمه ونتائجه + بحث تخرجه ومواعيده.
 */
export async function buildSupervisorContext(userId: string): Promise<string> {
  try {
    const [enrollments, thesis, admission, activePrograms] = await Promise.all([
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
              studyGuides: {
                where: { status: 'PUBLISHED' },
                orderBy: [{ semester: 'asc' }, { updatedAt: 'desc' }],
                select: { title: true, overview: true, objectives: true, keyTerms: true, discussionQuestions: true, semester: true },
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
      db.program.findMany({
        where: { active: true },
        orderBy: [{ order: 'asc' }, { titleAr: 'asc' }],
        take: 100,
        select: {
          titleAr: true,
          titleEn: true,
          category: true,
          hours: true,
          price: true,
          description: true,
          books: {
            orderBy: { createdAt: 'asc' },
            take: 3,
            select: { title: true, titleEn: true, author: true, description: true, textContent: true },
          },
        },
      }),
    ])

    const parts: string[] = []

    if (activePrograms.length > 0) {
      const programLines = activePrograms.map((p, i) => {
        const hours = p.hours ? ` — ${p.hours} ساعة` : ''
        const price = p.price ? ` — ${p.price}$` : ''
        const desc = p.description ? ` — ${p.description.replace(/\s+/g, ' ').slice(0, 120)}` : ''
        const books = p.books.length
          ? `\n   كتب/مراجع مرتبطة: ${p.books.map((b) => {
              const snippet = (b.textContent || b.description || '').replace(/\s+/g, ' ').trim().slice(0, 180)
              return `«${b.title}»${b.author ? ` (${b.author})` : ''}${snippet ? `: ${snippet}` : ''}`
            }).join(' | ')}`
          : ''
        return `${i + 1}. ${p.titleAr}${p.titleEn ? ` (${p.titleEn})` : ''} — ${p.category}${hours}${price}${desc}${books}`
      })
      parts.push(`ذاكرة كتالوج البرامج النشطة في النظام (${activePrograms.length} برنامج):\n${programLines.join('\n')}`)
    }

    if (enrollments.length === 0 && !thesis && !admission) {
      parts.push('الطالب لم يسجل في أي برنامج بعد — ركّز على تقديم المشورة حول برامج الأكاديمية وإجراءات الالتحاق، وابدأ بذكر البرامج عندما يسأل عنها.')
    }

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

    for (const enr of enrollments) {
      const p = enr.program
      const totalUnits = p.units.length
      const done = enr.completedUnits ? JSON.parse(enr.completedUnits) : []
      const pct = totalUnits ? Math.round((done.length / totalUnits) * 100) : 0

      const unitLines = p.units
        .slice(0, 12)
        .map((u, i) => {
          const obj = u.objectives
            ? (() => {
                try {
                  const a = JSON.parse(u.objectives)
                  return Array.isArray(a) ? ` — أهدافه: ${a.slice(0, 3).join('؛ ')}` : ''
                } catch {
                  return ''
                }
              })()
            : ''
          return `${i + 1}. ${u.title}${u.summary ? `: ${u.summary.slice(0, 140)}` : ''}${obj}`
        })

      parts.push(
        `البرنامج المسجل به: «${p.titleAr}» (${p.category}) — تقدم الطالب: ${done.length}/${totalUnits} وحدة (${pct}%)` +
          (enr.finalScore != null ? ` — النتيجة النهائية: ${enr.finalScore}` : '') +
          `\nوحدات المنهج:\n${unitLines.join('\n')}`
      )

      if (p.books.length > 0) {
        const bookBlocks = p.books.slice(0, 6).map((b) => {
          const excerpt = (b.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 1100)
          return `- «${b.title}»${b.author ? ` (${b.author})` : ''}${b.semester ? ` — فصل ${b.semester === 1 ? 'أول' : 'ثانٍ'}` : ''}${b.description ? ` — ${b.description.slice(0, 110)}` : ''}${excerpt ? `\n  مقتطف من محتواه: «${excerpt}…»` : ''}`
        })
        parts.push(`الكتب المقررة المعتمدة لهذا التخصص (يُمتحَن بها الطالب):\n${bookBlocks.join('\n')}`)
      }

      const knowledgeItems = await getProgramKnowledgeItems(p.id, undefined, 30).catch(() => [])
      if (knowledgeItems.length > 0) {
        parts.push(
          `بنك المعرفة الأكاديمي المستخرج من كتب هذا التخصص (استخدمه في الشرح والأسئلة والمناقشة):\n${knowledgeItems
            .slice(0, 24)
            .map((k, i) => `${i + 1}. [${k.category}] ${k.title}: ${k.summary.slice(0, 260)}${k.bookTitle ? ` — من «${k.bookTitle}»` : ''}`)
            .join('\n')}`
        )
      }

      const readyExams = p.programExams.filter((e) => e.status === 'READY')
      if (readyExams.length > 0) {
        parts.push(
          `الامتحانات: ${readyExams.map((e) => `${e.title} (فصل ${e.semester === 2 ? 'ثانٍ' : 'أول'} — حد النجاح ${e.passScore}%)`).join(' | ')}`
        )
      }
    }

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
    if (ctx.length > 16000) ctx = ctx.slice(0, 16000) + '…'
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
