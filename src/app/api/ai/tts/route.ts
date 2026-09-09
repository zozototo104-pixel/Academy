import { NextRequest, NextResponse } from 'next/server'
import { getZAI } from '@/lib/ai'
import { requireUser } from '@/lib/auth'
import {
  ensureGeminiKey,
  geminiTTSWav,
  isAuthError,
  isInvalidArgumentError,
  isModelUnavailableError,
  isQuotaError,
} from '@/lib/gemini'

export const runtime = 'nodejs'
export const maxDuration = 60

// POST /api/ai/tts — تحويل نص المشرف الذكي إلى صوت (لمستخدمي المنصة فقط)
export async function POST(req: NextRequest) {
  try {
    const user = await requireUser()
    if (!user) {
      return NextResponse.json({ error: 'يجب تسجيل الدخول' }, { status: 401 })
    }

    const { text, speed } = await req.json()
    const cleanText = String(text || '').trim()
    if (!cleanText) {
      return NextResponse.json({ error: 'النص مطلوب' }, { status: 400 })
    }
    if (cleanText.length > 8000) {
      return NextResponse.json({ error: 'النص أطول من الحد المسموح' }, { status: 400 })
    }

    // بعد تحويل المنصة إلى Gemini: نستخدم Gemini TTS أولاً، ثم ZAI فقط كاحتياط.
    const geminiReady = await ensureGeminiKey().catch(() => false)
    if (geminiReady) {
      try {
        const wav = await geminiTTSWav(cleanText, { speed: Number(speed) || 1.0 })
        return audioResponse(wav)
      } catch (e: any) {
        const msg = String(e?.message || e || '')
        console.error('Gemini TTS error:', msg.slice(0, 500))
        if (isQuotaError(e)) {
          return NextResponse.json({ error: 'انتهت حصة Gemini الصوتية مؤقتاً. جرّب لاحقاً أو فعّل Billing.' }, { status: 429 })
        }
        if (isAuthError(e)) {
          return NextResponse.json({ error: 'مفتاح Gemini غير صالح للصوت أو لا يملك الصلاحية المطلوبة.' }, { status: 401 })
        }
        // أخطاء النموذج نتركها تنزل إلى ZAI كاحتياط؛ لو فشل الاحتياط نرجع رسالة واضحة.
        if (!isModelUnavailableError(e) && !isInvalidArgumentError(e)) {
          // نكمل إلى الاحتياط أيضاً لأن بعض أخطاء الشبكة مؤقتة.
        }
      }
    }

    try {
      const chunks = splitText(cleanText, 950)
      const audioParts: Buffer[] = []
      const zai = await getZAI()

      for (const chunk of chunks.slice(0, 8)) {
        const response = await zai.audio.tts.create({
          input: chunk,
          voice: 'tongtong',
          speed: Math.min(2, Math.max(0.5, Number(speed) || 1.0)),
          response_format: 'wav',
          stream: false,
        })
        const arrayBuffer = await response.arrayBuffer()
        audioParts.push(Buffer.from(new Uint8Array(arrayBuffer)))
      }

      const combined = audioParts.length === 1 ? audioParts[0] : mergeWav(audioParts)
      if (!combined?.length) throw new Error('EMPTY_TTS_AUDIO')
      return audioResponse(combined)
    } catch (e: any) {
      console.error('Fallback ZAI TTS error:', String(e?.message || e).slice(0, 500))
      return NextResponse.json({ error: 'تعذر توليد الصوت حالياً. النص ظاهر ويمكنك الضغط على زر السماعة للمحاولة مرة أخرى.' }, { status: 502 })
    }
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'يجب تسجيل الدخول' }, { status: 401 })
    }
    console.error('TTS route error:', e)
    return NextResponse.json({ error: 'تعذر توليد الصوت' }, { status: 500 })
  }
}

function audioResponse(buf: Buffer): NextResponse {
  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      'Content-Type': 'audio/wav',
      'Content-Length': String(buf.length),
      'Cache-Control': 'no-store',
      'Accept-Ranges': 'bytes',
    },
  })
}

function splitText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text]
  const sentences = text.split(/(?<=[.!؟?])\s+/)
  const chunks: string[] = []
  let current = ''
  for (const s of sentences) {
    if ((current + ' ' + s).trim().length <= maxLen) {
      current = (current + ' ' + s).trim()
    } else {
      if (current) chunks.push(current)
      if (s.length <= maxLen) {
        current = s
      } else {
        let rest = s
        while (rest.length > maxLen) {
          let cut = rest.lastIndexOf('،', maxLen)
          if (cut < maxLen * 0.5) cut = rest.lastIndexOf(' ', maxLen)
          if (cut < maxLen * 0.5) cut = maxLen
          chunks.push(rest.slice(0, cut).trim())
          rest = rest.slice(cut).trim()
        }
        current = rest
      }
    }
  }
  if (current) chunks.push(current)
  return chunks
}

// إيجاد بداية chunk البيانات «data» فعلياً بقراءة الترويسة (يدعم الترويسات الموسعة LIST/fact)
function findDataStart(buf: Buffer): number {
  let pos = 12 // RIFF....WAVE
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4)
    const size = buf.readUInt32LE(pos + 4)
    if (id === 'data') return pos + 8
    pos += 8 + size + (size % 2)
  }
  return 44
}

function mergeWav(parts: Buffer[]): Buffer {
  if (parts.length === 0) return Buffer.alloc(0)
  const first = parts[0]
  const header = first.subarray(0, 44)
  const buffers = parts.map((p) => p.subarray(findDataStart(p)))
  const dataSize = buffers.reduce((s, b) => s + b.length, 0)
  const newHeader = Buffer.from(header)
  newHeader.writeUInt32LE(36 + dataSize, 4)
  newHeader.writeUInt32LE(dataSize, 40)
  return Buffer.concat([newHeader, ...buffers])
}
