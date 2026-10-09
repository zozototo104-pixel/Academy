import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { textAiComplete, textAiCompleteJson } from '@/lib/text-ai'
import { notify, audit } from '@/lib/notify'
import { storeFileBuffer, storageErrorMessage } from '@/lib/storage'
import { buildSupervisorContext, mergeContext, buildSupervisorPersonaBlock, updateStudentAcademicMemory } from '@/lib/supervisor-ai'
import { AI_RATE_LIMITS, base64DecodedSize, enforceUserAiRateLimit } from '@/lib/ai-rate-limits'
import { findRelevantThesisChunks, getThesisDigest, scoreDefenseBreakdown, summarizeDigestForPrompt } from '@/lib/thesis-context'

const QUESTIONS_COUNT = 5 // عدد أسئلة اللجنة
const DEFENSE_CRITERIA = ['methodology', 'results', 'contribution', 'literature', 'presentation'] as const
const DEFENSE_CRITERIA_LABELS: Record<typeof DEFENSE_CRITERIA[number], string> = { methodology: 'منهجية', results: 'نتائج', contribution: 'إسهام', literature: 'أدبيات', presentation: 'عرض' }

type DefenseEvaluation = { score: number | null; feedback: string; nextQuestion: string; unavailable?: boolean }

function finiteScore(value: unknown): number | null {
  const score = Number(value)
  return Number.isFinite(score) ? Math.max(0, Math.min(10, score)) : null
}

function scoreLabel(score: number | null): string {
  return score == null ? 'غير متاح — يحتاج مراجعة اللجنة البشرية' : `${score}/100`
}

// GET /api/defense — حالة قاعة المناقشة للطالب الحالي
export async function GET() {
  try {
    const user = await requireUser()
    const thesis = await db.thesisSubmission.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
    })
    if (!thesis) return NextResponse.json({ error: 'لا يوجد بحث تخرج بعد' }, { status: 404 })
    if (thesis.status !== 'SCHEDULED' || !thesis.defenseDate) {
      return NextResponse.json({ error: 'لم تُجدول مناقشتك بعد — انتظر إشعار الجدولة' }, { status: 400 })
    }
    const messages = await db.defenseMessage.findMany({
      where: { thesisId: thesis.id },
      orderBy: { createdAt: 'asc' },
    })
    return NextResponse.json({
      thesis: {
        id: thesis.id,
        title: thesis.title,
        abstract: thesis.abstract,
        defenseDate: thesis.defenseDate,
        committee: thesis.committee,
        agentMember: thesis.agentMember,
        defenseStatus: thesis.defenseStatus,
        aiScore: thesis.aiScore,
        aiRecommendation: thesis.aiRecommendation,
        defenseMinutes: thesis.defenseMinutes,
        recordingSize: thesis.recordingSize,
        resultScore: thesis.resultScore,
      },
      messages,
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'يجب تسجيل الدخول' }, { status: 401 })
    }
    console.error('defense GET error:', e)
    return NextResponse.json({ error: 'تعذر تحميل قاعة المناقشة' }, { status: 500 })
  }
}

// POST /api/defense — بدء الجلسة / إجابة الطالب / إنهاء الجلسة
export async function POST(req: NextRequest) {
  try {
    const user = await requireUser()
    const { action, text, userText, aiText, model, dataUrl, mime, durationSec } = await req.json()
    const limited = enforceUserAiRateLimit(
      req,
      action === 'save-recording' ? AI_RATE_LIMITS.defenseRecording : AI_RATE_LIMITS.defense,
      user.id
    )
    if (limited) return limited

    const thesis = await db.thesisSubmission.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
    })
    if (!thesis) return NextResponse.json({ error: 'لا يوجد بحث تخرج بعد' }, { status: 404 })
    if (thesis.status !== 'SCHEDULED') {
      return NextResponse.json({ error: 'مناقشتك غير مجدولة' }, { status: 400 })
    }
    if (['start', 'answer', 'end'].includes(String(action)) && thesis.extractionStatus !== 'READY') {
      return NextResponse.json({ error: 'يجب رفع البحث ومعالجته قبل المناقشة' }, { status: 409 })
    }

    // نافذة الدخول: يُسمح ببدء الجلسة من 15 دقيقة قبل الموعد المحدد (وليس قبلها)
    if (action === 'start' && thesis.defenseDate) {
      const opensAt = new Date(thesis.defenseDate).getTime() - 15 * 60_000
      if (Date.now() < opensAt) {
        const when = new Date(thesis.defenseDate).toLocaleString('ar', { dateStyle: 'full', timeStyle: 'short' })
        return NextResponse.json(
          { error: `قاعة المناقشة تُفتح قبل موعدك بـ15 دقيقة — موعد مناقشتك: ${when}` },
          { status: 400 }
        )
      }
    }

    // ===== بدء الجلسة: خبير الذكاء الاصطناعي يفتح ويطرح السؤال الأول =====
    if (action === 'start') {
      if (thesis.defenseStatus === 'IN_PROGRESS') {
        const existing = await db.defenseMessage.findMany({ where: { thesisId: thesis.id }, orderBy: { createdAt: 'asc' } })
        return NextResponse.json({ ok: true, resumed: true, messages: existing })
      }
      if (thesis.defenseStatus === 'COMPLETED') {
        return NextResponse.json({ error: 'انتهت مناقشتك مسبقاً — النتيجة لدى اللجنة' }, { status: 400 })
      }
      await db.defenseMessage.deleteMany({ where: { thesisId: thesis.id } })
      const digest = await getThesisDigest(thesis.id)
      const digestContext = summarizeDigestForPrompt(digest, 6000)
      const rag = await buildSupervisorContext(user.id, { scope: 'DEFENSE_EXAMINER', query: `${thesis.title} ${digestContext.slice(0, 500)}` }).catch(() => '')
      const defenseAcademicContext = mergeContext(
        rag,
        `وضع المشرف الحالي: عضو لجنة مناقشة بحث تخرج.\nعنوان البحث: ${thesis.title}.\nDigest البحث الكامل:\n${digestContext}\nاستخدم digest وخريطة الأقسام في صياغة الأسئلة، مع بقاء القرار النهائي للجنة البشرية.`
      )
      const opening = await aiOpening(thesis.title, digestContext, defenseAcademicContext)
      await db.thesisSubmission.update({
        where: { id: thesis.id },
        data: { defenseStatus: 'IN_PROGRESS' },
      })
      await db.defenseMessage.create({
        data: {
          thesisId: thesis.id,
          role: 'SYSTEM',
          content: `بدأت جلسة المناقشة عبر الفيديو كونفرنس — ${QUESTIONS_COUNT} أسئلة من لجنة المناقشة وخبير الذكاء الاصطناعي`,
        },
      })
      await db.defenseMessage.create({
        data: { thesisId: thesis.id, role: 'AI_EXPERT', content: opening },
      })
      await audit({ id: user.id, name: user.name }, 'START_DEFENSE', 'ThesisSubmission', thesis.id, thesis.title)
      const messages = await db.defenseMessage.findMany({ where: { thesisId: thesis.id }, orderBy: { createdAt: 'asc' } })
      return NextResponse.json({ ok: true, messages })
    }

    // ===== إجابة الطالب: تقييم + السؤال التالي =====
    if (action === 'answer') {
      if (thesis.defenseStatus !== 'IN_PROGRESS') {
        return NextResponse.json({ error: 'ابدأ جلسة المناقشة أولاً' }, { status: 400 })
      }
      const answer = String(text || '').trim()
      if (!answer) return NextResponse.json({ error: 'اكتب إجابتك أو تحدث صوتياً' }, { status: 400 })

      const history = await db.defenseMessage.findMany({
        where: { thesisId: thesis.id, role: { in: ['AI_EXPERT', 'STUDENT'] } },
        orderBy: { createdAt: 'asc' },
      })
      const lastQuestion = [...history].reverse().find((m) => m.role === 'AI_EXPERT')
      const answeredCount = history.filter((m) => m.role === 'STUDENT').length

      const criterion = DEFENSE_CRITERIA[Math.min(answeredCount, DEFENSE_CRITERIA.length - 1)]
      const digest = await getThesisDigest(thesis.id)
      const related = await findRelevantThesisChunks(thesis.id, `${lastQuestion?.content || ''} ${answer} ${DEFENSE_CRITERIA_LABELS[criterion]}`, 2)
      const relatedContext = related.map((chunk) => `مقطع #${chunk.index} صفحات ${chunk.pageStart ?? '-'}-${chunk.pageEnd ?? '-'}:\n${(chunk.summary || chunk.text).slice(0, 1800)}`).join('\n\n')
      const rag = await buildSupervisorContext(user.id, { scope: 'DEFENSE_EXAMINER', query: `${thesis.title} ${lastQuestion?.content || ''} ${answer}` }).catch(() => '')
      const defenseAcademicContext = mergeContext(
        rag,
        `وضع المشرف الحالي: عضو لجنة مناقشة بحث تخرج.\nعنوان البحث: ${thesis.title}.\nDigest:\n${summarizeDigestForPrompt(digest, 4500)}\n\nمقاطع ذات صلة:\n${relatedContext}\n\nالسؤال الحالي: ${lastQuestion?.content || 'غير محدد'}.\nقيّم وفق معيار ${criterion} (${DEFENSE_CRITERIA_LABELS[criterion]}).`
      )
      const result = await aiEvaluate(thesis.title, summarizeDigestForPrompt(digest, 2000), lastQuestion?.content || '', answer, answeredCount + 1, QUESTIONS_COUNT, defenseAcademicContext, criterion)

      await db.defenseMessage.create({
        data: { thesisId: thesis.id, role: 'STUDENT', content: answer, score: result.score },
      })

      if (answeredCount + 1 >= QUESTIONS_COUNT) {
        // آخر إجابة → ختام الجلسة والتوصية والمحضر التلقائي
        const priorScores = history
          .filter((m) => m.role === 'STUDENT')
          .map((m) => finiteScore(m.score))
          .filter((score): score is number => score != null)
        const currentScore = finiteScore(result.score)
        const scores = currentScore == null ? priorScores : [...priorScores, currentScore]
        const weighted = scoreDefenseBreakdown(scores.map((score, index) => ({ criterion: DEFENSE_CRITERIA[Math.min(index, DEFENSE_CRITERIA.length - 1)], score0to10: score })))
        const aiScore = weighted.score
        const rec = await aiRecommendation(thesis.title, user.name, aiScore, scores.length, result.feedback, defenseAcademicContext)
        const minutes = await aiMinutes(thesis.id, thesis.title, user.name, thesis.defenseDate, defenseAcademicContext)
        await db.thesisSubmission.update({
          where: { id: thesis.id },
          data: {
            defenseStatus: 'COMPLETED',
            aiScore,
            aiRecommendation: rec,
            defenseBreakdown: weighted as any,
            defenseMinutes: minutes,
            defenseCompletedAt: new Date(),
          },
        })
        await db.defenseMessage.create({
          data: { thesisId: thesis.id, role: 'AI_EXPERT', content: `شكراً لك. انتهت أسئلة اللجنة.\n\n${result.feedback}\n\n${rec}` },
        })
        if (aiScore != null) {
          await updateStudentAcademicMemory(user.id, {
            kind: 'DEFENSE',
            persona: 'DEFENSE',
            thesisTitle: thesis.title,
            score: aiScore,
            passed: aiScore >= 60,
            summary: `${result.feedback}\n${rec}`,
            strengths: aiScore >= 80 ? ['أداء قوي في مناقشة بحث التخرج'] : [],
            weaknesses: aiScore < 60 ? ['تحتاج إجابات المناقشة إلى ضبط المنهجية والنتائج والربط العملي'] : [],
            concepts: aiScore < 70 ? ['منهجية البحث', 'عرض النتائج', 'ربط التوصيات بالتطبيق'] : [],
            nextActions: ['مراجعة محضر المناقشة وتنفيذ ملاحظات اللجنة قبل الاعتماد النهائي'],
          }).catch(() => {})
        }
        await notify(
          user.id,
          'DEFENSE',
          'انتهت جلسة المناقشة',
          `أنهيت أسئلة اللجنة عبر الفيديو كونفرنس — تقييم خبير الذكاء الاصطناعي: ${scoreLabel(aiScore)}. تُعرض توصية خبير الذكاء على اللجنة لاعتماد النتيجة النهائية.`,
          'dashboard'
        )
        await audit({ id: user.id, name: user.name }, 'COMPLETE_DEFENSE', 'ThesisSubmission', thesis.id, `تقييم AI: ${scoreLabel(aiScore)}`)
      } else {
        const interactiveReply = [
          result.feedback ? `تعليق اللجنة: ${result.feedback}` : '',
          result.nextQuestion,
        ].filter(Boolean).join('\n\n')
        await db.defenseMessage.create({
          data: { thesisId: thesis.id, role: 'AI_EXPERT', content: interactiveReply },
        })
      }

      const messages = await db.defenseMessage.findMany({ where: { thesisId: thesis.id }, orderBy: { createdAt: 'asc' } })
      const thesisUpdated = await db.thesisSubmission.findUnique({ where: { id: thesis.id } })
      return NextResponse.json({
        ok: true,
        messages,
        completed: thesisUpdated?.defenseStatus === 'COMPLETED',
        aiScore: thesisUpdated?.aiScore,
        aiRecommendation: thesisUpdated?.aiRecommendation,
        minutes: thesisUpdated?.defenseMinutes,
      })
    }

    // ===== إنهاء مبكر بناءً على ما تم + محضر تلقائي =====
    if (action === 'end') {
      if (thesis.defenseStatus !== 'IN_PROGRESS') {
        return NextResponse.json({ error: 'لا توجد جلسة جارية' }, { status: 400 })
      }
      const studentMsgs = await db.defenseMessage.findMany({ where: { thesisId: thesis.id, role: 'STUDENT' } })
      const scores = studentMsgs
        .map((m) => finiteScore(m.score))
        .filter((score): score is number => score != null)
      const aiScore = scores.length ? Math.round((scores.reduce((s, x) => s + x, 0) / scores.length) * 10) : null
      const rag = await buildSupervisorContext(user.id, { scope: 'DEFENSE_EXAMINER', query: `${thesis.title} جلسة مناقشة منتهية مبكراً` }).catch(() => '')
      const defenseAcademicContext = mergeContext(
        rag,
        `وضع المشرف الحالي: عضو لجنة مناقشة بحث تخرج.\nعنوان البحث: ${thesis.title}.\nالجلسة انتهت مبكراً؛ اربط التوصية بملف الطالب ونتائجه وبحثه دون إصدار قرار نهائي بدلاً من اللجنة البشرية.`
      )
      const rec = await aiRecommendation(thesis.title, user.name, aiScore, scores.length, 'جلسة مبتورة — أنهى الطالب الجلسة مبكراً.', defenseAcademicContext)
      const minutes = await aiMinutes(thesis.id, thesis.title, user.name, thesis.defenseDate, defenseAcademicContext)
      await db.thesisSubmission.update({
        where: { id: thesis.id },
        data: { defenseStatus: 'COMPLETED', aiScore, aiRecommendation: rec, defenseMinutes: minutes, defenseCompletedAt: new Date() },
      })
      await db.defenseMessage.create({
        data: { thesisId: thesis.id, role: 'SYSTEM', content: `أنهى الطالب الجلسة — تقييم على الأسئلة المجاب عنها: ${scoreLabel(aiScore)} — تم توليد محضر الجلسة وأرشفته في ملف البحث` },
      })
      if (aiScore != null) {
        await updateStudentAcademicMemory(user.id, {
          kind: 'DEFENSE',
          persona: 'DEFENSE',
          thesisTitle: thesis.title,
          score: aiScore,
          passed: aiScore >= 60,
          summary: rec,
          weaknesses: ['جلسة مناقشة منتهية مبكراً؛ يحتاج المشرف إلى مراجعة المحضر قبل القرار النهائي'],
          concepts: ['إدارة وقت المناقشة', 'عرض المنهجية والنتائج بإيجاز'],
          nextActions: ['مراجعة سبب إنهاء الجلسة مبكراً وتحديد هل يحتاج الطالب إلى موعد متابعة'],
        }).catch(() => {})
      }
      await notify(user.id, 'DEFENSE', 'أنهيت جلسة المناقشة', `تقييم أولي ${scoreLabel(aiScore)} — محضر الجلسة تولّد تلقائياً وأُرشف في ملف بحثك مع تسجيل الجلسة.`, 'dashboard')
      const messages = await db.defenseMessage.findMany({ where: { thesisId: thesis.id }, orderBy: { createdAt: 'asc' } })
      return NextResponse.json({ ok: true, messages, completed: true, aiScore, aiRecommendation: rec, minutes })
    }

    // ===== 12.3: تفريغ صوتي حي (Live Transcription) + رد مباشر من المستشار الذكي =====
    if (action === 'transcript') {
      if (thesis.defenseStatus !== 'IN_PROGRESS') {
        return NextResponse.json({ error: 'ابدأ جلسة المناقشة أولاً' }, { status: 400 })
      }
      const transcriptText = String(text || '').trim()
      if (!transcriptText) return NextResponse.json({ error: 'نص التفريغ فارغ' }, { status: 400 })
      await db.defenseMessage.create({
        data: { thesisId: thesis.id, role: 'TRANSCRIPT', content: transcriptText.slice(0, 3000) },
      })

      // لا نترك الواجهة تنتظر طلباً ثانياً؛ بعد حفظ كلام الطالب نولّد مداخلة اللجنة هنا مباشرة.
      let savedNote: any = null
      const lastNote = await db.defenseMessage.findFirst({
        where: { thesisId: thesis.id, role: 'AI_NOTE' },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      })
      const secondsFromLastNote = lastNote ? (Date.now() - new Date(lastNote.createdAt).getTime()) / 1000 : 999
      const cleanText = transcriptText.replace(/\s+/g, ' ')
      // تفاعل حي: لا ننتظر زر إرسال الإجابة. كل وقفة كلامية مفهومة تولّد مداخلة قصيرة من المستشار.
      if (secondsFromLastNote >= 3 && cleanText.length >= 6) {
        const note = await Promise.race([
          aiLiveNote(thesis.title, thesis.abstract, thesis.id, user.id, transcriptText),
          new Promise<string | null>((resolve) => setTimeout(() => resolve(fallbackLiveIntervention(transcriptText)), 4500)),
        ])
        if (note) {
          savedNote = await db.defenseMessage.create({
            data: { thesisId: thesis.id, role: 'AI_NOTE', content: note },
          })
        }
      }
      return NextResponse.json({ ok: true, note: savedNote })
    }

    // ===== 12.3: ملاحظة تحليلية حية من المستشار الذكي للجنة =====
    if (action === 'ai-note') {
      if (thesis.defenseStatus !== 'IN_PROGRESS') {
        return NextResponse.json({ error: 'ابدأ جلسة المناقشة أولاً' }, { status: 400 })
      }
      const note = await aiLiveNote(thesis.title, thesis.abstract, thesis.id, user.id)
      if (note) {
        const saved = await db.defenseMessage.create({
          data: { thesisId: thesis.id, role: 'AI_NOTE', content: note },
        })
        return NextResponse.json({ ok: true, note: saved })
      }
      return NextResponse.json({ ok: true, note: null })
    }

    // ===== 12.3: دور صوتي متدفق عبر Gemini Live داخل المناقشة =====
    if (action === 'live-turn') {
      if (thesis.defenseStatus !== 'IN_PROGRESS') {
        return NextResponse.json({ error: 'ابدأ جلسة المناقشة أولاً' }, { status: 400 })
      }
      const u = String(userText || '').trim()
      const a = String(aiText || '').trim()
      const created: any[] = []
      if (u) {
        created.push(await db.defenseMessage.create({
          data: { thesisId: thesis.id, role: 'TRANSCRIPT', content: `محادثة صوتية مباشرة: ${u.slice(0, 3000)}` },
        }))
      }
      if (a) {
        created.push(await db.defenseMessage.create({
          data: { thesisId: thesis.id, role: 'AI_NOTE', content: `مداخلة صوتية مباشرة: ${a.slice(0, 3000)}` },
        }))
      }
      await audit({ id: user.id, name: user.name }, 'DEFENSE_LIVE_VOICE_TURN', 'ThesisSubmission', thesis.id, `${String(model || 'Gemini Live')} — ${u.slice(0, 120)}`).catch(() => {})
      return NextResponse.json({ ok: true, messages: created })
    }

    // ===== 12.3: أرشفة تسجيل الجلسة (فيديو + صوت) في ملف الطالب =====
    if (action === 'save-recording') {
      if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
        return NextResponse.json({ error: 'بيانات التسجيل غير صالحة' }, { status: 400 })
      }
      const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
      const recordingMime = String(mime || 'video/webm').slice(0, 60)
      const estimatedSize = base64DecodedSize(base64)
      if (estimatedSize > 24 * 1024 * 1024) {
        return NextResponse.json({ error: 'حجم التسجيل يتجاوز 24 ميجابايت — لن تُأرشف (جلسة طويلة جداً)' }, { status: 413 })
      }
      const buffer = Buffer.from(base64, 'base64')
      const size = buffer.byteLength
      if (size > 24 * 1024 * 1024) {
        return NextResponse.json({ error: 'حجم التسجيل يتجاوز 24 ميجابايت — لن تُأرشف (جلسة طويلة جداً)' }, { status: 413 })
      }
      let stored
      try {
        stored = await storeFileBuffer({
          namespace: `defense-recordings/${user.id}`,
          buffer,
          fileName: `defense-${thesis.id}.webm`,
          mimeType: recordingMime,
        })
      } catch (storageError) {
        return NextResponse.json({ error: storageErrorMessage(storageError) }, { status: 500 })
      }
      await db.thesisSubmission.update({
        where: { id: thesis.id },
        data: {
          recordingData: null,
          recordingStorageProvider: stored.provider,
          recordingStorageKey: stored.key,
          recordingUrl: stored.url,
          recordingMime,
          recordingSize: size,
          recordingDurationSec: Number(durationSec) > 0 ? Math.round(Number(durationSec)) : null,
        },
      })
      await audit({ id: user.id, name: user.name }, 'ARCHIVE_DEFENSE_RECORDING', 'ThesisSubmission', thesis.id, `أرشفة تسجيل جلسة المناقشة (${Math.round(size / 1024)} ك.ب)`)
      return NextResponse.json({ ok: true, size })
    }

    return NextResponse.json({ error: 'إجراء غير معروف' }, { status: 400 })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'يجب تسجيل الدخول' }, { status: 401 })
    }
    console.error('defense POST error:', e)
    return NextResponse.json({ error: 'تعذر تنفيذ الإجراء في قاعة المناقشة' }, { status: 500 })
  }
}

// ===== أدوات خبير الذكاء الاصطناعي =====

async function aiOpening(title: string, abstract: string, studentAcademicContext?: string): Promise<string> {
  try {
    const text = await textAiComplete({
      system: `${buildSupervisorPersonaBlock('DEFENSE')}\n\nأنت خبير ذكاء اصطناعي عضو لجنة مناقشة أكاديمية محترفة تتحدث العربية الفصحى.`,
      history: [{
        role: 'user',
        text: `${studentAcademicContext ? `${studentAcademicContext.slice(0, 6500)}\n\n` : ''}افتتح جلسة مناقشة بحث التخرج بعنوان «${title}» بجملة ترحيب رسمية قصيرة، ثم اطرح السؤال الأول (من أصل ${QUESTIONS_COUNT}).
السؤال الأول يجب أن يكون عن دوافع اختيار الموضوع وأهميته العملية، ويراعي تخصص الطالب وكتبه ونتائجه إن ظهرت في السياق.
ملخص البحث: ${abstract.slice(0, 1200)}

اكتب: ترحيب من سطرين + "السؤال الأول:" ثم السؤال. بدون أي تنسيق Markdown.`,
      }],
      temperature: 0.3,
      maxOutputTokens: 900,
      taskLevel: 'ACADEMIC_DRAFT',
    })
    return text.trim() || defaultQuestion(1)
  } catch {
    return defaultQuestion(1)
  }
}

function defaultQuestion(n: number): string {
  const qs = [
    'حدّثنا عن دوافع اختيارك لهذا الموضوع وأهميته في مجالك.',
    'ما المشكلة الرئيسية التي يعالجها بحثك وما منهجيتك في معالجتها؟',
    'ما أبرز النتائج التي توصلت إليها؟',
    'كيف يمكن تطبيق توصيات بحثك عملياً في الواقع؟',
    'ما حدود بحثك وما الآفاق المستقبلية التي تقترحها؟',
  ]
  return `السؤال ${n}: ${qs[Math.min(n - 1, qs.length - 1)]}`
}

async function aiEvaluate(
  title: string,
  abstract: string,
  question: string,
  answer: string,
  qNum: number,
  total: number,
  studentAcademicContext?: string
): Promise<DefenseEvaluation> {
  try {
    const raw = await textAiCompleteJson({
      system: `${buildSupervisorPersonaBlock('DEFENSE')}\n\nأنت خبير ذكاء اصطناعي عضو لجنة مناقشة أكاديمية، تقيّم إجابات الطلاب بموضوعية وتطرح الأسئلة التالية. ترجع JSON فقط.`,
      history: [{
        role: 'user',
        text: `${studentAcademicContext ? `${studentAcademicContext.slice(0, 6500)}\n\n` : ''}بحث: «${title}»
الملخص: ${abstract.slice(0, 1000)}
السؤال المطروح: ${question}
إجابة الطالب: ${answer.slice(0, 2500)}
هذا السؤال رقم ${qNum} من ${total}.

قيّم الإجابة من 10 (الدقة العلمية، وضوح الفكرة، الربط بالبحث، العمق). لا تنتقل للسؤال التالي مباشرة: اكتب تعليقاً تفاعلياً كعضو لجنة يبيّن رأيك في الإجابة، نقطة قوة أو خلل محدد، وما الذي يحتاجه الطالب لضبط كلامه، ثم اطرح السؤال التالي المنطقي حسب تسلسل المناقشة (الأهمية ← المشكلة والمنهجية ← النتائج ← التطبيق ← الحدود والآفاق).

أجب بصيغة JSON فقط:
{"score": <0-10>, "feedback": "<تعليق تفاعلي من جملتين إلى ثلاث على إجابة الطالب>", "nextQuestion": "<السؤال التالي مسبوق بـ: السؤال ${qNum + 1}: >"}`,
      }],
      temperature: 0.15,
      maxOutputTokens: 1400,
      taskLevel: 'ACADEMIC_CRITICAL',
    })
    const match = raw.match(/\{[\s\S]*\}/)
    if (!match) throw new Error('NO_JSON')
    const parsed = JSON.parse(match[0])
    const score = finiteScore(parsed.score)
    if (score == null) throw new Error('NO_SCORE')
    return {
      score,
      feedback: String(parsed.feedback || '').slice(0, 800),
      nextQuestion: String(parsed.nextQuestion || defaultQuestion(qNum + 1)).slice(0, 1200),
    }
  } catch {
    return {
      score: null,
      unavailable: true,
      feedback: 'تعذر توليد تقييم رقمي صالح من خبير الذكاء الاصطناعي لهذه الإجابة؛ لن تدخل هذه الإجابة في المتوسط الآلي، ويجب أن تراجعها اللجنة البشرية من التسجيل والمحضر.',
      nextQuestion: defaultQuestion(qNum + 1),
    }
  }
}

async function aiRecommendation(title: string, name: string, aiScore: number | null, answered: number, lastFeedback: string, studentAcademicContext?: string): Promise<string> {
  const verdict =
    aiScore == null
      ? 'تعذر إصدار توصية رقمية آلية — يلزم اعتماد اللجنة البشرية'
      : aiScore >= 80
        ? 'توصية بالقبول والاجتياز'
        : aiScore >= 60
          ? 'توصية بالقبول مع ملاحظات'
          : 'توصية بمراجعة البحث وإعادة المناقشة'
  try {
    const text = await textAiComplete({
      system: `${buildSupervisorPersonaBlock('DEFENSE')}\n\nأنت خبير ذكاء اصطناعي عضو لجنة مناقشة، تكتب توصية رسمية موجزة للجنة.`,
      history: [{
        role: 'user',
        text: `${studentAcademicContext ? `${studentAcademicContext.slice(0, 6500)}\n\n` : ''}اكتب توصية رسمية موجزة (3-4 جمل) للجنة المناقشة بشأن بحث الطالب/ة ${name} بعنوان «${title}»:
- التقييم العام عبر الأسئلة: ${scoreLabel(aiScore)} (${answered} أسئلة ذات تقييم صالح)
- آخر ملاحظة: ${lastFeedback}
- الحكم العام: ${verdict}

ابدأ بعبارة «توصية خبير الذكاء الاصطناعي للجنة:». بدون Markdown.`,
      }],
      temperature: 0.3,
      maxOutputTokens: 900,
      taskLevel: 'ACADEMIC_CRITICAL',
    })
    return text.trim().slice(0, 1500)
  } catch {
    return 'تعذر إصدار توصية آلية موثوقة. يجب أن تصدر التوصية من اللجنة البشرية بعد مراجعة تسجيل الجلسة وإجابات الطالب.'
  }
}

function fallbackLiveIntervention(latestChunk: string): string | null {
  const latest = String(latestChunk || '').trim()
  if (latest.length < 6) return null
  if (/مش\s*عارف|لا\s*اعرف|ما\s*بعرف|مش\s*فاهم|لا\s*أعرف/i.test(latest)) {
    return 'مداخلة المستشار الذكي: لا مشكلة، توقف هنا لحظة. حاول أن تعيد الفكرة بجملة واحدة: ما موضوع بحثك، وما المشكلة التي تريد حلها تحديداً؟'
  }
  if (/السلام|مرحبا|اهلا|أهلا/i.test(latest) && latest.length < 40) {
    return 'مداخلة المستشار الذكي: أهلاً بك. لنبدأ عملياً: عرّفني بموضوع بحثك في جملة واضحة، ثم قل لماذا اخترته.'
  }
  if (/يعني|قصدي|اقصد/i.test(latest)) {
    return 'مداخلة المستشار الذكي: فهمت أنك تحاول ضبط الفكرة. اسمح لي أقاطعك هنا: اربط ما تقوله مباشرة بسؤال البحث أو بالنتيجة التي وصلت إليها.'
  }
  return 'مداخلة المستشار الذكي: النقطة وصلت، لكن أريد منك توضيحها أكاديمياً أكثر. ما الدليل من بحثك أو المثال العملي الذي يؤيد كلامك؟'
}

// ===== 12.3: مداخلة حية من المستشار الذكي داخل المناقشة =====
// يسمع التفريغ الحي ويعلّق كعضو لجنة: رأي، تصحيح، مقاطعة لطيفة، أو سؤال متابعة قصير.
async function aiLiveNote(title: string, abstract: string, thesisId: string, userId: string, latestChunk = ''): Promise<string | null> {
  try {
    const latest = String(latestChunk || '').trim().slice(0, 900)
    const history = await db.defenseMessage.findMany({
      where: { thesisId, role: { in: ['AI_EXPERT', 'STUDENT', 'TRANSCRIPT', 'AI_NOTE'] } },
      orderBy: { createdAt: 'desc' },
      take: 14,
    })
    const dialog = history
      .reverse()
      .map((m) => `${m.role === 'AI_EXPERT' ? 'اللجنة/المستشار' : m.role === 'AI_NOTE' ? 'مداخلة سابقة للمستشار' : m.role === 'STUDENT' ? 'إجابة الطالب' : 'كلام الطالب المباشر'}: ${m.content.slice(0, 500)}`)
      .join('\n')
    if (`${dialog} ${latest}`.length < 45) return null

    const rag = await buildSupervisorContext(userId, { scope: 'DEFENSE_EXAMINER', query: `${title} ${latest}` })
    const text = await textAiComplete({
      system: `${buildSupervisorPersonaBlock('DEFENSE')}\n\nأنت المستشار الذكي حاضر كعضو لجنة مناقشة فعلي بصوت داخل القاعة. لا تكتفي بطرح أسئلة؛ تفاعل مع كلام الطالب كما يفعل عضو اللجنة: قاطع بلطف عند الحاجة، علّق، أبدِ رأياً أكاديمياً، صحح مسار الإجابة، ثم اطرح سؤال متابعة قصيراً عند اللزوم. القرار النهائي يبقى للجنة البشرية. ترجع نصاً عربياً فقط بدون Markdown.`,
      history: [{
        role: 'user',
        text: `${rag ? mergeContext(rag) + '\n\n' : ''}بحث: «${title}» — الملخص: ${abstract.slice(0, 900)}

آخر كلام مباشر قاله الطالب الآن:
${latest || 'غير متوفر'}

أحدث ما جرى في الجلسة:
${dialog.slice(0, 4500)}

اكتب مداخلة صوتية مباشرة للطالب من جملتين إلى ثلاث فقط، كأنك داخل قاعة مناقشة:
- علّق على آخر كلام قاله الطالب تحديداً، لا على البحث بشكل عام.
- إن كان كلامه ضعيفاً: قل له أين الخلل واطلب توضيحاً محدداً.
- إن كان جيداً: عزّز الفكرة ثم اطلب ربطها بالمنهجية أو النتائج.
- يجوز أن تقول: "اسمح لي أقاطعك هنا" أو "النقطة جيدة لكن تحتاج ضبطاً" عندما يناسب السياق.
- لا تبدأ سؤالاً رسمياً مرقماً، ولا تكرر الأسئلة الخمسة الأساسية.
- لا تذكر أنك مجرد نموذج أو خدمة.

ابدأ بعبارة «مداخلة المستشار الذكي:».`,
      }],
      temperature: 0.3,
      maxOutputTokens: 900,
      taskLevel: 'ACADEMIC_DRAFT',
    })
    const note = text.trim()
    return note && note.length > 30 ? note.slice(0, 900) : null
  } catch (e) {
    console.error('aiLiveNote error:', e)
    const latest = String(latestChunk || '').trim()
    if (latest.length >= 12) {
      return `مداخلة المستشار الذكي: سمعت إجابتك، لكن أحتاج منك أن تربط كلامك مباشرة بعنوان البحث ومنهجيته. وضّح لي الآن: ما الدليل أو المثال العملي الذي يثبت هذه النقطة؟`
    }
    return null
  }
}

// ===== 12.3: محضر تلقائي للجلسة وتلخيص أهم النقاط والقرارات =====
async function aiMinutes(thesisId: string, title: string, studentName: string, defenseDate: Date | null, studentAcademicContext?: string): Promise<string> {
  try {
    const all = await db.defenseMessage.findMany({ where: { thesisId }, orderBy: { createdAt: 'asc' } })
    const dialog = all
      .filter((m) => m.role !== 'SYSTEM')
      .map((m) => {
        const who = m.role === 'AI_EXPERT' ? 'اللجنة/الخبير' : m.role === 'STUDENT' ? 'الطالب' : m.role === 'TRANSCRIPT' ? 'الطالب (تفريغ)' : 'ملاحظة المستشار الذكي'
        return `${who}: ${m.content.slice(0, 350)}${m.score != null ? ` [تقييم: ${m.score}/10]` : ''}`
      })
      .join('\n')

    const text = await textAiComplete({
      system: 'أنت كاتب محاضر أكاديمي محترف. تصوغ محضر جلسة مناقشة بحث تخرج بصيغة رسمية موجزة بالعربية. بدون Markdown أو جداول.',
      history: [{
        role: 'user',
        text: `${studentAcademicContext ? `${studentAcademicContext.slice(0, 5500)}\n\n` : ''}صُغ محضر جلسة مناقشة بحث التخرج التالي:
عنوان البحث: «${title}»
الباحث: ${studentName}
تاريخ الجلسة: ${defenseDate ? new Date(defenseDate).toLocaleDateString('ar-EG') : 'الجلسة الحالية'}
الحاضرون: الطالب + أعضاء لجنة المناقشة متصلون من مواقع مختلفة + عضو الوكيل الدولي (إن وجد) + المستشار الذكي

سجل الجلسة:
${dialog.slice(0, 8000)}

صيغة المحضر:
محضر جلسة مناقشة بحث التخرج
1) الحضور والافتتاح
2) أهم الأسئلة المطروحة والإجابات المحورية (مختصراً)
3) ملاحظات المستشار الذكي التحليلية
4) أبرز نقاط القوة والضعف
5) القرار: القرار النهائي يُصدر من أعضاء اللجنة البشرية وتُعتمد النتيجة من الإدارة
اجعله في حدود 12 سطراً.`,
      }],
      temperature: 0.3,
      maxOutputTokens: 900,
      taskLevel: 'ACADEMIC_CRITICAL',
    })
    const minutes = text.trim()
    if (minutes.length <= 60) throw new Error('DEFENSE_MINUTES_TOO_SHORT')
    return minutes.slice(0, 4000)
  } catch (e) {
    console.error('aiMinutes error:', e)
    return `تعذر توليد محضر آلي موثوق لجلسة «${title}» — الباحث: ${studentName}. يجب إعداد المحضر من سجل الجلسة والتسجيل واعتماده من اللجنة البشرية.`
  }
}
