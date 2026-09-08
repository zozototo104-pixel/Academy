import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { chatComplete } from '@/lib/ai'
import { buildSupervisorContext, mergeContext } from '@/lib/supervisor-ai'

// GET /api/chat — سجل المحادثة (نصي وصوتي مع النسخ المفرّغ)
export async function GET() {
  try {
    const user = await requireUser()
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
    return NextResponse.json({ error: 'خطأ في تحميل المحادثة' }, { status: 500 })
  }
}

// POST /api/chat — محادثة مع المشرف الذكي (نصية أو صوتية مع نسخة مفرّغة)
export async function POST(req: NextRequest) {
  try {
    const user = await requireUser()
    const { message, context, mode } = await req.json()
    if (!message?.trim()) {
      return NextResponse.json({ error: 'الرسالة فارغة' }, { status: 400 })
    }

    // 12.1: قاعدة معرفة التخصص (RAG) — ملف الطالب + منهجه + كتبه المعتمدة + تقدمه ومواعيده
    const ragContext = await buildSupervisorContext(user.id)
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

    const reply = await chatComplete(
      [...ordered.map((m) => ({ role: m.role, content: m.content })), { role: 'user', content: message.trim() }],
      mergeContext(ragContext, context)
    )

    // حفظ رد المشرف
    const saved = await db.chatMessage.create({
      data: { userId: user.id, role: 'assistant', content: reply, mode: chatMode },
    })

    return NextResponse.json({ reply, messageId: saved.id })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'يجب تسجيل الدخول أولاً' }, { status: 401 })
    }
    console.error('Chat error:', e)
    if (String(e?.message).includes('EMPTY_AI_RESPONSE')) {
      return NextResponse.json({ error: 'المشرف الذكي لم يتمكن من الرد — أعد المحاولة' }, { status: 502 })
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
