import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { enforceApiRateLimit } from '@/lib/rate-limit'
import { platformAgentComplete, platformAgentStream } from '@/lib/platform-agent'
import {
  createHumanHandoffRequest,
  hadRecentHumanSupportPrompt,
  hasRecentHumanHandoffRequest,
  HUMAN_HANDOFF_CONFIRMATION_REPLY,
  HUMAN_SUPPORT_REPLY,
  looksLikeHumanHandoffDetails,
  wantsHumanSupport,
  withHumanHandoffActiveNote,
} from '@/lib/human-handoff'
import { requireStudentAiSupervisorAccess } from '@/lib/student-ai-access'
import { updateStudentAcademicMemory } from '@/lib/supervisor-ai'

// GET /api/chat — سجل المحادثة (نصي وصوتي مع النسخ المفرّغ)
export async function GET() {
  try {
    const user = await requireUser()
    await requireStudentAiSupervisorAccess(user)
    const messages = await db.chatMessage.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'asc' },
      take: 150,
    })
    return NextResponse.json({ messages })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'يجب تسجيل الدخول أولاً' }, { status: 401 })
    }
    if (String(e?.message || '').includes('AI_SUPERVISOR_LOCKED')) {
      return NextResponse.json({ error: e?.reason || 'المشرف الذكي غير مفعل لهذا الطالب بعد.' }, { status: e?.status || 403 })
    }
    return NextResponse.json({ error: 'خطأ في تحميل المحادثة' }, { status: 500 })
  }
}

// POST /api/chat — محادثة مع المشرف الذكي (نصية أو صوتية مع نسخة مفرّغة)
export async function POST(req: NextRequest) {
  try {
    const user = await requireUser()
    await requireStudentAiSupervisorAccess(user)
    const limited = enforceApiRateLimit(req, 'chat', 12, 60 * 1000, user.id)
    if (limited) return limited
    const { message, context, mode, stream } = await req.json()
    if (!message?.trim()) {
      return NextResponse.json({ error: 'الرسالة فارغة' }, { status: 400 })
    }

    // وكيل المنصة المتكامل: يختار الشخصية المناسبة، ويجعل المشرف الذكي جزءاً من العقل العام.
    const chatMode = mode === 'VOICE' ? 'VOICE' : 'TEXT'

    // حفظ رسالة الطالب (نصية أو نسخة صوتية مفرّغة)
    await db.chatMessage.create({
      data: {
        userId: user.id,
        role: 'user',
        content: message.trim().slice(0, 4000),
        mode: chatMode,
      },
    })

    // جلب آخر 20 رسالة للسياق
    const history = await db.chatMessage.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      take: 21,
    })
    const ordered = history.reverse().slice(0, -1) // استبعاد الرسالة الحالية (مضافة سابقاً)
    const orderedMessages = ordered.map((m) => ({ role: m.role, content: m.content }))
    const userText = message.trim()
    const handoffPromptActive = hadRecentHumanSupportPrompt(orderedMessages)

    let reply = ''
    let agentResult: { agent: any; engine: any } = { agent: 'SUPPORT', engine: 'LOCAL_RULE' }

    if (handoffPromptActive && looksLikeHumanHandoffDetails(userText)) {
      await createHumanHandoffRequest({
        user: { id: user.id, name: user.name, email: user.email, phone: user.phone, role: user.role },
        message: userText,
        source: 'CHAT',
        sourceRef: user.id,
      })
      reply = HUMAN_HANDOFF_CONFIRMATION_REPLY
    } else if (wantsHumanSupport(userText)) {
      reply = HUMAN_SUPPORT_REPLY
    } else {
      const result = await platformAgentComplete({
        userId: user.id,
        messages: [...orderedMessages, { role: 'user', content: userText }],
        uiContext: context,
        mode: chatMode,
      })
      const hasSubmittedHandoff = await hasRecentHumanHandoffRequest(user.id)
      agentResult = result
      reply = (handoffPromptActive || hasSubmittedHandoff) ? withHumanHandoffActiveNote(result.reply) : result.reply
    }

    // حفظ رد الوكيل/المشرف
    const saved = await db.chatMessage.create({
      data: { userId: user.id, role: 'assistant', content: reply, mode: chatMode },
    })

    await updateStudentAcademicMemory(user.id, {
      kind: 'CHAT',
      persona: agentResult.agent === 'EXAMS' ? 'EXAM' : agentResult.agent === 'THESIS_DEFENSE' ? 'DEFENSE' : 'CHAT',
      mode: chatMode,
      userMessage: message.trim(),
      assistantReply: reply,
    }).catch(() => {})

    return NextResponse.json({ reply, messageId: saved.id, agent: agentResult.agent, engine: agentResult.engine })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'يجب تسجيل الدخول أولاً' }, { status: 401 })
    }
    console.error('Chat error:', e)
    const message = String(e?.message || '')
    if (message.includes('AI_SUPERVISOR_LOCKED')) {
      return NextResponse.json({ error: e?.reason || 'المشرف الذكي غير مفعل لهذا الطالب بعد.' }, { status: e?.status || 403 })
    }
    if (message.includes('EMPTY_AI_RESPONSE') || message.includes('AI_PROVIDER_UNAVAILABLE')) {
      return NextResponse.json({ error: 'تعذر توليد إجابة أكاديمية الآن بسبب فشل مزوّد الذكاء. أعد المحاولة بعد قليل.' }, { status: 502 })
    }
    return NextResponse.json({ error: 'خطأ في المحادثة — أعد المحاولة' }, { status: 500 })
  }
}

// DELETE /api/chat — مسح المحادثة
export async function DELETE() {
  try {
    const user = await requireUser()
    await db.chatMessage.deleteMany({ where: { userId: user.id } })
    return NextResponse.json({ ok: true })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'يجب تسجيل الدخول أولاً' }, { status: 401 })
    }
    return NextResponse.json({ error: 'خطأ في المسح' }, { status: 500 })
  }
}
