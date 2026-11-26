import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { audit } from '@/lib/notify'
import { decryptSecret, isEncryptedSecret } from '@/lib/secret-crypto'
import { searchTavily, TavilySearchError } from '@/lib/tavily-search'
import { normalizeArabic } from '@/lib/arabic-normalize'
import { COMPREHENSIVE_EXAM_QUESTION_COUNT, internetAcademicTopicIssue } from '@/lib/comprehensive-exam'
import {
  INTERNET_MAX_SEARCH_RESULTS,
  buildSpecialtyInternetQuery,
  buildSpecialtyResearchQueries,
  clampInternetQuestionCount,
  diverseInternetEvidence,
  generateInternetQuestions,
  internetSourceId,
  suggestComprehensiveInternetPlan,
} from '@/lib/comprehensive-exam-internet'

export const runtime = 'nodejs'
export const maxDuration = 300

// The Tavily key lives in the Setting table (encrypted at rest, like
// every provider key) and is read server-side only — never exposed to
// the browser. process.env.TAVILY_API_KEY is the fallback for
// deployments that prefer env vars. Never logged, never returned.
export async function readTavilyApiKey(): Promise<string | null> {
  const row = await (db as any).setting?.findUnique?.({ where: { key: 'TAVILY_API_KEY' } })
  const raw = String(row?.value || '').trim()
  if (raw) {
    try {
      if (isEncryptedSecret(raw)) return decryptSecret(raw)
    } catch {
      // The stored value is not decryptable — treat it as-is rather
      // than failing the whole request on a settings read.
    }
    return raw
  }
  return process.env.TAVILY_API_KEY?.trim() || null
}

// POST /api/admin/comprehensive-exams/[id]/questions/from-internet
// بحث الذكاء عبر الإنترنت (Tavily): يبحث في الويب عن الموضوع، ثم
// يولّد أسئلة من الخلاصات الراجعة فقط — كل سؤال بدليل حرفي من خلاصة
// ورابط مصدرها، وكلها بانتظار المراجعة. لا تُخترع أسئلة أبداً: بلا
// مفتاح → 422 صريح، بلا نتائج → 422 صريح، فشل البحث → 502 صريح،
// دفعة فارغة كلياً → فشل صريح. الدفعات الجزئية تحفظ الناجي وتبلّغ
// عن النقص.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireAdmin()
    const { id } = await ctx.params
    const exam = await db.comprehensiveExam.findUnique({
      where: { id },
      select: { id: true, status: true, title: true, level: true, programId: true, specializationProgramId: true },
    })
    if (!exam) return NextResponse.json({ error: 'الامتحان غير موجود' }, { status: 404 })
    if (exam.status !== 'DRAFT') {
      return NextResponse.json({ error: 'لا يمكن إضافة أسئلة لامتحان منشور — ألغِ نشره أولاً' }, { status: 409 })
    }
    let body: any = {}
    try {
      body = await req.json()
    } catch {
      body = {}
    }
    if (body?.action === 'PLAN') {
      if (!exam.specializationProgramId) return NextResponse.json({ error: 'الامتحان غير مربوط بتخصص علمي محدد' }, { status: 422 })
      const specialty = await db.program.findUnique({
        where: { id: exam.specializationProgramId },
        select: { titleAr: true, category: true,
          units: { where: { status: 'APPROVED' }, orderBy: [{ semester: 'asc' }, { order: 'asc' }], select: { title: true } },
        },
      })
      if (!specialty) return NextResponse.json({ error: 'لم يُعثر على تخصص الامتحان' }, { status: 422 })
      try {
        const plan = await suggestComprehensiveInternetPlan({ specialtyTitle: specialty.titleAr, category: specialty.category,
          approvedUnitTitles: specialty.units.map((unit) => unit.title) })
        return NextResponse.json({ ...plan, specialtyTitle: specialty.titleAr, needsReview: true })
      } catch (error: any) {
        console.error('comprehensive exam internet blueprint error:', error)
        return NextResponse.json({ error: 'تعذّر إعداد محاور التخصص. يمكنك كتابتها يدوياً أو إعادة المحاولة بعد فحص مزود التوليد.' }, { status: 502 })
      }
    }
    const topic = String(body?.topic || '').trim()
    if (!topic) {
      return NextResponse.json({ error: 'اكتب موضوع البحث أولاً' }, { status: 400 })
    }
    const specialty = await db.program.findUnique({
      where: { id: exam.specializationProgramId || exam.programId },
      select: { titleAr: true },
    })
    const specialtyTitle = specialty?.titleAr || exam.title
    const topicIssue = internetAcademicTopicIssue(topic, specialtyTitle)
    if (topicIssue) {
      return NextResponse.json({ error: topicIssue, code: 'ACADEMIC_TOPIC_REQUIRED' }, { status: 422 })
    }
    const comprehensive = body?.mode === 'COMPREHENSIVE'
    const axisTarget = Number(body?.axisTarget)
    if (comprehensive && (!exam.specializationProgramId || !Number.isInteger(axisTarget) || axisTarget < 1 || axisTarget > 100)) {
      return NextResponse.json({ error: 'خطة الامتحان الشامل تتطلب تخصصاً ومحوراً بعدد أسئلة مستهدف صحيح' }, { status: 400 })
    }
    let count = clampInternetQuestionCount(body?.count)
    if (comprehensive) {
      // Repeating a partial batch is safe: count what is already saved
      // under this axis, and never silently overfill the 100-question exam.
      const [existingForAxis, totalEligible] = await Promise.all([
        db.comprehensiveExamQuestion.count({ where: { examId: id, source: 'AI_INTERNET', sourceBookId: internetSourceId(topic), status: { in: ['APPROVED', 'PENDING_REVIEW'] } } }),
        db.comprehensiveExamQuestion.count({ where: { examId: id, status: { in: ['APPROVED', 'PENDING_REVIEW'] } } }),
      ])
      count = Math.min(count, axisTarget - existingForAxis, COMPREHENSIVE_EXAM_QUESTION_COUNT - totalEligible)
      if (count <= 0) {
        return NextResponse.json({ ok: true, imported: 0, requested: 0, accepted: 0, rejected: [], rejectedCount: 0, skipped: true,
          examFull: totalEligible >= COMPREHENSIVE_EXAM_QUESTION_COUNT,
          axisRemaining: Math.max(0, axisTarget - existingForAxis),
          search: { topic, resultsFound: 0, chunksUsed: 0, creditsUsed: 0 } })
      }
    }
    const apiKey = await readTavilyApiKey()
    if (!apiKey) {
      return NextResponse.json(
        {
          error:
            'لم يُحفظ مفتاح Tavily بعد — احفظ مفتاحاً مجانياً من tavily.com (حساب مجاني من غير بطاقة) في لوحة الإدارة → النظام → مزوّدو النصوص والمفاتيح → بحث الإنترنت للامتحان الشامل (Tavily)، ثم أعد المحاولة',
          code: 'TAVILY_KEY_MISSING',
        },
        { status: 422 },
      )
    }
    let search
    let distinctDomains = 0
    try {
      if (comprehensive) {
        // Three independent advanced searches for this *one selected axis*:
        // theory, research evidence, professional cases. A single website
        // or generic admission brochure cannot drive a doctoral exam.
        const queries = buildSpecialtyResearchQueries(topic, specialtyTitle)
        const outcomes = await Promise.all(queries.map((query) => searchTavily({
          apiKey, query, searchDepth: 'advanced', chunksPerSource: 3,
          maxResults: Math.min(8, INTERNET_MAX_SEARCH_RESULTS),
        })))
        const diverse = diverseInternetEvidence(outcomes.map((outcome) => outcome.results))
        distinctDomains = diverse.distinctDomains
        const reportedCredits = outcomes.map((outcome) => outcome.creditsUsed).filter((value): value is number => typeof value === 'number')
        search = {
          results: diverse.results,
          creditsUsed: reportedCredits.length === outcomes.length ? reportedCredits.reduce((sum, credits) => sum + credits, 0) : null,
        }
      } else {
        search = await searchTavily({ apiKey, query: exam.specializationProgramId ? buildSpecialtyInternetQuery(topic, specialtyTitle) : topic, maxResults: INTERNET_MAX_SEARCH_RESULTS })
      }
    } catch (e: any) {
      const kind = e instanceof TavilySearchError ? e.kind : 'SERVER'
      console.error('comprehensive exam internet search error:', e)
      return NextResponse.json(
        { error: String(e?.message || 'تعذر البحث عبر الإنترنت — حاول لاحقاً'), code: 'TAVILY_SEARCH_FAILED', tavilyErrorKind: kind },
        { status: 502 },
      )
    }
    if (comprehensive && (search.results.length < 6 || distinctDomains < 3)) {
      return NextResponse.json({
        error: 'المراجع العلمية غير متنوعة أو غير كافية لهذا المحور: نحتاج 6 مقاطع صالحة على الأقل من 3 مواقع مستقلة؛ جرّب تنقيح اسم المحور.',
        code: 'INADEQUATE_SOURCE_DIVERSITY',
        search: { topic, resultsFound: search.results.length, distinctDomains, creditsUsed: search.creditsUsed },
      }, { status: 422 })
    }
    if (!search.results.length) {
      return NextResponse.json(
        {
          error: 'لم يعثر البحث عبر الإنترنت على نتائج لهذا الموضوع — جرّب صياغة أخرى للموضوع',
          code: 'INTERNET_NO_RESULTS',
          search: { topic, resultsFound: 0, chunksUsed: 0, creditsUsed: search.creditsUsed },
        },
        { status: 422 },
      )
    }
    const previous = await db.comprehensiveExamQuestion.findMany({
      where: { examId: id },
      select: { text: true },
      orderBy: { order: 'asc' },
    })
    let generated
    try {
      generated = await generateInternetQuestions(
        search.results,
        {
          topic,
          programTitleAr: specialtyTitle,
          programLevel: exam.level,
          count,
          comprehensive,
          previousQuestionTexts: previous.map((q: any) => q.text),
        },
      )
    } catch (e: any) {
      if (e?.code === 'INSUFFICIENT_SOURCE') {
        return NextResponse.json(
          {
            error: String(e?.message || 'نتائج البحث غير كافية لتوليد أسئلة موثّقة'),
            code: 'INSUFFICIENT_SOURCE',
            search: { topic, resultsFound: search.results.length, chunksUsed: 0, creditsUsed: search.creditsUsed },
          },
          { status: 422 },
        )
      }
      console.error('comprehensive exam internet generation error:', e)
      return NextResponse.json({ error: `تعذر توليد الأسئلة من نتائج البحث: ${String(e?.message || e).slice(0, 300)}` }, { status: 502 })
    }
    if (!generated.questions.length) {
      return NextResponse.json(
        {
          error: 'لم ينجُ أي سؤال مولَّد من التحقق بالدليل — جرّب صياغة أخرى للموضوع أو عدّداً أقل من الأسئلة',
          rejected: generated.rejected,
          rejectedCount: generated.rejectedCount,
          search: {
            topic,
            resultsFound: generated.search.resultsFound,
            chunksUsed: generated.search.chunksUsed,
            creditsUsed: search.creditsUsed,
          },
        },
        { status: 422 },
      )
    }
    // Only the short final write holds the exam lock. Every internet batch
    // sees earlier commits before reserving slots, order numbers and texts.
    const sourceId = internetSourceId(topic)
    const saved = await db.$transaction(async (tx) => {
      const [current] = await tx.$queryRaw<{ status: string }[]>`
        SELECT status FROM "ComprehensiveExam" WHERE id = ${id} FOR UPDATE
      `
      if (current?.status !== 'DRAFT') return { statusChanged: true } as const
      const existing = await tx.comprehensiveExamQuestion.findMany({
        where: { examId: id },
        select: { order: true, text: true, status: true, source: true, sourceBookId: true },
      })
      const eligible = existing.filter((q) => q.status === 'APPROVED' || q.status === 'PENDING_REVIEW')
      const axisCount = eligible.filter((q) => q.source === 'AI_INTERNET' && q.sourceBookId === sourceId).length
      const freeSlots = COMPREHENSIVE_EXAM_QUESTION_COUNT - eligible.length
      const permitted = comprehensive ? Math.max(0, Math.min(count, axisTarget - axisCount, freeSlots)) : count
      const seen = new Set(existing.map((q) => normalizeArabic(q.text)))
      const unique = generated.questions.filter((q) => {
        const key = normalizeArabic(q.text)
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      const batch = unique.slice(0, permitted)
      if (batch.length) {
        let order = existing.reduce((max, q) => Math.max(max, q.order), 0)
        await tx.comprehensiveExamQuestion.createMany({
          data: batch.map((q) => ({
            examId: id, order: ++order, type: q.type, text: q.text,
            options: JSON.stringify(q.options), correctAnswer: q.correctAnswer,
            source: 'AI_INTERNET', sourceBookId: sourceId, sourceEvidence: q.sourceEvidence,
            sourceUrl: q.sourceUrl || null, status: 'PENDING_REVIEW', createdById: admin.id,
          })),
        })
      }
      return { imported: batch.length, permitted, axisRemaining: Math.max(0, axisTarget - axisCount - batch.length),
        examFull: freeSlots <= batch.length }
    }, { isolationLevel: 'ReadCommitted' })
    if (saved.statusChanged) {
      return NextResponse.json({ error: 'تغيّرت حالة الامتحان أثناء التوليد؛ يجب أن يكون مسودة لحفظ الأسئلة.', code: 'EXAM_STATUS_CHANGED' }, { status: 409 })
    }
    if (!saved.imported && saved.permitted) {
      return NextResponse.json({ error: 'الأسئلة المولّدة مكررة في الامتحان؛ جرّب تنقيح المحور.', code: 'DUPLICATE_OF_EXISTING_QUESTION' }, { status: 422 })
    }
    const truncated = generated.questions.length - saved.imported
    await audit(
      { id: admin.id, name: admin.name },
      'GENERATE_COMPREHENSIVE_EXAM_QUESTIONS_FROM_INTERNET',
      'ComprehensiveExam',
      id,
      `توليد ${saved.imported} سؤالاً من بحث الإنترنت (Tavily) عن «${topic}» (${generated.search.resultsFound} نتيجة، ${generated.search.chunksUsed} مقطعاً) إلى الامتحان الشامل «${exam.title}» — كلها بانتظار المراجعة؛ ${generated.rejectedCount + truncated} سؤالاً لم يُحفظ بعد التدقيق والسقف`,
    )
    return NextResponse.json({
      ok: true,
      source: 'AI_INTERNET',
      imported: saved.imported,
      requested: generated.requested,
      accepted: saved.imported,
      ...(comprehensive ? { axisRemaining: saved.axisRemaining, examFull: saved.examFull, skipped: !saved.permitted } : {}),
      rejected: generated.rejected,
      rejectedCount: generated.rejectedCount + truncated,
      provider: generated.provider || null,
      model: generated.model || null,
      search: {
        topic,
        resultsFound: generated.search.resultsFound,
        chunksUsed: generated.search.chunksUsed,
        creditsUsed: search.creditsUsed,
        ...(comprehensive ? { distinctDomains, researchDirections: 3 } : {}),
      },
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('comprehensive exam internet error:', e)
    return NextResponse.json({ error: 'تعذر توليد الأسئلة من البحث عبر الإنترنت' }, { status: 500 })
  }
}
