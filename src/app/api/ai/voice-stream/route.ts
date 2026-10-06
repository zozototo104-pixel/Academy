import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { getZAI } from '@/lib/ai'
import { buildScopedDirectProgramBooksResult } from '@/lib/ai-context-builder'
import { resolveAiKnowledgeScope, type AiKnowledgeScope } from '@/lib/ai-knowledge-policy'
import { buildSupervisorContext, mergeContext } from '@/lib/supervisor-ai'
import { buildVoiceSystemPrompt, buildInterruptNote } from '@/lib/voicePrompt'
import { AI_RATE_LIMITS, enforceUserAiRateLimit } from '@/lib/ai-rate-limits'

export const runtime = 'nodejs'
export const maxDuration = 120

async function auditVoiceKnowledgeDiagnostics(args: {
  userId: string
  role?: string | null
  scope: AiKnowledgeScope
  diagnostics: any
}) {
  await db.auditLog.create({
    data: {
      actorId: args.userId,
      actorName: args.role === 'ADMIN' ? 'إدارة النظام' : args.role === 'SUPERVISOR' ? 'مشرف بشري' : 'مشرف ذكي للطالب',
      action: 'AI_KNOWLEDGE_DIAGNOSTICS',
      entity: 'AIKnowledge',
      entityId: args.userId,
      details: JSON.stringify({ ...args.diagnostics, role: args.role || null, scope: args.scope, mode: 'VOICE_STREAM' }).slice(0, 3900),
    },
  }).catch(() => {})
}

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
  const limited = enforceUserAiRateLimit(req, AI_RATE_LIMITS.voiceStream, user.id)
  if (limited) return limited

  let body: { message?: string; interruptNote?: string } = {}
  try {
    body = await req.json()
  } catch (error) {
    console.warn('Failed to parse voice stream request body JSON.', error)
  }
  const message = (body.message || '').trim()
  const interruptNote = (body.interruptNote || '').trim()
  if (!message) {
    return new Response(JSON.stringify({ error: 'الرسالة فارغة' }), { status: 400 })
  }
  if (message.length > 2500) {
    return new Response(JSON.stringify({ error: 'الرسالة أطول من الحد المسموح' }), { status: 413 })
  }

  // سياق RAG: ملف المستخدم + المنهج/الكتب حسب نطاق الصلاحية الحالي.
  const voiceScope = resolveAiKnowledgeScope({ role: user.role, mode: 'VOICE' })
  const diagnosticResult = await buildScopedDirectProgramBooksResult(message, voiceScope).catch((error) => {
    console.warn('Failed to build voice stream program book diagnostics.', error)
    return null
  })
  if (diagnosticResult?.diagnostics && diagnosticResult.diagnostics.reason !== 'query_not_program_books') {
    await auditVoiceKnowledgeDiagnostics({ userId: user.id, role: user.role, scope: voiceScope, diagnostics: diagnosticResult.diagnostics })
  }
  const ragContext = await buildSupervisorContext(user.id, { scope: voiceScope, query: message })
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
