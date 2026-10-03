import { GoogleGenAI } from '@google/genai'
import { getZAI } from '@/lib/ai'

type TranscribeAudioOptions = {
  mimeType?: string | null
  languageCode?: string | null
}

function cleanBase64AndMime(audioBase64: string, mimeType?: string | null) {
  const raw = String(audioBase64 || '').trim()
  const dataUrlMatch = raw.match(/^data:([^;]+);base64,(.+)$/i)
  const detectedMime = dataUrlMatch?.[1] || mimeType || ''
  const clean = dataUrlMatch?.[2] || raw
  return { clean, mimeType: normalizeAudioMimeType(detectedMime) }
}

function normalizeAudioMimeType(value?: string | null) {
  const raw = String(value || '').trim().toLowerCase()
  const base = raw.split(';')[0]?.trim() || ''
  if (base) return base
  return 'audio/webm'
}

function geminiApiKey() {
  return String(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim()
}

async function transcribeWithGemini(audioBase64: string, options: TranscribeAudioOptions = {}) {
  const apiKey = geminiApiKey()
  if (!apiKey) return null

  const { clean, mimeType } = cleanBase64AndMime(audioBase64, options.mimeType)
  if (!clean) return ''

  const ai = new GoogleGenAI({ apiKey })
  const response = await ai.models.generateContent({
    model: process.env.GEMINI_ASR_MODEL || 'gemini-3.5-transcribe',
    contents: [
      {
        text: [
          'حوّل الكلام في هذا الملف الصوتي إلى نص فقط.',
          'لا تضف شرحاً ولا تلخيصاً ولا علامات اقتباس.',
          'إذا كان الكلام عربياً فاكتبه بالعربية كما سمعته.',
          options.languageCode ? `لغة متوقعة: ${options.languageCode}` : '',
        ].filter(Boolean).join('\n'),
      },
      {
        inlineData: {
          mimeType,
          data: clean,
        },
      },
    ],
  } as any)

  return String((response as any)?.text || '').trim()
}

async function transcribeWithZai(audioBase64: string) {
  const { clean } = cleanBase64AndMime(audioBase64)
  if (!clean) return ''
  const zai = await getZAI()
  const response = await zai.audio.asr.create({ file_base64: clean })
  return String(response?.text || '').trim()
}

export async function transcribeAudioBase64(audioBase64: string, options: TranscribeAudioOptions = {}) {
  const { clean } = cleanBase64AndMime(audioBase64, options.mimeType)
  if (!clean) return ''

  try {
    const geminiText = await transcribeWithGemini(clean, options)
    if (geminiText !== null) return geminiText
  } catch (error) {
    console.warn('Gemini ASR failed, falling back to ZAI:', String(error).slice(0, 300))
  }

  return transcribeWithZai(clean)
}
