import { NextRequest } from 'next/server'
import { requireUser } from '@/lib/auth'
import { getZAI } from '@/lib/ai'

export const runtime = 'nodejs'
export const maxDuration = 60

/**
 * POST /api/ai/tts-stream — بث توليد الصوت قطعة-قطعة (SSE)
 * يمرر دلتات base64 WAV من محرك glm-tts مباشرة للمتصفح ليبدأ التشغيل
 * قبل اكتمال التوليد — أول صوت يصل خلال أقل من ثانية.
 *
 * الأحداث:
 *   data: {"type":"audio","b64":"<base64 wav chunk>"}
 *   data: {"type":"done"}
 *   data: {"type":"error","error":"..."}
 */
export async function POST(req: NextRequest) {
  const user = await requireUser().catch(() => null)
  if (!user) {
    return new Response(JSON.stringify({ error: 'يجب تسجيل الدخول' }), { status: 401 })
  }

  let body: { text?: string; speed?: number } = {}
  try {
    body = await req.json()
  } catch {}
  const text = (body.text || '').trim()
  const speed = Math.min(1.3, Math.max(0.8, Number(body.speed) || 1.0))
  if (!text) {
    return new Response(JSON.stringify({ error: 'النص مطلوب' }), { status: 400 })
  }
  if (text.length > 1200) {
    return new Response(JSON.stringify({ error: 'المقطع أطول من الحد' }), { status: 400 })
  }

  const encoder = new TextEncoder()
  const sse = (obj: any) => encoder.encode(`data: ${JSON.stringify(obj)}\n\n`)

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const zai = await getZAI()
        const upstream: any = await zai.audio.tts.create({
          input: text,
          voice: 'tongtong',
          speed,
          response_format: 'wav',
          stream: true,
        })
        if (!upstream?.body || typeof upstream.body.getReader !== 'function') {
          throw new Error('NO_TTS_STREAM')
        }
        const reader = upstream.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          const lines = buf.split('\n')
          buf = lines.pop() || ''
          for (const line of lines) {
            const t = line.trim()
            if (!t.startsWith('data:')) continue
            const payload = t.slice(5).trim()
            if (!payload || payload === '[DONE]') continue
            try {
              const json = JSON.parse(payload)
              const b64 = json?.choices?.[0]?.delta?.content
              if (b64) controller.enqueue(sse({ type: 'audio', b64 }))
            } catch {}
          }
        }
        controller.enqueue(sse({ type: 'done' }))
      } catch (e: any) {
        console.error('tts-stream error:', e?.message?.slice(0, 160))
        try { controller.enqueue(sse({ type: 'error', error: 'فشل توليد الصوت' })) } catch {}
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
