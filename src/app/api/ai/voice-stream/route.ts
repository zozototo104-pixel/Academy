import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { getZAI } from '@/lib/ai'
import { buildSupervisorContext, mergeContext } from '@/lib/supervisor-ai'
import { buildVoiceSystemPrompt, buildInterruptNote } from '@/lib/voicePrompt'

export const runtime = 'nodejs'
export const maxDuration = 120

/**
 * POST /api/ai/voice-stream — بث رد الخبير الصوتي token-by-token (SSE)
 * الأحداث:
 *   data: {"type":"delta","text":"..."}
 *   data: {"type":"done","messageId":"...","full":"..."}
 *   data: {"type":"error","error":"..."}
 */
export async function POST(req: NextRequest) {
  const user = await requireUser().catch(() => null)
  if (!user) {
    return new Response(JSON.stringify({ error: 'يجب تسجيل الدخول' }), { status: 401 })
  }

  let body: { message?: string; interruptNote?: string } = {}
  try {
    body = await req.json()
  } catch {}
  const message = (body.message || '').trim()
  const interruptNote = (body.interruptNote || '').trim()
  if (!message) {
    return new Response(JSON.stringify({ error: 'الرسالة فارغة' }), { status: 400 })
  }

  // سياق RAG: ملف الطالب + منهجه + تقدمه (نفس مصدر الدردشة النصية)
  const ragContext = await buildSupervisorContext(user.id)
  const systemPrompt = buildVoiceSystemPrompt(mergeContext(ragContext))

  // حفظ رسالة الطالب فوراً — قاعدة البيانات مصدر الحقيقة لذاكرة الجلسة
  await db.chatMessage.create({
    data: { userId: user.id, role: 'user', content: message.slice(0, 4000), mode: 'VOICE' },
  })

  // آخر 20 رسالة كسياق حواري (استمرارية الجلسة عبر الأدوار)
  const history = await db.chatMessage.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
    take: 21,
  })
  const ordered = history.reverse().slice(0, -1)

  const llmMessages: { role: 'user' | 'assistant'; content: string }[] = [
    { role: 'assistant', content: systemPrompt },
    ...ordered.map((m) => ({
      role: (m.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
      content: m.content,
    })),
  ]
  // ملاحظة المقاطعة تسبق رسالة المستخدم حتى يتجاوب الخبير معها
  if (interruptNote) {
    llmMessages.push({ role: 'assistant', content: buildInterruptNote(interruptNote) })
  }
  llmMessages.push({ role: 'user', content: message })

  const encoder = new TextEncoder()
  const sse = (obj: any) => encoder.encode(`data: ${JSON.stringify(obj)}\n\n`)

  const stream = new ReadableStream({
    async start(controller) {
      let full = ''
      try {
        const zai = await getZAI()
        const upstream: any = await zai.chat.completions.create({
          messages: llmMessages,
          stream: true,
          thinking: { type: 'disabled' },
        })
        if (!upstream || typeof upstream.getReader !== 'function') {
          throw new Error('NO_STREAM')
        }
        const reader = upstream.getReader()
        const decoder = new TextDecoder()
        let sseBuf = ''
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          sseBuf += decoder.decode(value, { stream: true })
          const lines = sseBuf.split('\n')
          sseBuf = lines.pop() || ''
          for (const line of lines) {
            const t = line.trim()
            if (!t.startsWith('data:')) continue
            const payload = t.slice(5).trim()
            if (!payload || payload === '[DONE]') continue
            try {
              const json = JSON.parse(payload)
              const delta = json?.choices?.[0]?.delta?.content
              if (delta) {
                full += delta
                controller.enqueue(sse({ type: 'delta', text: delta }))
              }
            } catch {}
          }
        }
        if (!full.trim()) throw new Error('EMPTY_AI_RESPONSE')
        // حفظ الرد كاملاً — ذاكرة الجلسة
        const saved = await db.chatMessage.create({
          data: { userId: user.id, role: 'assistant', content: full, mode: 'VOICE' },
        })
        controller.enqueue(sse({ type: 'done', messageId: saved.id, full }))
      } catch (e: any) {
        console.error('voice-stream error:', e?.message?.slice(0, 200))
        controller.enqueue(sse({ type: 'error', error: 'تعذر توليد رد الخبير — أعد المحاولة' }))
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no',
    },
  })
}
