import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { audit } from '@/lib/notify'
import { decryptSecret, isEncryptedSecret } from '@/lib/secret-crypto'
import { searchTavily, TavilySearchError } from '@/lib/tavily-search'
import {
  INTERNET_MAX_SEARCH_RESULTS,
  clampInternetQuestionCount,
  generateInternetQuestions,
  internetSourceId,
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
      select: { id: true, status: true, title: true, programId: true },
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
    const topic = String(body?.topic || '').trim()
    if (!topic) {
      return NextResponse.json({ error: 'اكتب موضوع البحث أولاً' }, { status: 400 })
    }
    const count = clampInternetQuestionCount(body?.count)
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
    try {
      search = await searchTavily({ apiKey, query: topic, maxResults: INTERNET_MAX_SEARCH_RESULTS })
    } catch (e: any) {
      const kind = e instanceof TavilySearchError ? e.kind : 'SERVER'
      console.error('comprehensive exam internet search error:', e)
      return NextResponse.json(
        { error: String(e?.message || 'تعذر البحث عبر الإنترنت — حاول لاحقاً'), code: 'TAVILY_SEARCH_FAILED', tavilyErrorKind: kind },
        { status: 502 },
      )
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
    const program = await db.program.findUnique({ where: { id: exam.programId }, select: { titleAr: true } })
    const previous = await db.comprehensiveExamQuestion.findMany({
      where: { examId: id },
      select: { text: true },
      orderBy: { order: 'asc' },
      take: 80,
    })
    let generated
    try {
      generated = await generateInternetQuestions(
        search.results,
        {
          topic,
          programTitleAr: program?.titleAr || exam.title,
          count,
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
    const last = await db.comprehensiveExamQuestion.findFirst({
      where: { examId: id },
      orderBy: { order: 'desc' },
      select: { order: true },
    })
    let order = last?.order ?? 0
    await db.comprehensiveExamQuestion.createMany({
      data: generated.questions.map((q) => ({
        examId: id,
        order: ++order,
        type: q.type,
        text: q.text,
        options: JSON.stringify(q.options),
        correctAnswer: q.correctAnswer,
        source: 'AI_INTERNET',
        sourceBookId: internetSourceId(topic),
        sourceEvidence: q.sourceEvidence,
        sourceUrl: q.sourceUrl || null,
        status: 'PENDING_REVIEW',
        createdById: admin.id,
      })),
    })
    await audit(
      { id: admin.id, name: admin.name },
      'GENERATE_COMPREHENSIVE_EXAM_QUESTIONS_FROM_INTERNET',
      'ComprehensiveExam',
      id,
      `توليد ${generated.questions.length} سؤالاً من بحث الإنترنت (Tavily) عن «${topic}» (${generated.search.resultsFound} نتيجة، ${generated.search.chunksUsed} مقطعاً) إلى الامتحان الشامل «${exam.title}» — كلها بانتظار المراجعة؛ ${generated.rejectedCount} سؤالاً مرفوضاً بالتحقق`,
    )
    return NextResponse.json({
      ok: true,
      source: 'AI_INTERNET',
      imported: generated.questions.length,
      requested: generated.requested,
      accepted: generated.accepted,
      rejected: generated.rejected,
      rejectedCount: generated.rejectedCount,
      provider: generated.provider || null,
      model: generated.model || null,
      search: {
        topic,
        resultsFound: generated.search.resultsFound,
        chunksUsed: generated.search.chunksUsed,
        creditsUsed: search.creditsUsed,
      },
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('comprehensive exam internet error:', e)
    return NextResponse.json({ error: 'تعذر توليد الأسئلة من البحث عبر الإنترنت' }, { status: 500 })
  }
}
