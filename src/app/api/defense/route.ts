import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { getZAI } from '@/lib/ai'
import { notify, audit } from '@/lib/notify'
import { buildSupervisorContext, mergeContext } from '@/lib/supervisor-ai'

const QUESTIONS_COUNT = 5 // عدد أسئلة اللجنة

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
    const { action, text, dataUrl, mime, durationSec } = await req.json()

    const thesis = await db.thesisSubmission.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
    })
    if (!thesis) return NextResponse.json({ error: 'لا يوجد بحث تخرج بعد' }, { status: 404 })
    if (thesis.status !== 'SCHEDULED') {
      return NextResponse.json({ error: 'مناقشتك غير مجدولة' }, { status: 400 })
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
      const opening = await aiOpening(thesis.title, thesis.abstract)
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

      const result = await aiEvaluate(thesis.title, thesis.abstract, lastQuestion?.content || '', answer, answeredCount + 1, QUESTIONS_COUNT)

      await db.defenseMessage.create({
        data: { thesisId: thesis.id, role: 'STUDENT', content: answer, score: result.score },
      })

      if (answeredCount + 1 >= QUESTIONS_COUNT) {
        // آخر إجابة → ختام الجلسة والتوصية والمحضر التلقائي
        const scores = [...history.filter((m) => m.role === 'STUDENT').map((m) => m.score || 0), result.score]
        const avg = scores.reduce((s, x) => s + x, 0) / scores.length
        const aiScore = Math.round(avg * 10) // من 100
        const rec = await aiRecommendation(thesis.title, user.name, aiScore, scores.length, result.feedback)
        const minutes = await aiMinutes(thesis.id, thesis.title, user.name, thesis.defenseDate)
        await db.thesisSubmission.update({
          where: { id: thesis.id },
          data: {
            defenseStatus: 'COMPLETED',
            aiScore,
            aiRecommendation: rec,
            defenseMinutes: minutes,
            defenseCompletedAt: new Date(),
          },
        })
        await db.defenseMessage.create({
          data: { thesisId: thesis.id, role: 'AI_EXPERT', content: `شكراً لك. انتهت أسئلة اللجنة.\n\n${result.feedback}\n\n${rec}` },
        })
        await notify(
          user.id,
          'DEFENSE',
          'انتهت جلسة المناقشة',
          `أنهيت أسئلة اللجنة عبر الفيديو كونفرنس — تقييم خبير الذكاء الاصطناعي: ${aiScore}/100. تُعرض توصية خبير الذكاء على اللجنة لاعتماد النتيجة النهائية.`,
          'dashboard'
        )
        await audit({ id: user.id, name: user.name }, 'COMPLETE_DEFENSE', 'ThesisSubmission', thesis.id, `تقييم AI: ${aiScore}/100`)
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
      const scores = studentMsgs.map((m) => m.score || 0)
      const aiScore = scores.length ? Math.round((scores.reduce((s, x) => s + x, 0) / scores.length) * 10) : 0
      const rec = await aiRecommendation(thesis.title, user.name, aiScore, scores.length, 'جلسة مبتورة — أنهى الطالب الجلسة مبكراً.')
      const minutes = await aiMinutes(thesis.id, thesis.title, user.name, thesis.defenseDate)
      await db.thesisSubmission.update({
        where: { id: thesis.id },
        data: { defenseStatus: 'COMPLETED', aiScore, aiRecommendation: rec, defenseMinutes: minutes, defenseCompletedAt: new Date() },
      })
      await db.defenseMessage.create({
        data: { thesisId: thesis.id, role: 'SYSTEM', content: `أنهى الطالب الجلسة — تقييم على الأسئلة المجاب عنها: ${aiScore}/100 — تم توليد محضر الجلسة وأرشفته في ملف البحث` },
      })
      await notify(user.id, 'DEFENSE', 'أنهيت جلسة المناقشة', `تقييم أولي ${aiScore}/100 — محضر الجلسة تولّد تلقائياً وأُرشف في ملف بحثك مع تسجيل الجلسة.`, 'dashboard')
      const messages = await db.defenseMessage.findMany({ where: { thesisId: thesis.id }, orderBy: { createdAt: 'asc' } })
      return NextResponse.json({ ok: true, messages, completed: true, aiScore, aiRecommendation: rec, minutes })
    }

    // ===== 12.3: تفريغ صوتي حي (Live Transcription) =====
    if (action === 'transcript') {
      if (thesis.defenseStatus !== 'IN_PROGRESS') {
        return NextResponse.json({ error: 'ابدأ جلسة المناقشة أولاً' }, { status: 400 })
      }
      const transcriptText = String(text || '').trim()
      if (!transcriptText) return NextResponse.json({ error: 'نص التفريغ فارغ' }, { status: 400 })
      await db.defenseMessage.create({
        data: { thesisId: thesis.id, role: 'TRANSCRIPT', content: transcriptText.slice(0, 3000) },
      })
      return NextResponse.json({ ok: true })
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

    // ===== 12.3: أرشفة تسجيل الجلسة (فيديو + صوت) في ملف الطالب =====
    if (action === 'save-recording') {
      if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
        return NextResponse.json({ error: 'بيانات التسجيل غير صالحة' }, { status: 400 })
      }
      const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
      const size = Math.round((base64.length * 3) / 4)
      if (size > 24 * 1024 * 1024) {
        return NextResponse.json({ error: 'حجم التسجيل يتجاوز 24 ميجابايت — لن تُأرشفع (جلسة طويلة جداً)' }, { status: 413 })
      }
      await db.thesisSubmission.update({
        where: { id: thesis.id },
        data: {
          recordingData: base64,
          recordingMime: String(mime || 'video/webm').slice(0, 60),
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

async function aiOpening(title: string, abstract: string): Promise<string> {
  try {
    const zai = await getZAI()
    const completion = await zai.chat.completions.create({
      messages: [
        { role: 'assistant', content: 'أنت خبير ذكاء اصطناعي عضو لجنة مناقشة أكاديمية محترفة تتحدث العربية الفصحى.' },
        {
          role: 'user',
          content: `افتتح جلسة مناقشة بحث التخرج بعنوان «${title}» بجملة ترحيب رسمية قصيرة، ثم اطرح السؤال الأول (من أصل ${QUESTIONS_COUNT}).
السؤال الأول يجب أن يكون عن دوافع اختيار الموضوع وأهميته العملية.
ملخص البحث: ${abstract.slice(0, 1200)}

اكتب: ترحيب من سطرين + "السؤال الأول:" ثم السؤال. بدون أي تنسيق Markdown.`,
        },
      ],
      thinking: { type: 'disabled' },
    })
    return (completion.choices[0]?.message?.content || '').trim() || defaultQuestion(1)
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
  total: number
): Promise<{ score: number; feedback: string; nextQuestion: string }> {
  try {
    const zai = await getZAI()
    const completion = await zai.chat.completions.create({
      messages: [
        { role: 'assistant', content: 'أنت خبير ذكاء اصطناعي عضو لجنة مناقشة أكاديمية، تقيّم إجابات الطلاب بموضوعية وتطرح الأسئلة التالية. ترجع JSON فقط.' },
        {
          role: 'user',
          content: `بحث: «${title}»
الملخص: ${abstract.slice(0, 1000)}
السؤال المطروح: ${question}
إجابة الطالب: ${answer.slice(0, 2500)}
هذا السؤال رقم ${qNum} من ${total}.

قيّم الإجابة من 10 (الدقة العلمية، وضوح الفكرة، الربط بالبحث، العمق) ثم اطرح السؤال التالي المنطقي حسب تسلسل المناقشة (الأهمية ← المشكلة والمنهجية ← النتائج ← التطبيق ← الحدود والآفاق).

أجب بصيغة JSON فقط:
{"score": <0-10>, "feedback": "<تعليق قصير من سطرين على الإجابة>", "nextQuestion": "<السؤال التالي مسبوق بـ: السؤال ${qNum + 1}: >"}`,
        },
      ],
      thinking: { type: 'disabled' },
    })
    const raw = completion.choices[0]?.message?.content || ''
    const match = raw.match(/\{[\s\S]*\}/)
    if (!match) throw new Error('NO_JSON')
    const parsed = JSON.parse(match[0])
    return {
      score: Math.max(0, Math.min(10, Number(parsed.score) || 0)),
      feedback: String(parsed.feedback || '').slice(0, 800),
      nextQuestion: String(parsed.nextQuestion || defaultQuestion(qNum + 1)).slice(0, 1200),
    }
  } catch {
    // تقييم احتياطي موسوم بوضوح — لا درجة صامتة تضخم النتيجة
    return {
      score: 5,
      feedback: '(تقييم احتياطي — لم يتوفر نموذج الذكاء لحظة التقييم) تمت مراجعة إجابتك مبدئياً وسيحسم التقييم النهائي اعتماد لجنة المناقشة على تسجيل الجلسة والمحضر.',
      nextQuestion: defaultQuestion(qNum),
    }
  }
}

async function aiRecommendation(title: string, name: string, aiScore: number, answered: number, lastFeedback: string): Promise<string> {
  const verdict =
    aiScore >= 80
      ? 'توصية بالقبول والاجتياز'
      : aiScore >= 60
        ? 'توصية بالقبول مع ملاحظات'
        : 'توصية بمراجعة البحث وإعادة المناقشة'
  try {
    const zai = await getZAI()
    const completion = await zai.chat.completions.create({
      messages: [
        { role: 'assistant', content: 'أنت خبير ذكاء اصطناعي عضو لجنة مناقشة، تكتب توصية رسمية موجزة للجنة.' },
        {
          role: 'user',
          content: `اكتب توصية رسمية موجزة (3-4 جمل) للجنة المناقشة بشأن بحث الطالب/ة ${name} بعنوان «${title}»:
- التقييم العام عبر الأسئلة: ${aiScore}/100 (${answered} أسئلة)
- آخر ملاحظة: ${lastFeedback}
- الحكم العام: ${verdict}

ابدأ بعبارة «توصية خبير الذكاء الاصطناعي للجنة:». بدون Markdown.`,
        },
      ],
      thinking: { type: 'disabled' },
    })
    return (completion.choices[0]?.message?.content || `${verdict} — التقييم ${aiScore}/100`).trim().slice(0, 1500)
  } catch {
    return `توصية خبير الذكاء الاصطناعي للجنة: ${verdict} — التقييم العام عبر أسئلة المناقشة ${aiScore}/100.`
  }
}

// ===== 12.3: ملاحظة تحليلية حية من المستشار الذكي لأعضاء اللجنة =====
// تحليل إجابات الطالب لحظياً: تناقضات، جوانب لم تُناقَش بعد، اقتراح أسئلة إضافية للتعمق
async function aiLiveNote(title: string, abstract: string, thesisId: string, userId: string): Promise<string | null> {
  try {
    const history = await db.defenseMessage.findMany({
      where: { thesisId, role: { in: ['AI_EXPERT', 'STUDENT', 'TRANSCRIPT'] } },
      orderBy: { createdAt: 'desc' },
      take: 12,
    })
    const dialog = history
      .reverse()
      .map((m) => `${m.role === 'AI_EXPERT' ? 'سؤال اللجنة' : m.role === 'STUDENT' ? 'إجابة الطالب' : 'كلام الطالب (تفريغ)'}: ${m.content.slice(0, 500)}`)
      .join('\n')
    if (dialog.length < 80) return null

    const rag = await buildSupervisorContext(userId)
    const zai = await getZAI()
    const completion = await zai.chat.completions.create({
      messages: [
        { role: 'assistant', content: 'أنت المستشار الذكي (مشرف ذكاء اصطناعي) حاضر كعضو فعلي في لجنة مناقشة بحث التخرج. دورك استشاري/داعم فقط: تساعد أعضاء اللجنة البشرية بملاحظات تحليلية موجزة، والقرار النهائي يبقى بيد اللجنة البشرية. ترجع نصاً عربياً فقط بدون تنسيق.' },
        {
          role: 'user',
          content: `${rag ? mergeContext(rag) + '\n\n' : ''}بحث: «${title}» — الملخص: ${abstract.slice(0, 800)}

أحدث ما جرى في الجلسة (سؤال ← إجابة):
${dialog.slice(0, 4000)}

اكتب ملاحظة تحليلية موجزة (2-4 جمل) لأعضاء اللجنة تشمل ما ينطبق من التالي:
- تنبيه لتضارب أو تناقض بين إجابات الطالب (إن وُجد — مع اقتباسه)
- جانب مهم في البحث لم تُناقشه اللجنة بعد ويستحق سؤالاً
- اقتراح سؤال إضافي للتعمق في نقطة ضعفت إجابة الطالب فيها
- أو تعزيز إيجابي لنقطة قوة رصدتَها في الإجابات

ابدأ بكلمة «ملاحظة للمستشار الذكي للجنة:» وبدون أي تعداد نقطي مرقّم.`,
        },
      ],
      thinking: { type: 'disabled' },
    })
    const note = (completion.choices[0]?.message?.content || '').trim()
    return note && note.length > 30 ? note.slice(0, 1200) : null
  } catch (e) {
    console.error('aiLiveNote error:', e)
    return null
  }
}

// ===== 12.3: محضر تلقائي للجلسة وتلخيص أهم النقاط والقرارات =====
async function aiMinutes(thesisId: string, title: string, studentName: string, defenseDate: Date | null): Promise<string> {
  try {
    const all = await db.defenseMessage.findMany({ where: { thesisId }, orderBy: { createdAt: 'asc' } })
    const dialog = all
      .filter((m) => m.role !== 'SYSTEM')
      .map((m) => {
        const who = m.role === 'AI_EXPERT' ? 'اللجنة/الخبير' : m.role === 'STUDENT' ? 'الطالب' : m.role === 'TRANSCRIPT' ? 'الطالب (تفريغ)' : 'ملاحظة المستشار الذكي'
        return `${who}: ${m.content.slice(0, 350)}${m.score != null ? ` [تقييم: ${m.score}/10]` : ''}`
      })
      .join('\n')

    const zai = await getZAI()
    const completion = await zai.chat.completions.create({
      messages: [
        { role: 'assistant', content: 'أنت كاتب محاضر أكاديمي محترف. تصوغ محضر جلسة مناقشة بحث تخرج بصيغة رسمية موجزة بالعربية. بدون Markdown أو جداول.' },
        {
          role: 'user',
          content: `صُغ محضر جلسة مناقشة بحث التخرج التالي:
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
        },
      ],
      thinking: { type: 'disabled' },
    })
    const minutes = (completion.choices[0]?.message?.content || '').trim()
    return minutes.length > 60 ? minutes.slice(0, 4000) : `محضر جلسة مناقشة «${title}» — الباحث: ${studentName} — حضر الطالب وأعضاء اللجنة والمستشار الذكي، ونوقشت الأسئلة الموثقة في سجل الجلسة. القرار النهائي يصدر من أعضاء اللجنة البشرية وتُعتمد النتيجة من الإدارة.`
  } catch (e) {
    console.error('aiMinutes error:', e)
    return `محضر جلسة مناقشة «${title}» — الباحث: ${studentName} — نوقش البحث أمام لجنة متخصصة بحضور المستشار الذكي، والقرار النهائي يصدر من أعضاء اللجنة البشرية وتُعتمد النتيجة من الإدارة.`
  }
}
