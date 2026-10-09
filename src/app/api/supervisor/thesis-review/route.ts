import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { getZAI, chatWithRetry } from '@/lib/ai'
import { requireStudentAiSupervisorAccess } from '@/lib/student-ai-access'
import { buildSupervisorContext, mergeContext } from '@/lib/supervisor-ai'
import { summarizeDigestForPrompt } from '@/lib/thesis-context'

// POST /api/supervisor/thesis-review — تحليل وتدقيق مسودة بحث التخرج وتقديم ملاحظات علمية
export async function POST(req: NextRequest) {
  try {
    const user = await requireUser()
    await requireStudentAiSupervisorAccess(user)
    const { title, text } = await req.json()
    const draft = String(text || '').trim()
    if (draft.length < 120) {
      return NextResponse.json(
        { error: 'الصق مسودة بحثك (120 حرفاً على الأقل) ليتمكن المشرف الذكي من تحليلها علمياً' },
        { status: 400 }
      )
    }

    const ragContext = await buildSupervisorContext(user.id)
    const readyThesis = await db.thesisSubmission.findFirst({ where: { userId: user.id, extractionStatus: 'READY' }, orderBy: { updatedAt: 'desc' }, select: { title: true, digest: true, chunks: { where: { status: 'ANALYZED' }, orderBy: { index: 'asc' }, take: 12, select: { index: true, summary: true } } } })
    const reviewText = readyThesis
      ? `Digest البحث الكامل:\n${summarizeDigestForPrompt(readyThesis.digest, 7000)}\n\nملخصات المقاطع:\n${readyThesis.chunks.map((chunk) => `#${chunk.index}: ${chunk.summary || ''}`).join('\n').slice(0, 6000)}`
      : `النص:\n"""${draft.slice(0, 9000)}"""`
    const zai = await getZAI()

    const raw = await chatWithRetry(zai, [
      {
        role: 'assistant',
        content:
          'أنت مشرف أكاديمي محترف يراجع مسودات أبحاث التخرج لطلاب الدراسات العليا. تراجع بدقة علمية وبنّاءة بالعربية الفصحى، وترجع JSON فقط.',
      },
      {
        role: 'user',
        content: `${ragContext ? mergeContext(ragContext) + '\n\n' : ''}راجع مسودة بحث التخرج التالية وقدم تقييماً علمياً معمقاً:
العنوان: ${String(readyThesis?.title || title || 'غير محدد').slice(0, 200)}
${reviewText}

راجع بعناية: (1) وضوح الإشكالية وفرضيات البحث (2) ملاءمة المنهجية وأدوات جمع البيانات (3) تغطية الأدبيات والمراجع (4) صحة التحليل ودقة النتائج وربطها بالإشكالية (5) التطبيق العملي والتوصيات (6) اللغة والتنظيم والتوثيق.

أجب بصيغة JSON فقط بدون أي نص إضافي، وضع scores من 0 إلى 100 لكل معيار:
{
  "scores": {"problem": 0, "methodology": 0, "literature": 0, "analysis": 0, "application": 0, "language": 0},
  "overallScore": <سيتم تجاهله وحسابه في السيرفر>,
  "verdict": "<حكم من سطر: ما الذي يجب فعله قبل المناقشة>",
  "strengths": ["<نقطة قوة 1>", "<نقطة قوة 2>", "<نقطة قوة 3>"],
  "weaknesses": ["<ملاحظة جوهرية تحتاج معالجة 1>", "<2>", "<3>"],
  "methodology": "<تعليق مفصل على المنهجية وكيفية تقويتها 2-3 جمل>",
  "sources": "<تعليق على الأدبيات والتوثيق والتوصية بمراجع معينة من مجال البحث 2 جمل>",
  "nextSteps": ["<خطوة عملية 1 قبل المناقشة>", "<2>", "<3>"]
}`,
      },
    ])

    let parsed: any
    try {
      const match = raw.match(/\{[\s\S]*\}/)
      if (!match) throw new Error('NO_JSON')
      parsed = JSON.parse(match[0])
    } catch {
      return NextResponse.json(
        { error: 'تعذر إنتاج التحليل — قصّر النص قليلاً أو أعد المحاولة' },
        { status: 502 }
      )
    }

    const weights: Record<string, number> = { problem: 20, methodology: 20, literature: 15, analysis: 20, application: 10, language: 15 }
    const scores = parsed?.scores || {}
    const weightedScore = Object.entries(weights).reduce((sum, [key, weight]) => sum + Math.max(0, Math.min(100, Number(scores[key]) || 0)) * weight, 0) / 100

    const feedback =
      `تحليل مسودة البحث «${String(readyThesis?.title || title || 'بدون عنوان')}»\n\n` +
      `التقييم العام: ${Math.round(weightedScore)}/100 — ${parsed.verdict || ''}\n\n` +
      `نقاط القوة:\n${(parsed.strengths || []).map((s: string) => `- ${s}`).join('\n')}\n\n` +
      `ملاحظات جوهرية:\n${(parsed.weaknesses || []).map((s: string) => `- ${s}`).join('\n')}\n\n` +
      `المنهجية: ${parsed.methodology || ''}\n\n` +
      `الأدبيات والتوثيق: ${parsed.sources || ''}\n\n` +
      `خطوات قبل المناقشة:\n${(parsed.nextSteps || []).map((s: string, i: number) => `${i + 1}. ${s}`).join('\n')}`

    // حفظ التحليل في سجل المشرف الذكي (ملف الطالب) — متاح للإدارة والمشرف البشري
    await db.chatMessage.createMany({
      data: [
        {
          userId: user.id,
          role: 'user',
          kind: 'THESIS_REVIEW',
          mode: 'TEXT',
          content: `قدّمت مسودة بحثي للتحليل: «${String(title || 'بدون عنوان')}» — (${draft.length} حرفاً)`,
        },
        { userId: user.id, role: 'assistant', kind: 'THESIS_REVIEW', mode: 'TEXT', content: feedback.slice(0, 6000) },
      ],
    })

    return NextResponse.json({
      ok: true,
      review: {
        overallScore: Math.max(0, Math.min(100, Number(parsed.overallScore) || 0)),
        verdict: String(parsed.verdict || ''),
        strengths: (parsed.strengths || []).slice(0, 4).map(String),
        weaknesses: (parsed.weaknesses || []).slice(0, 4).map(String),
        methodology: String(parsed.methodology || ''),
        sources: String(parsed.sources || ''),
        nextSteps: (parsed.nextSteps || []).slice(0, 4).map(String),
        text: feedback,
      },
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'يجب تسجيل الدخول أولاً' }, { status: 401 })
    }
    if (String(e?.message || '').includes('AI_SUPERVISOR_LOCKED')) {
      return NextResponse.json({ error: e?.reason || 'المشرف الذكي غير مفعل لهذا الطالب بعد.' }, { status: e?.status || 403 })
    }
    console.error('thesis-review error:', e)
    return NextResponse.json({ error: 'خطأ في تحليل المسودة — أعد المحاولة' }, { status: 500 })
  }
}
