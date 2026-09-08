import { NextRequest, NextResponse } from 'next/server'
import { getZAI } from '@/lib/ai'
import { requireUser } from '@/lib/auth'

// POST /api/ai/tts — تحويل نص المشرف الذكي إلى صوت (لمستخدمي المنصة فقط)
export async function POST(req: NextRequest) {
  try {
    const user = await requireUser()
    if (!user) {
      return NextResponse.json({ error: 'يجب تسجيل الدخول' }, { status: 401 })
    }
    const { text, speed } = await req.json()
    if (!text?.trim()) {
      return NextResponse.json({ error: 'النص مطلوب' }, { status: 400 })
    }
    if (text.length > 8000) {
      return NextResponse.json({ error: 'النص أطول من الحد المسموح' }, { status: 400 })
    }

    // تقسيم النص الطويل إلى أجزاء (حد 1024 حرف)
    const chunks = splitText(text.trim(), 950)
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

    // دمج ملفات WAV بسيط (لجزء واحد نعيده كما هو)
    const combined = audioParts.length === 1 ? audioParts[0] : mergeWav(audioParts)

    return new NextResponse(new Uint8Array(combined), {
      status: 200,
      headers: {
        'Content-Type': 'audio/wav',
        'Content-Length': String(combined.length),
        'Cache-Control': 'no-store',
      },
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'يجب تسجيل الدخول' }, { status: 401 })
    }
    console.error('TTS error:', e)
    return NextResponse.json({ error: 'تعذر توليد الصوت' }, { status: 500 })
  }
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
        // تقسيم الجملة الطويلة جداً عند الفواصل
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
    pos += 8 + size + (size % 2) // chunks زوجية الطول
  }
  return 44 // احتياطي قياسي
}

function mergeWav(parts: Buffer[]): Buffer {
  // استخراج PCM من كل WAV ودمجها مع ترويسة أول ملف
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
