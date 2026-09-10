import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { updateStudentAcademicMemory } from '@/lib/supervisor-ai'

export const runtime = 'nodejs'
export const maxDuration = 30

export async function POST(req: NextRequest) {
  const user = await requireUser().catch(() => null)
  if (!user) {
    return NextResponse.json({ error: 'يجب تسجيل الدخول أولاً' }, { status: 401 })
  }

  let body: { userText?: string; aiText?: string; model?: string } = {}
  try {
    body = await req.json()
  } catch {}

  const userText = String(body.userText || '').replace(/\s+/g, ' ').trim()
  const aiText = String(body.aiText || '').replace(/\s+/g, ' ').trim()
  const model = String(body.model || '').trim()

  if (!userText && !aiText) {
    return NextResponse.json({ error: 'لا يوجد نص لحفظه' }, { status: 400 })
  }

  try {
    let userMessageId: string | null = null
    let assistantMessageId: string | null = null

    if (userText) {
      const savedUser = await db.chatMessage.create({
        data: {
          userId: user.id,
          role: 'user',
          content: userText.slice(0, 4000),
          mode: 'VOICE',
        },
      })
      userMessageId = savedUser.id
    }

    if (aiText) {
      void model // محفوظ للتشخيص المستقبلي دون تلويث نص المحادثة الظاهر للطالب
      const savedAssistant = await db.chatMessage.create({
        data: {
          userId: user.id,
          role: 'assistant',
          content: aiText.slice(0, 8000),
          mode: 'VOICE',
        },
      })
      assistantMessageId = savedAssistant.id
    }

    await updateStudentAcademicMemory(user.id, {
      kind: 'CHAT',
      persona: 'CHAT',
      mode: 'VOICE',
      userMessage: userText,
      assistantReply: aiText,
      summary: `جلسة صوتية مع المشرف الذكي: الطالب قال «${userText.slice(0, 280)}» — رد المشرف «${aiText.slice(0, 320)}»`,
    }).catch(() => {})

    return NextResponse.json({ ok: true, userMessageId, assistantMessageId })
  } catch (e: any) {
    console.error('gemini-live log error:', String(e?.message || e).slice(0, 300))
    return NextResponse.json({ error: 'تعذر حفظ تفريغ جلسة Gemini Live' }, { status: 500 })
  }
}
